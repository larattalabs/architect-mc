package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CoveredPolicy;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.LotFit;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.OverlapPolicy;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.Verdict;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 7b slice PL DevBridge hooks (docs/DEVBRIDGE.md "7b PL"): a site-bound placement through the public API (Sites.fitToSite,
 * Sites.check and Sites.place with a {@link SiteSpec} in its wire form, kit/schemas/site-spec.json), Remove with a covered policy (sites
 * and cell sites alike), a library reload, and the internal move and record ext (the binding). Server work only (the headless server
 * generates them too: devserver genHooks).
 */
public final class SlicePlDev {
	private SlicePlDev() {
	}

	public static void init() {
		DevBridge.register("dev.pl.fit", 120_000, "{blueprint, site: <SiteSpec wire>, owner?, mode?: instant} - (7b PL) Sites.fitToSite -> {origin, rotation, box, "
			+ "restoreBox, clean, refusals: [{reason, message}], notes}", (req, mc) -> {
				Fields f = Fields.of(req);
				String bp = f.nonBlank("blueprint");
				SiteSpec site = SiteSpec.fromWire(req.getAsJsonObject("site"));
				String owner = f.optStr("owner", null);
				Mode mode = Mode.valueOf(f.optStr("mode", "instant").toUpperCase(java.util.Locale.ROOT));
				return ServerTasks.callOnServer(s -> {
					LotFit fit = ArchitectApi.get().sites(s).fitToSite(bp, site, new FitOptions(FitOptions.CentreOn.ENTRANCE, null, false, s.overworld(), mode,
						false, null, owner));
					JsonObject o = verdict(fit.verdict());
					o.add("origin", pos(fit.origin()));
					o.addProperty("rotation", SiteFrame.rotationWire(fit.rotation()));
					o.add("box", box(fit.box()));
					o.add("fitBox", box(fit.box()));
					return o;
				});
			});
		DevBridge.register("dev.pl.place", 300_000, "{blueprint, site?: <SiteSpec wire>, origin?: [x,y,z] (default: the site's frame), rotation?: none, check?: false, "
			+ "overlap?: refuse|layer, owner?, force?, mode?: instant} - (7b PL) Sites.place (or Sites.check) with the site -> {placed, site, refusals, notes} "
			+ "or the verdict", (req, mc) -> {
				Fields f = Fields.of(req);
				String bp = f.nonBlank("blueprint");
				SiteSpec site = req.has("site") && req.get("site").isJsonObject() ? SiteSpec.fromWire(req.getAsJsonObject("site")) : null;
				BlockPos origin = req.has("origin") ? pos(req.getAsJsonArray("origin")) : site == null ? null : site.frame().origin();
				Rotation rot = req.has("rotation") ? SiteFrame.rotationOf(req.get("rotation").getAsString()) : site == null ? Rotation.NONE : site.frame().rotation();
				if (origin == null) {
					throw new DevBridge.DevException("origin or site needed");
				}
				boolean check = req.has("check") && req.get("check").getAsBoolean();
				OverlapPolicy overlap = "layer".equals(f.optStr("overlap", "refuse")) ? OverlapPolicy.LAYER : null;
				String owner = f.optStr("owner", null);
				boolean force = req.has("force") && req.get("force").getAsBoolean();
				Mode mode = Mode.valueOf(f.optStr("mode", "instant").toUpperCase(java.util.Locale.ROOT));
				return ServerTasks.callOnServer(s -> {
					PlaceRequest r = new PlaceRequest(bp, s.overworld(), origin, rot, mode, owner, new JsonObject(), force, null, overlap, null, null, site);
					var sites = ArchitectApi.get().sites(s);
					if (check) {
						return verdict(sites.check(r));
					}
					PlaceResult p = sites.place(r).join();
					JsonObject o = new JsonObject();
					o.addProperty("placed", p.placed());
					p.siteId().ifPresent(id -> o.addProperty("site", id));
					o.add("refusals", refusals(p.refusals()));
					JsonArray n = new JsonArray();
					p.notes().forEach(n::add);
					o.add("notes", n);
					return o;
				});
			});
		DevBridge.register("dev.pl.remove", 600_000, "{site, covered?: keep|cascade|refuse, requester?, force?} - (7b PL) Sites.remove (a site or a cell site) "
			+ "-> {removed, blockers, restored, kept, handedDown, cascaded}", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("site");
				CoveredPolicy covered = CoveredPolicy.valueOf(f.optStr("covered", "keep").toUpperCase(java.util.Locale.ROOT));
				String requester = f.optStr("requester", null);
				boolean force = req.has("force") && req.get("force").getAsBoolean();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().sites(s).remove(id, new RemoveOptions(force, requester, covered))).thenCompose(x -> x)
					.thenApply(SlicePlDev::removed);
			});
		DevBridge.register("dev.pl.terrain", 300_000, "{file: <a frozen volume, gzip ARVX (a kit site fixture's volume.bin)>, blocks?: {CLASS: block}} - (7b PL, TEST) "
			+ "builds the volume's land in the world (each cell its class's block: AIR air, ROCK stone, SOIL dirt, LOG oak_log, LEAVES persistent oak "
			+ "leaves; no neighbour updates, no journal) and freezes the file as this world's architect/volumes/<sha>.bin -> {sha, box, cells, written}", (req, mc) -> {
				java.nio.file.Path file = java.nio.file.Path.of(Fields.of(req).nonBlank("file"));
				java.util.Map<String, String> blocks = new java.util.HashMap<>(java.util.Map.of("AIR", "minecraft:air", "ROCK", "minecraft:stone", "SOIL",
					"minecraft:dirt", "LOG", "minecraft:oak_log[axis=y]", "LEAVES", "minecraft:oak_leaves[persistent=true]"));
				if (req.has("blocks")) {
					req.getAsJsonObject("blocks").entrySet().forEach(e -> blocks.put(e.getKey(), e.getValue().getAsString()));
				}
				return ServerTasks.callOnServer(s -> {
					try {
						byte[] gz = java.nio.file.Files.readAllBytes(file);
						byte[] raw = dev.larattalabs.architect.region.volume.Arvx.gunzip(gz);
						String sha = dev.larattalabs.architect.region.volume.Arvx.sha256(raw);
						dev.larattalabs.architect.region.volume.Arvx.Decoded d = dev.larattalabs.architect.region.volume.Arvx.decode(raw);
						var level = s.overworld();
						dev.larattalabs.architect.region.volume.VolumeSurvey.freeze(s.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT).resolve(
							dev.larattalabs.architect.region.volume.VolumeSurvey.STANDALONE_DIR).resolve(sha + ".bin"), gz, sha);
						var names = dev.larattalabs.architect.api.VoxelClass.values();
						java.util.Map<Integer, net.minecraft.world.level.block.state.BlockState> states = new java.util.HashMap<>();
						int[] b = d.box();
						long cells = 0;
						long written = 0;
						BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
						for (int x = b[0]; x <= b[3]; x++) {
							for (int z = b[2]; z <= b[5]; z++) {
								for (int y = b[1]; y <= b[4]; y++) {
									int c = d.classAt(x, y, z);
									cells++;
									String id = blocks.get(names[c].name());
									if (id == null) {
										throw new DevBridge.DevException("no block for class " + names[c] + " at " + x + "," + y + "," + z);
									}
									var st = states.computeIfAbsent(c, k -> blockState(level, id));
									if (level.setBlock(m.set(x, y, z), st, net.minecraft.world.level.block.Block.UPDATE_CLIENTS
										| net.minecraft.world.level.block.Block.UPDATE_KNOWN_SHAPE)) {
										written++;
									}
								}
							}
						}
						JsonObject o = new JsonObject();
						o.addProperty("sha", sha);
						JsonArray box = new JsonArray();
						for (int v : b) {
							box.add(v);
						}
						o.add("box", box);
						o.addProperty("cells", cells);
						o.addProperty("written", written);
						return o;
					} catch (java.io.IOException e) {
						throw new DevBridge.DevException("can't read " + file + ": " + e.getMessage());
					}
				});
			});
		DevBridge.register("dev.pl.reload", 60_000, "{} - (7b PL) reloads the library (designs written into architect/library) -> {entries}", (req, mc) ->
			ServerTasks.callOnServer(s -> {
				dev.larattalabs.architect.placement.Blueprints.reload(s);
				JsonObject o = new JsonObject();
				o.addProperty("entries", dev.larattalabs.architect.placement.Blueprints.all().size());
				return o;
			}));
		DevBridge.register("dev.pl.record", 30_000, "{site} - (7b PL) a placed site's record: {blueprint, box, restoreBox, ext, bound}", (req, mc) -> {
			String id = Fields.of(req).nonBlank("site");
			return ServerTasks.callOnServer(s -> {
				dev.larattalabs.architect.site.Site b = dev.larattalabs.architect.site.Sites.get(id);
				if (b == null) {
					throw new DevBridge.DevException("no site " + id);
				}
				JsonObject o = new JsonObject();
				o.addProperty("blueprint", b.blueprint());
				o.addProperty("box", dev.larattalabs.architect.placement.Anchors.str(b.box()));
				o.addProperty("restoreBox", dev.larattalabs.architect.placement.Anchors.str(b.restoreBox()));
				o.add("ext", b.ext().deepCopy());
				o.addProperty("bound", dev.larattalabs.architect.site.SiteFit.bound(b.ext()));
				return o;
			});
		});
		DevBridge.register("dev.pl.move", 120_000, "{site, by: [dx,dy,dz]} - (7b PL) the internal move (as the Library's Move) -> {moved} or {refused}", (req, mc) -> {
			String id = Fields.of(req).nonBlank("site");
			JsonArray by = req.getAsJsonArray("by");
			return ServerTasks.callOnServer(s -> {
				dev.larattalabs.architect.site.Site b = dev.larattalabs.architect.site.Sites.get(id);
				JsonObject o = new JsonObject();
				try {
					dev.larattalabs.architect.site.Sites.move(s.overworld(), id, new BlockPos(b.box().minX() + by.get(0).getAsInt(), b.box().minY() + by.get(1)
						.getAsInt(), b.box().minZ() + by.get(2).getAsInt()), Rotation.values()[dev.larattalabs.architect.placement.BlueprintTransform.parseTurns(
							b.rotation())], false);
					o.addProperty("moved", true);
				} catch (dev.larattalabs.architect.site.Sites.SiteException e) {
					o.addProperty("moved", false);
					o.addProperty("refused", e.reason() + ": " + e.getMessage());
				}
				return o;
			});
		});
	}

	static net.minecraft.world.level.block.state.BlockState blockState(net.minecraft.server.level.ServerLevel level, String id) {
		try {
			return net.minecraft.commands.arguments.blocks.BlockStateParser.parseForBlock(level.holderLookup(net.minecraft.core.registries.Registries.BLOCK),
				id, false).blockState();
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException e) {
			throw new DevBridge.DevException("bad block " + id + ": " + e.getMessage());
		}
	}

	static JsonObject removed(RemoveResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("removed", r.removed());
		JsonArray b = new JsonArray();
		r.blockers().forEach(b::add);
		o.add("blockers", b);
		o.addProperty("restored", r.restored());
		o.addProperty("kept", r.kept());
		JsonObject h = new JsonObject();
		r.handedDown().forEach(h::addProperty);
		o.add("handedDown", h);
		JsonArray c = new JsonArray();
		r.cascaded().forEach(c::add);
		o.add("cascaded", c);
		return o;
	}

	static JsonObject verdict(Verdict v) {
		JsonObject o = new JsonObject();
		o.addProperty("clean", v.ok()); // (not "ok": the DevBridge answer's own member)
		o.add("refusals", refusals(v.refusals()));
		JsonArray n = new JsonArray();
		v.notes().forEach(n::add);
		o.add("notes", n);
		v.box().ifPresent(b -> o.add("box", box(b)));
		v.restoreBox().ifPresent(b -> o.add("restoreBox", box(b)));
		return o;
	}

	static JsonArray refusals(List<Refusal> list) {
		JsonArray a = new JsonArray();
		for (Refusal r : list) {
			JsonObject x = new JsonObject();
			x.addProperty("reason", r.reason().name());
			x.addProperty("message", r.message());
			a.add(x);
		}
		return a;
	}

	static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	static JsonArray box(BoundingBox b) {
		JsonArray a = new JsonArray();
		a.add(b.minX());
		a.add(b.minY());
		a.add(b.minZ());
		a.add(b.maxX());
		a.add(b.maxY());
		a.add(b.maxZ());
		return a;
	}
}
