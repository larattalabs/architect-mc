package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.delta.DeltaPlanner;
import dev.larattalabs.architect.delta.TemplateDelta;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.journal.WriteCounter;
import dev.larattalabs.architect.library.EntryVersions;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteDeltas;
import dev.larattalabs.architect.site.Sites;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;

/**
 * Phase 5b DevBridge hooks (docs/DEVBRIDGE.md changelog): entry versions (list, install a hand-written version without Claude,
 * the blueprint delta), delta check / apply, revert and history of a placed site, and the block-write counter for the
 * minimality checks. No Claude.
 */
public final class DeltaDev {
	private DeltaDev() {
	}

	public static void init() {
		DevBridge.register("dev.entry.versions", 10_000, "{entry} - phase 5b: the entry's head version, its lineage and its complete version folders",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("entry");
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> versionsJson(id))).thenCompose(x -> x);
			});
		DevBridge.register("dev.entry.installVersion", 60_000, "{entry, dir, by?: 'design', summary?: ''} - phase 5b TEST hook: installs the files of "
			+ "dir (<entry>.nbt, <entry>.blueprint.json, <entry>.parts.nbt?, <entry>.mjs?) as the next version of a user library entry (the "
			+ "contract's crash-safe order, delta.json from the mod's TemplateDelta), then reloads the library -> {version}", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("entry");
				Path dir = Path.of(f.nonBlank("dir"));
				String by = f.optStr("by", "design");
				String summary = f.optStr("summary", "");
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> install(server, id, dir, by, summary))).thenCompose(x -> x);
			});
		DevBridge.register("dev.entry.delta", 30_000, "{entry, from, to, cells?: false} - phase 5b: the blueprint delta of two versions (the mod's "
			+ "TemplateDelta; the kit's diff.mjs --json shape) -> {frameKept, approximate, parts, added, removed, changed, unchanged, notes, cells?}",
			(req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("entry");
				int from = f.optInt("from", 1, 1, 1_000_000);
				int to = f.optInt("to", 1, 1, 1_000_000);
				boolean cells = f.optBool("cells", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> {
					Blueprints.Version a = Blueprints.version(server, id, from);
					Blueprints.Version b = Blueprints.version(server, id, to);
					if (a == null || b == null) {
						throw new DevBridge.DevException("no version " + (a == null ? from : to) + " of " + id);
					}
					return deltaJson(id, from, to, SiteDeltas.templateDelta(a, b), cells);
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.delta.check", 30_000, "{site, version?: 0 (the head), playerEdits?: KEEP|OVERWRITE|REFUSE, overlap?: REFUSE|LAYER, "
			+ "owner?, force?, cells?: false} - phase 5b: Sites.checkDelta -> {ok, refusals, from, to, added, removed, changed, parts, kept, overlaps, "
			+ "box, notes, ghost?}", (req, mc) -> {
				Fields f = Fields.of(req);
				SiteDeltas.Request r = request(f);
				boolean cells = f.optBool("cells", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> checkJson(SiteDeltas.check(level, r), cells))).thenCompose(
					x -> x);
			});
		DevBridge.register("dev.site.delta.apply", 120_000, "{site, version?, playerEdits?, overlap?, owner?, force?} - phase 5b: Sites.applyDelta "
			+ "(instant) -> {applied, from, to, written, kept, reshaped, notes} or {applied: false, refusals}", (req, mc) -> {
				Fields f = Fields.of(req);
				SiteDeltas.Request r = request(f);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					try {
						return resultJson(SiteDeltas.apply(level, r));
					} catch (Sites.SiteException e) {
						JsonObject o = new JsonObject();
						o.addProperty("applied", false);
						o.addProperty("reason", e.reason().name());
						o.addProperty("error", e.getMessage());
						return o;
					}
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.revert", 120_000, "{site, version, owner?, force?} - phase 5b: Sites.revert (creative: one undo of the deltas "
			+ "above the version in the site's chain, else a forward delta)", (req, mc) -> {
				Fields f = Fields.of(req);
				String site = f.nonBlank("site");
				int v = f.optInt("version", 1, 1, 1_000_000);
				String owner = f.optStr("owner", null);
				boolean force = f.optBool("force", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					try {
						return resultJson(SiteDeltas.revert(level, site, v, owner, force));
					} catch (Sites.SiteException e) {
						JsonObject o = new JsonObject();
						o.addProperty("applied", false);
						o.addProperty("reason", e.reason().name());
						o.addProperty("error", e.getMessage());
						return o;
					}
				})).thenCompose(x -> x);
			});
		DevBridge.register("dev.site.history", 10_000, "{site} - phase 5b: the site's version, head version, chain and history", (req, mc) -> {
			String site = Fields.of(req).nonBlank("site");
			return DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> historyJson(server, site))).thenCompose(x -> x);
		});
		DevBridge.register("dev.writes.count", 10_000, "{box: [x0,y0,z0,x1,y1,z1]} - phase 5b TEST hook: the positions whose block changed in the box "
			+ "since the last call (the first call starts counting) -> {count, cells?}", (req, mc) -> {
				JsonArray b = req.getAsJsonArray("box");
				int[] box = new int[6];
				for (int i = 0; i < 6; i++) {
					box[i] = b.get(i).getAsInt();
				}
				boolean list = Fields.of(req).optBool("cells", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					long[] c = WriteCounter.drain(Sites.dimensionId(level), box);
					JsonObject o = new JsonObject();
					o.addProperty("count", c.length);
					if (list) {
						JsonArray a = new JsonArray();
						for (long p : c) {
							a.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p));
						}
						o.add("cells", a);
					}
					return o;
				})).thenCompose(x -> x);
			});
	}

	static SiteDeltas.Request request(Fields f) {
		String site = f.nonBlank("site");
		int v = f.optInt("version", 0, 0, 1_000_000);
		DeltaPlanner.Edits e = DeltaPlanner.Edits.valueOf(f.optStr("playerEdits", "KEEP").toUpperCase(java.util.Locale.ROOT));
		boolean layer = "LAYER".equalsIgnoreCase(f.optStr("overlap", "REFUSE"));
		return new SiteDeltas.Request(site, v, e, layer, f.optStr("owner", null), f.optBool("force", false));
	}

	static JsonObject versionsJson(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null) {
			throw new DevBridge.DevException("no entry " + id);
		}
		JsonObject o = new JsonObject();
		o.addProperty("entry", id);
		o.addProperty("head", Blueprints.headVersion(e));
		o.addProperty("bundled", e.bundled());
		JsonArray l = new JsonArray();
		for (EntryVersions.Lineage x : EntryVersions.lineage(e.json(), null)) {
			l.add(x.toJson());
		}
		o.add("versions", l);
		JsonArray c = new JsonArray();
		if (e.dir() != null) {
			EntryVersions.complete(e.dir()).forEach(c::add);
		}
		o.add("folders", c);
		return o;
	}

	static JsonObject install(MinecraftServer server, String id, Path dir, String by, String summary) {
		Blueprints.Entry e = Blueprints.entry(id);
		if (e == null || e.dir() == null) {
			throw new DevBridge.DevException(id + " is not a user library entry");
		}
		try {
			int head = Blueprints.headVersion(e);
			Blueprints.Version a = Blueprints.version(server, id, head);
			JsonObject delta = null;
			if (a != null && Files.isRegularFile(dir.resolve(id + ".nbt"))) {
				// delta.json from the mod's TemplateDelta (counts and boxes; no cell lists)
				var raw = net.minecraft.nbt.NbtIo.readCompressed(dir.resolve(id + ".nbt"), net.minecraft.nbt.NbtAccounter.unlimitedHeap());
				Path pf = dir.resolve(id + ".parts.nbt");
				var parts = Files.isRegularFile(pf) ? net.minecraft.nbt.NbtIo.readCompressed(pf, net.minecraft.nbt.NbtAccounter.unlimitedHeap()) : null;
				var json = EntryVersions.readJson(dir.resolve(id + ".blueprint.json"));
				TemplateDelta.Result r = TemplateDelta.delta(new TemplateDelta.Version(a.raw(), a.parts(), a.entry().json()), new TemplateDelta.Version(raw,
					parts, json));
				delta = deltaJson(id, head, head + 1, r, false);
			}
			int v = EntryVersions.install(e.dir(), id, dir, by, head, summary, delta, EntryVersions.Faults.NONE);
			Blueprints.reload(server);
			JsonObject o = new JsonObject();
			o.addProperty("version", v);
			return o;
		} catch (Exception ex) {
			throw new DevBridge.DevException("install failed: " + ex.getMessage());
		}
	}

	static JsonArray box(int[] b) {
		JsonArray a = new JsonArray();
		if (b != null) {
			for (int v : b) {
				a.add(v);
			}
		}
		return a;
	}

	/** The kit's {@code diff.mjs --json} shape (delta.json: counts and boxes; with {@code cells}: the design-coordinate lists). */
	public static JsonObject deltaJson(String id, int from, int to, TemplateDelta.Result r, boolean cells) {
		JsonObject o = new JsonObject();
		o.addProperty("entryId", id);
		o.addProperty("from", from);
		o.addProperty("to", to);
		o.addProperty("frameKept", r.frameKept());
		o.addProperty("approximate", r.approximate());
		JsonObject parts = new JsonObject();
		r.parts().forEach((n, p) -> {
			JsonObject x = new JsonObject();
			x.addProperty("status", p.status().name());
			x.addProperty("added", p.added());
			x.addProperty("removed", p.removed());
			x.addProperty("changed", p.changed());
			x.add("boxFrom", p.boxFrom() == null ? com.google.gson.JsonNull.INSTANCE : box(p.boxFrom()));
			x.add("boxTo", p.boxTo() == null ? com.google.gson.JsonNull.INSTANCE : box(p.boxTo()));
			parts.add(n, x);
		});
		o.add("parts", parts);
		o.addProperty("added", r.added().size());
		o.addProperty("removed", r.removed().size());
		o.addProperty("changed", r.changed().size());
		o.addProperty("unchanged", r.unchanged());
		JsonArray notes = new JsonArray();
		r.notes().forEach(notes::add);
		o.add("notes", notes);
		if (r.frameHint() != null) {
			o.add("frameHint", box(r.frameHint()));
		}
		if (cells) {
			JsonObject c = new JsonObject();
			c.add("added", cellList(r.added()));
			c.add("removed", cellList(r.removed()));
			c.add("changed", cellList(r.changed()));
			o.add("cells", c);
		}
		return o;
	}

	static JsonArray cellList(List<Long> l) {
		JsonArray a = new JsonArray();
		for (int[] c : TemplateDelta.unpack(l)) {
			JsonArray x = new JsonArray();
			x.add(c[0]);
			x.add(c[1]);
			x.add(c[2]);
			a.add(x);
		}
		return a;
	}

	static JsonObject checkJson(SiteDeltas.Check c, boolean cells) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", c.ok());
		o.addProperty("waits", c.waits());
		JsonArray rs = new JsonArray();
		for (SiteDeltas.Refusal r : c.refusals()) {
			JsonObject x = new JsonObject();
			x.addProperty("reason", r.reason().name());
			x.addProperty("message", r.message());
			x.addProperty("waits", r.waits());
			rs.add(x);
		}
		o.add("refusals", rs);
		o.addProperty("from", c.from());
		o.addProperty("to", c.to());
		o.addProperty("added", c.added());
		o.addProperty("removed", c.removed());
		o.addProperty("changed", c.changed());
		JsonObject parts = new JsonObject();
		c.parts().forEach((n, p) -> {
			JsonObject x = new JsonObject();
			x.addProperty("status", p.status().name());
			x.addProperty("added", p.added());
			x.addProperty("removed", p.removed());
			x.addProperty("changed", p.changed());
			parts.add(n, x);
		});
		o.add("parts", parts);
		o.add("kept", keptJson(c.kept()));
		JsonObject ov = new JsonObject();
		c.overlaps().forEach(ov::addProperty);
		o.add("overlaps", ov);
		if (c.box() != null) {
			o.add("box", box(new int[] {c.box().minX(), c.box().minY(), c.box().minZ(), c.box().maxX(), c.box().maxY(), c.box().maxZ()}));
		}
		JsonArray notes = new JsonArray();
		c.notes().forEach(notes::add);
		o.add("notes", notes);
		o.addProperty("writes", c.ghost().size());
		if (c.plan() != null) {
			o.addProperty("entryCells", c.plan().outcome().entryCells().size());
			o.addProperty("shapeGuards", c.plan().outcome().shapeGuards().size());
			o.addProperty("growth", c.plan().outcome().growth().size());
		}
		if (cells) {
			JsonObject g = new JsonObject();
			for (Map.Entry<Long, Byte> e : c.ghost().entrySet()) {
				String k = switch (e.getValue()) {
					case SiteDeltas.ADDED -> "added";
					case SiteDeltas.REMOVED -> "removed";
					case SiteDeltas.CHANGED -> "changed";
					default -> "kept";
				};
				if (!g.has(k)) {
					g.add(k, new JsonArray());
				}
				g.getAsJsonArray(k).add(BlockPos.getX(e.getKey()) + "," + BlockPos.getY(e.getKey()) + "," + BlockPos.getZ(e.getKey()));
			}
			o.add("ghost", g);
		}
		return o;
	}

	static JsonArray keptJson(List<DeltaPlanner.Kept> kept) {
		JsonArray a = new JsonArray();
		for (DeltaPlanner.Kept k : kept) {
			JsonObject x = new JsonObject();
			x.addProperty("pos", BlockPos.getX(k.pos()) + "," + BlockPos.getY(k.pos()) + "," + BlockPos.getZ(k.pos()));
			x.addProperty("found", k.found().toString());
			x.addProperty("planned", k.planned().toString());
			a.add(x);
		}
		return a;
	}

	static JsonObject resultJson(SiteDeltas.Result r) {
		JsonObject o = new JsonObject();
		o.addProperty("applied", r.applied());
		o.addProperty("site", r.siteId());
		o.addProperty("from", r.from());
		o.addProperty("to", r.to());
		o.addProperty("written", r.written());
		o.add("kept", keptJson(r.kept()));
		o.addProperty("reshaped", r.reshaped());
		JsonArray notes = new JsonArray();
		r.notes().forEach(notes::add);
		o.add("notes", notes);
		if (r.after() != null) {
			o.add("record", r.after().toJson());
		}
		return o;
	}

	static JsonObject historyJson(MinecraftServer server, String site) {
		Site b = Sites.get(site);
		if (b == null) {
			throw new DevBridge.DevException("no site " + site);
		}
		JsonObject o = new JsonObject();
		o.addProperty("version", SiteDeltas.versionOf(server, b));
		b = Sites.get(site);
		o.addProperty("head", SiteDeltas.headVersion(b.blueprint()));
		o.add("versioning", b.versioning().toJson());
		JsonArray ch = new JsonArray();
		for (int[] c : SiteDeltas.chain(b)) {
			ch.add(c[0]);
		}
		o.add("chain", ch);
		return o;
	}

	static String str(JsonElement e) {
		return e == null || e.isJsonNull() ? null : e.getAsString();
	}

	static Journal.Value air() {
		return WorldJournal.value(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState());
	}
}
