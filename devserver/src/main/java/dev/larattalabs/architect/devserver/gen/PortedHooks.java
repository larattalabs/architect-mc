package dev.larattalabs.architect.devserver.gen;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.site.Builder;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.permissions.Permissions;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueOutput;
import net.minecraft.world.phys.AABB;

/**
 * Hand ports of the server-side hooks that live in client feature classes (PlacementFeature, SurvivalFeature, Slice0aDev,
 * ScreenFeature's launcher/sidecar hooks), with the same names, arguments and answers. Keep them in step with those files;
 * the hooks in the client's dev/ package are derived automatically (devserver/build.gradle genHooks).
 */
public final class PortedHooks {
	private PortedHooks() {
	}

	static int[] xyz(Fields f, String field) {
		JsonElement el = f.json().get(field);
		if (el.isJsonArray()) {
			JsonArray a = el.getAsJsonArray();
			if (a.size() != 3) {
				throw new DevBridge.DevException(field + " must be [x, y, z]");
			}
			return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
		String[] parts = el.getAsString().trim().split("[\\s,]+");
		if (parts.length != 3) {
			throw new DevBridge.DevException(field + " must be \"x y z\" or [x, y, z]");
		}
		return new int[] {Integer.parseInt(parts[0]), Integer.parseInt(parts[1]), Integer.parseInt(parts[2])};
	}

	public static void init() {
		placement();
		survival();
		slice0a();
		sidecar();
	}

	// ------------------------------------------------------------------ PlacementFeature

	private static void placement() {
		DevBridge.register("dev.sites.state", 10_000, "{} - the placed sites of this world, the sites taken down, the world-start reports and snapshot "
			+ "files no site names", (req, mc) -> ServerTasks.callOnServer(server -> Sites.json()));
		DevBridge.register("dev.sites.remove", 30_000, "{site, force?: false} - Remove (restores the terrain) as the Library's Remove does", (req, mc) -> {
			Fields f = Fields.of(req);
			String id = f.nonBlank("site");
			boolean force = f.optBool("force", false);
			return ServerTasks.callAsPlayer((level, player) -> {
				JsonObject o = new JsonObject();
				try {
					Site s = Sites.get(id);
					ServerLevel sl = s == null ? level : Sites.levelOf(level.getServer(), s);
					Site gone = Sites.remove(sl == null ? level : sl, id, force);
					o.addProperty("removed", true);
					o.addProperty("restoreBox", Anchors.str(gone.restoreBox()));
				} catch (Sites.SiteException e) {
					o.addProperty("removed", false);
					o.addProperty("message", e.getMessage());
				}
				return o;
			});
		});
		DevBridge.register("dev.sites.failNextMove", 10_000, "{} - test hook: the next move fails restoring the old site and rolls back", (req, mc) -> {
			Sites.failNextMove();
			JsonObject o = new JsonObject();
			o.addProperty("armed", true);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.capture", 30_000, "{min, max, name} - save the box as a structure template to <gameDir>/architect/captures/<name>.nbt",
			(req, mc) -> {
				Fields f = Fields.of(req);
				int[] a = xyz(f, "min");
				int[] b = xyz(f, "max");
				String name = f.nonBlank("name");
				if (!dev.larattalabs.architect.placement.Blueprint.ID.matcher(name).matches()) {
					throw new DevBridge.DevException("name must match [a-z0-9_]+");
				}
				return ServerTasks.callAsPlayer((level, player) -> {
					try {
						Anchors.Bounds box = new Anchors.Bounds(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[0], b[0]),
							Math.max(a[1], b[1]), Math.max(a[2], b[2]));
						CompoundTag tag = Sites.capture(level, box);
						java.nio.file.Path out = dev.larattalabs.architect.placement.Blueprints.gameDataDir().resolve("captures").resolve(name + ".nbt");
						java.nio.file.Files.createDirectories(out.getParent());
						net.minecraft.nbt.NbtIo.writeCompressed(tag, out);
						JsonObject o = new JsonObject();
						o.addProperty("path", out.toString());
						o.addProperty("size", (box.maxX() - box.minX() + 1) + "x" + (box.maxY() - box.minY() + 1) + "x" + (box.maxZ() - box.minZ() + 1));
						o.addProperty("dataVersion", tag.getIntOr("DataVersion", -1));
						return o;
					} catch (java.io.IOException e) {
						throw new IllegalStateException(e.getMessage(), e);
					}
				});
			});
		DevBridge.register("dev.placement.stats", 10_000, "{reset?: false} - phase 4d: the placement budget's use while placement is active (see "
			+ "docs/DEVBRIDGE.md)", (req, mc) -> {
				boolean reset = Fields.of(req).optBool("reset", false);
				return ServerTasks.callAsPlayer((level, player) -> dev.larattalabs.architect.site.Placement.stats(reset));
			});
		DevBridge.register("dev.placement.jobs", 10_000, "{} - phase 4d: the ticked jobs running now", (req, mc) -> ServerTasks.callAsPlayer((level,
			player) -> {
			JsonObject o = new JsonObject();
			o.add("jobs", dev.larattalabs.architect.site.Placement.jobsJson());
			o.addProperty("slow", dev.larattalabs.architect.site.Placement.slow());
			o.addProperty("budgetMs", SurvivalWorld.placementBudgetMs());
			return o;
		}));
		DevBridge.register("dev.placement.slow", 10_000, "{on: bool} - phase 4d test hook: jobs write about 16 cells per tick", (req, mc) -> {
			boolean on = Fields.of(req).bool("on");
			dev.larattalabs.architect.site.Placement.setSlow(on);
			JsonObject o = new JsonObject();
			o.addProperty("slow", on);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.box.hash", 60_000, "{min, max, cells?: false} - SHA-256 over every block state and block-entity NBT in the box",
			(req, mc) -> {
				Fields f = Fields.of(req);
				int[] a = xyz(f, "min");
				int[] b = xyz(f, "max");
				boolean withCells = f.optBool("cells", false);
				long volume = (long) (Math.abs(b[0] - a[0]) + 1) * (Math.abs(b[1] - a[1]) + 1) * (Math.abs(b[2] - a[2]) + 1);
				if (volume > 4_000_000) {
					throw new DevBridge.DevException("box too large (" + volume + " blocks)");
				}
				return ServerTasks.callAsPlayer((level, player) -> hashBox(level, a, b, withCells));
			});
	}

	/** PlacementFeature.hashBox, unchanged. */
	static JsonObject hashBox(ServerLevel level, int[] a, int[] b, boolean withCells) {
		List<String> cells = withCells ? new java.util.ArrayList<>() : null;
		try {
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
			int air = 0;
			int blockEntities = 0;
			for (int y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
				for (int z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) {
					for (int x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
						p.set(x, y, z);
						BlockState s = level.getBlockState(p);
						if (s.isAir()) {
							air++;
						}
						String st = NbtUtils.writeBlockState(s).toString();
						md.update(st.getBytes(java.nio.charset.StandardCharsets.UTF_8));
						BlockEntity be = level.getBlockEntity(p);
						String beNbt = "";
						if (be != null) {
							blockEntities++;
							TagValueOutput out = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
							be.saveWithFullMetadata(out);
							CompoundTag t = out.buildResult();
							beNbt = t.toString();
							md.update(beNbt.getBytes(java.nio.charset.StandardCharsets.UTF_8));
						}
						if (cells != null) {
							cells.add(x + "," + y + "," + z + " " + st + (beNbt.isEmpty() ? "" : " be=" + beNbt));
						}
						md.update((byte) '|');
					}
				}
			}
			JsonObject o = new JsonObject();
			o.addProperty("sha256", HexFormat.of().formatHex(md.digest()));
			o.addProperty("air", air);
			o.addProperty("blockEntities", blockEntities);
			o.addProperty("dimension", Sites.dimensionId(level));
			if (cells != null) {
				JsonArray ca = new JsonArray();
				cells.forEach(ca::add);
				o.add("cells", ca);
			}
			return o;
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	// ------------------------------------------------------------------ SurvivalFeature

	private static void survival() {
		DevBridge.register("dev.survival.state", 10_000, "{} - this world's survival toggle, blocksPerTick, and whether the player may change it",
			(req, mc) -> ServerTasks.callAsPlayer((level, player) -> {
				JsonObject o = new JsonObject();
				o.addProperty("loaded", SurvivalWorld.loaded());
				o.addProperty("survival", SurvivalWorld.on());
				o.addProperty("blocksPerTick", SurvivalWorld.blocksPerTick());
				o.addProperty("mayToggle", player.permissions().hasPermission(Permissions.COMMANDS_GAMEMASTER));
				return o;
			}));
		DevBridge.register("dev.survival.set", 10_000, "{on: bool} - set the survival toggle (dev hook: bypasses the permission rule)", (req, mc) -> {
			boolean on = Fields.of(req).optBool("on", true);
			return ServerTasks.callOnServer(server -> {
				SurvivalWorld.set(server, on);
				JsonObject o = new JsonObject();
				o.addProperty("survival", SurvivalWorld.on());
				return o;
			});
		});
		DevBridge.register("dev.site.state", 10_000, "{site} - a construction site: state, queue, built, BOM, ledger, blocked cells, notes", (req, mc) -> {
			String id = Fields.of(req).nonBlank("site");
			return ServerTasks.callOnServer(server -> {
				try {
					return Builder.state(server, id);
				} catch (Sites.SiteException e) {
					throw new DevBridge.DevException(e.getMessage());
				}
			});
		});
		DevBridge.register("dev.site.cells", 30_000, "{site} - (6c Y2) every queued cell of a construction site as \"x,y,z\": block id of its target",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(server -> Builder.cellsJson(server, id));
			});
		DevBridge.register("dev.bom.predict", 60_000, "{bp, at: [x,y,z], rot?: 0-3, force?: true} - (6c Y2) the cells the full BOM predicts for a "
			+ "construction placement (the dry-run plan), plus the refusals", (req, mc) -> {
				Fields f = Fields.of(req);
				String bp = f.nonBlank("bp");
				JsonArray at = req.getAsJsonArray("at");
				int rot = req.has("rot") ? req.get("rot").getAsInt() : 0;
				boolean force = f.optBool("force", true);
				return ServerTasks.callOnServer(server -> {
					var b = dev.larattalabs.architect.placement.Blueprints.get(bp);
					if (b == null) {
						throw new DevBridge.DevException("no design " + bp);
					}
					return Sites.debugBom(server.overworld(), b, new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt()),
						net.minecraft.world.level.block.Rotation.values()[rot], force);
				});
			});
		DevBridge.register("dev.crate.insert", 30_000, "{site, items?: {item: count}, inventory?: true, exact?: false} - book items into the crate "
			+ "(exact: only units taken as themselves); site: a site, a road, or (6c Y1) stockpile:<owner>", (req, mc) -> {
			Fields f = Fields.of(req);
			String id = f.nonBlank("site");
			boolean inv = f.optBool("inventory", false);
			boolean exact = f.optBool("exact", false);
			Map<String, Integer> items = new LinkedHashMap<>();
			if (f.json().has("items")) {
				f.json().getAsJsonObject("items").entrySet().forEach(e -> items.put(e.getKey(), e.getValue().getAsInt()));
			}
			return ServerTasks.callAsPlayer((level, player) -> {
				JsonObject o = new JsonObject();
				try {
					if (inv) {
						o.addProperty("moved", Builder.insertFromInventory(player, id));
					} else {
						JsonObject in = new JsonObject();
						Builder.insertItems(level.getServer(), id, items, exact).forEach(in::addProperty);
						o.add("accepted", in);
					}
				} catch (Sites.SiteException e) {
					throw new DevBridge.DevException(e.getMessage());
				}
				return o;
			});
		});
		DevBridge.register("dev.site.finish", 30_000, "{site} - /architect site finish (no permission check): the remaining cells, free", (req, mc) -> {
			String id = Fields.of(req).nonBlank("site");
			return ServerTasks.callOnServer(server -> {
				JsonObject o = new JsonObject();
				try {
					o.addProperty("placed", Builder.finish(server, id));
				} catch (Sites.SiteException e) {
					o.addProperty("error", e.getMessage());
				}
				return o;
			});
		});
		DevBridge.register("dev.site.deconstruct", 60_000, "{site, force?: false} - Deconstruct: refunds, the terrain comes back -> the tally",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("site");
				boolean force = f.optBool("force", false);
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					try {
						Site s = Sites.get(id);
						var sl = s == null ? level : Sites.levelOf(level.getServer(), s);
						Site gone = Sites.remove(sl == null ? level : sl, id, force);
						o.addProperty("removed", true);
						o.addProperty("restoreBox", Anchors.str(gone.restoreBox()));
						JsonObject st = gone.construction() != null ? Builder.lastDeconstructionJson() : null;
						if (st != null) {
							o.add("tally", st);
						}
					} catch (Sites.SiteException e) {
						o.addProperty("removed", false);
						o.addProperty("message", e.getMessage());
					}
					return o;
				});
			});
		DevBridge.register("dev.site.mine", 30_000, "{pos: [x,y,z], pickup?: true} - the player mines a block as in survival, then picks up its drops",
			(req, mc) -> {
				Fields f = Fields.of(req);
				var a = f.json().getAsJsonArray("pos");
				BlockPos pos = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				boolean pickup = f.optBool("pickup", true);
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					String was = level.getBlockState(pos).toString();
					java.util.Set<java.util.UUID> before = new java.util.HashSet<>();
					AABB area = new AABB(pos).inflate(2);
					level.getEntitiesOfClass(ItemEntity.class, area).forEach(e -> before.add(e.getUUID()));
					boolean ok = player.gameMode.destroyBlock(pos);
					o.addProperty("mined", ok);
					o.addProperty("was", was);
					o.addProperty("now", level.getBlockState(pos).toString());
					int picked = 0;
					JsonArray got = new JsonArray();
					if (pickup) {
						for (ItemEntity e : List.copyOf(level.getEntitiesOfClass(ItemEntity.class, area))) {
							if (!before.contains(e.getUUID())) {
								got.add(e.getItem().getCount() + " " + e.getItem().getItem());
								e.setNoPickUpDelay();
								e.playerTouch(player);
								picked++;
							}
						}
					}
					o.addProperty("pickedUp", picked);
					o.add("drops", got);
					return o;
				});
			});
		DevBridge.register("dev.items.near", 10_000, "{pos: [x,y,z], radius?: 8} - dropped item entities near a point; and the player's inventory",
			(req, mc) -> {
				Fields f = Fields.of(req);
				var a = f.json().getAsJsonArray("pos");
				double r = f.optNum("radius", 8, 0.5, 64);
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					AABB box = new AABB(a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble(), a.get(0).getAsDouble() + 1,
						a.get(1).getAsDouble() + 1, a.get(2).getAsDouble() + 1).inflate(r);
					Map<String, Integer> items = new java.util.TreeMap<>();
					int stacks = 0;
					for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, box)) {
						stacks++;
						items.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(e.getItem().getItem()).toString(), e.getItem().getCount(),
							Integer::sum);
					}
					JsonObject io = new JsonObject();
					items.forEach(io::addProperty);
					o.addProperty("stacks", stacks);
					o.add("items", io);
					Map<String, Integer> inv = new java.util.TreeMap<>();
					var pi = player.getInventory();
					for (int i = 0; i < pi.getContainerSize(); i++) {
						var st = pi.getItem(i);
						if (!st.isEmpty()) {
							inv.merge(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
						}
					}
					JsonObject iv = new JsonObject();
					inv.forEach(iv::addProperty);
					o.add("inventory", iv);
					return o;
				});
			});
	}

	// ------------------------------------------------------------------ Slice0aDev

	private static void slice0a() {
		DevBridge.register("dev.batch.skipSave", 5_000, "{batchId} - (6c 0a) skip the queue save right after that batch's BATCH_DONE", (req, mc) -> {
			String id = Fields.of(req).str("batchId");
			dev.larattalabs.architect.site.Batches.SKIP_SAVE.add(id);
			JsonObject o = new JsonObject();
			o.addProperty("batchId", id);
			o.addProperty("armed", true);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.api.dropAck", 5_000, "{msgType} - (6c 0a) the mod drops the next helper ack of that message type", (req, mc) -> {
			String type = Fields.of(req).str("msgType");
			dev.larattalabs.architect.devserver.ServerSidecar.DROP_ACK.add(type);
			JsonObject o = new JsonObject();
			o.addProperty("type", type);
			o.addProperty("armed", true);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.api.pending", 5_000, "{} - (6c 0a) how many API futures are pending", (req, mc) -> {
			JsonObject o = new JsonObject();
			o.addProperty("pending", dev.larattalabs.architect.apiimpl.StopSweep.pending());
			return CompletableFuture.completedFuture(o);
		});
	}

	// ------------------------------------------------------------------ ScreenFeature's launcher and sidecar hooks

	private static void sidecar() {
		DevBridge.register("dev.launcher.state", 10_000, "{} - the launcher (headless: the devserver's): state, detail, pid, port", (req, mc) ->
			CompletableFuture.completedFuture(dev.larattalabs.architect.devserver.ServerSidecar.launcherJson()));
		DevBridge.register("dev.launcher.restart", 10_000, "{} - Restart helper", (req, mc) -> {
			dev.larattalabs.architect.devserver.ServerSidecar.restart();
			return CompletableFuture.completedFuture(dev.larattalabs.architect.devserver.ServerSidecar.launcherJson());
		});
		DevBridge.register("dev.sidecar.state", 10_000, "{} - the sidecar link and state: status (no key), designs", (req, mc) -> DevBridge.onClient(mc,
			() -> dev.larattalabs.architect.devserver.ServerSidecar.state().json()));
	}
}
