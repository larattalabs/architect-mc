package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.CellWrite;
import dev.larattalabs.architect.api.CellsRequest;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.OverlapPolicy;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Policy;
import dev.larattalabs.architect.api.RoadRequest;
import dev.larattalabs.architect.api.Verdict;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalMigration;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.site.InfraApi;
import dev.larattalabs.architect.site.Sites;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.TagParser;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueOutput;

/**
 * Phase 4e DevBridge hooks (docs/DEVBRIDGE.md changelog): the journal's state and stacks, the crash-test kill points, a failed
 * commit, roads and cell sites, and region hashes with exclusions for the any-order tests.
 */
public final class JournalDev {
	private JournalDev() {
	}

	public static void init() {
		DevBridge.register("dev.journal.state", 10_000, "{} - phase 4e: the world journal: open/unavailable, counters, every entry's metadata (id, kind, "
			+ "site, group, policy, layer, status, cells, sections, box, files, undo group), legacy names, unreferenced files, the last import's notes",
			(req, mc) -> DevBridge.onClient(mc, () -> ServerTasks.callOnServer(server -> {
				JsonObject o = WorldJournal.json();
				JournalMigration.Plan p = JournalMigration.last();
				if (p != null) {
					o.addProperty("imported", p.entries());
					JsonArray n = new JsonArray();
					p.notes().forEach(n::add);
					o.add("importNotes", n);
					JsonArray fl = new JsonArray();
					p.flagged().forEach(fl::add);
					o.add("importFlagged", fl);
				}
				o.addProperty("armed", WorldJournal.armed());
				return o;
			})).thenCompose(x -> x));
		DevBridge.register("dev.journal.at", 10_000, "{x, y, z, dimension?} - phase 4e: the stack at a cell, bottom first (entry, kind, site, policy, "
			+ "status, layer, before, after)", (req, mc) -> {
				Fields f = Fields.of(req);
				int x = (int) f.num("x");
				int y = (int) f.num("y");
				int z = (int) f.num("z");
				String dim = f.optStr("dimension", null);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					try {
						return WorldJournal.at(dim != null ? dim : Sites.dimensionId(level), x, y, z);
					} catch (java.io.IOException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
				})).thenCompose(r -> r);
			});
		DevBridge.register("dev.journal.killAt", 10_000, "{point: K1..K8 | migrate-before-commit | migrate-after-commit | null} - phase 4e TEST "
			+ "hook: the next matching step halts the JVM (Runtime.halt, nothing saved)", (req, mc) -> {
				JsonElement p = req.get("point");
				String point = p == null || p.isJsonNull() ? null : p.getAsString();
				if (point != null && !point.matches("K[1-8]|migrate-before-commit|migrate-after-commit")) {
					throw new DevBridge.DevException("point must be K1..K8, migrate-before-commit or migrate-after-commit");
				}
				WorldJournal.killAt(point);
				JsonObject o = new JsonObject();
				o.addProperty("armed", point);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.journal.failNextCommit", 10_000, "{} - phase 4e TEST hook: the next journal commit fails at its first file write "
			+ "(a full disk)", (req, mc) -> {
				WorldJournal.failNextCommit();
				JsonObject o = new JsonObject();
				o.addProperty("armed", true);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.road.check", 30_000, "{points: [[x,y,z]...], width?: 3, surface?, slab?, lanterns?: false, shallowDecks?: false, "
			+ "owner?, force?: false} - phase 4e: Sites.checkRoad (refusals, notes, cells, box, overlaps)", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> verdictJson(InfraApi.checkRoad(road(level, f)))))
					.thenCompose(r -> r);
			});
		DevBridge.register("dev.road.place", 180_000, "{points, width?, surface?, slab?, lanterns?, shallowDecks?, owner?, force?} - phase 4e: "
			+ "Sites.placeRoad (written over ticks) -> {placed, siteId, refusals, notes} when it is placed", (req, mc) -> {
				Fields f = Fields.of(req);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> InfraApi.placeRoad(road(level, f))))
					.thenCompose(r -> r).thenCompose(r -> r).thenApply(JournalDev::placeJson);
			});
		DevBridge.register("dev.cells.place", 600_000, "{kind, policy?: CELL|BOX, cells?: [[x,y,z,'block[props]']...], fill?: {min, max, state}, "
			+ "pad?: {minX, minZ, maxX, maxZ, y, top?, fill?, depth?: 3, clear?: 6}, naturalOnly?: true, overlap?: REFUSE|LAYER, owner?, force?, "
			+ "check?: false} - phase 4e: Sites.placeCells (or checkCells) -> {placed, siteId, refusals, notes}", (req, mc) -> {
				Fields f = Fields.of(req);
				boolean check = f.optBool("check", false);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					CellsRequest r = cells(level, f);
					if (check) {
						return CompletableFuture.completedFuture(verdictJson(InfraApi.checkCells(r)));
					}
					return InfraApi.placeCells(r).thenApply(JournalDev::placeJson);
				})).thenCompose(r -> r).thenCompose(r -> r);
			});
		DevBridge.register("dev.site.verify", 120_000, "{site, list?: false, max?: 20} - phase 4e: every cell where one of the site's active entries is "
			+ "top of the stack, compared with that entry's after by exact equality (state and block-entity data): {owned, mismatches, first: [..], "
			+ "list?: ['x,y,z <world state> [<BE data>]'..]} (the any-order tests' no-leak check: the list before and after a removal)", (req, mc) -> {
				Fields f = Fields.of(req);
				String site = f.nonBlank("site");
				boolean list = f.optBool("list", false);
				int max = f.optInt("max", 20, 0, 10_000);
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> verify(level, site, list, max))).thenCompose(r -> r);
			});
		DevBridge.register("dev.region.hash", 120_000, "{box: [minX,minY,minZ,maxX,maxY,maxZ], exclude?: [[6]...], cells?: false} - phase 4e: SHA-256 "
			+ "over every block state and block-entity NBT in the box, cells inside an excluded box left out (the order tests)", (req, mc) -> {
				Fields f = Fields.of(req);
				int[] b = six(f.json().get("box"));
				List<int[]> ex = new ArrayList<>();
				if (f.json().has("exclude")) {
					f.json().getAsJsonArray("exclude").forEach(e -> ex.add(six(e)));
				}
				boolean withCells = f.optBool("cells", false);
				long volume = (long) (b[3] - b[0] + 1) * (b[4] - b[1] + 1) * (b[5] - b[2] + 1);
				if (volume > 8_000_000) {
					throw new DevBridge.DevException("box too large (" + volume + " blocks)");
				}
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> hash(level, b, ex, withCells))).thenCompose(r -> r);
			});
	}

	static int[] six(JsonElement e) {
		JsonArray a = e.getAsJsonArray();
		if (a.size() != 6) {
			throw new DevBridge.DevException("a box is [minX, minY, minZ, maxX, maxY, maxZ]");
		}
		int[] b = new int[6];
		for (int i = 0; i < 6; i++) {
			b[i] = a.get(i).getAsInt();
		}
		return b;
	}

	private static RoadRequest road(ServerLevel level, Fields f) {
		List<BlockPos> pts = new ArrayList<>();
		for (JsonElement e : f.json().getAsJsonArray("points")) {
			JsonArray a = e.getAsJsonArray();
			pts.add(new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
		}
		return new RoadRequest(level, pts, f.optInt("width", 3, 1, 5), f.optStr("surface", null), f.optStr("slab", null), f.optBool("lanterns", false),
			f.optBool("shallowDecks", false), Mode.INSTANT, f.optStr("owner", null), new JsonObject(), null, f.optBool("force", false));
	}

	private static BlockState state(String s) {
		try {
			String t = s.contains("[") ? s : s;
			net.minecraft.commands.arguments.blocks.BlockStateParser.BlockResult r = net.minecraft.commands.arguments.blocks.BlockStateParser.parseForBlock(
				BuiltInRegistries.BLOCK, t, false);
			return r.blockState();
		} catch (Exception e) {
			throw new DevBridge.DevException("not a block state: " + s + " (" + e.getMessage() + ")");
		}
	}

	private static CellsRequest cells(ServerLevel level, Fields f) {
		List<CellWrite> cells = new ArrayList<>();
		JsonObject o = f.json();
		if (o.has("cells")) {
			for (JsonElement e : o.getAsJsonArray("cells")) {
				JsonArray a = e.getAsJsonArray();
				cells.add(CellWrite.of(new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()), state(a.get(3).getAsString())));
			}
		}
		if (o.has("fill")) {
			JsonObject fl = o.getAsJsonObject("fill");
			int[] a = PlacementXyz.xyz(fl.getAsJsonArray("min"));
			int[] b = PlacementXyz.xyz(fl.getAsJsonArray("max"));
			BlockState s = state(fl.get("state").getAsString());
			for (int y = Math.min(a[1], b[1]); y <= Math.max(a[1], b[1]); y++) {
				for (int z = Math.min(a[2], b[2]); z <= Math.max(a[2], b[2]); z++) {
					for (int x = Math.min(a[0], b[0]); x <= Math.max(a[0], b[0]); x++) {
						cells.add(CellWrite.of(new BlockPos(x, y, z), s));
					}
				}
			}
		}
		if (o.has("pad")) {
			JsonObject p = o.getAsJsonObject("pad");
			int y = p.get("y").getAsInt();
			BlockState top = state(p.has("top") ? p.get("top").getAsString() : "minecraft:grass_block");
			BlockState fill = state(p.has("fill") ? p.get("fill").getAsString() : "minecraft:dirt");
			BlockState air = state("minecraft:air");
			int depth = p.has("depth") ? p.get("depth").getAsInt() : 3;
			int clear = p.has("clear") ? p.get("clear").getAsInt() : 6;
			for (int z = p.get("minZ").getAsInt(); z <= p.get("maxZ").getAsInt(); z++) {
				for (int x = p.get("minX").getAsInt(); x <= p.get("maxX").getAsInt(); x++) {
					for (int d = depth; d >= 1; d--) {
						cells.add(CellWrite.of(new BlockPos(x, y - d, z), fill));
					}
					cells.add(CellWrite.of(new BlockPos(x, y, z), top));
					for (int c = 1; c <= clear; c++) {
						cells.add(CellWrite.of(new BlockPos(x, y + c, z), air));
					}
				}
			}
		}
		String overlap = f.optStr("overlap", "REFUSE");
		return new CellsRequest(level, f.nonBlank("kind"), Policy.valueOf(f.optStr("policy", "CELL")), cells, f.optBool("naturalOnly", true),
			OverlapPolicy.valueOf(overlap), Mode.INSTANT, f.optStr("owner", null), new JsonObject(), null, f.optBool("force", false));
	}

	static JsonObject verdictJson(Verdict v) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", v.ok());
		JsonArray r = new JsonArray();
		v.refusals().forEach(x -> {
			JsonObject j = new JsonObject();
			j.addProperty("reason", x.reason().name());
			j.addProperty("message", x.message());
			r.add(j);
		});
		o.add("refusals", r);
		JsonArray n = new JsonArray();
		v.notes().forEach(n::add);
		o.add("notes", n);
		o.addProperty("cells", v.cells());
		v.box().ifPresent(b -> o.addProperty("box", b.minX() + "," + b.minY() + "," + b.minZ() + "," + b.maxX() + "," + b.maxY() + "," + b.maxZ()));
		JsonArray ov = new JsonArray();
		v.overlaps().forEach(x -> {
			JsonObject j = new JsonObject();
			j.addProperty("site", x.siteId());
			j.addProperty("owner", x.owner());
			j.addProperty("cells", x.cells());
			j.addProperty("blocking", x.blocking());
			ov.add(j);
		});
		o.add("overlaps", ov);
		return o;
	}

	static JsonObject placeJson(PlaceResult p) {
		JsonObject o = new JsonObject();
		o.addProperty("placed", p.placed());
		o.addProperty("siteId", p.siteId().orElse(null));
		JsonArray r = new JsonArray();
		p.refusals().forEach(x -> {
			JsonObject j = new JsonObject();
			j.addProperty("reason", x.reason().name());
			j.addProperty("message", x.message());
			r.add(j);
		});
		o.add("refusals", r);
		JsonArray n = new JsonArray();
		p.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	/** dev.site.verify: the site's owned (top-of-stack) cells against its entries' after. */
	static JsonObject verify(ServerLevel level, String site, boolean list, int max) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			throw new DevBridge.DevException("the journal is not open");
		}
		java.util.Set<String> mine = new java.util.HashSet<>();
		java.util.Set<Long> keys = new java.util.TreeSet<>();
		String dim = null;
		for (JournalStore.Meta m : s.find(m -> site.equals(m.site()) && m.active())) {
			mine.add(m.id());
			dim = m.dimension();
			for (long k : m.sections()) {
				keys.add(k);
			}
		}
		int owned = 0;
		int bad = 0;
		JsonArray first = new JsonArray();
		JsonArray cells = list ? new JsonArray() : null;
		try {
			for (long key : keys) {
				// the top layer per cell of this section, over every active entry there
				java.util.Map<Integer, Object[]> top = new java.util.HashMap<>();
				for (String id : s.inSection(dim, key)) {
					JournalStore.Meta m = s.meta(id);
					if (m == null || !m.active()) {
						continue;
					}
					SectionCells sc = s.section(id, key);
					if (sc == null) {
						continue;
					}
					for (int k = 0; k < sc.size(); k++) {
						int idx = sc.index(k);
						Object[] t = top.get(idx);
						long layer = sc.layer(k);
						if (t == null || layer > (long) t[1] || layer == (long) t[1] && id.compareTo((String) t[0]) > 0) {
							top.put(idx, new Object[] {id, layer, sc.after(k), sc.pos(k)});
						}
					}
				}
				for (Object[] t : top.values()) {
					if (!mine.contains((String) t[0])) {
						continue;
					}
					owned++;
					long pos = (long) t[3];
					BlockPos p = BlockPos.of(pos);
					Journal.Value now = WorldJournal.valueAt(level, p);
					Journal.Value after = (Journal.Value) t[2];
					if (cells != null) {
						cells.add(p.getX() + "," + p.getY() + "," + p.getZ() + " " + now.state() + (now.nbt() == null ? "" : " " + now.nbt()));
					}
					if (after == null || !after.equals(now)) {
						bad++;
						if (first.size() < max) {
							first.add(p.toShortString() + " entry " + t[0] + " after " + (after == null ? "null" : after.state() + " " + after.nbt()) + " now "
								+ now.state() + " " + now.nbt());
						}
					}
				}
			}
		} catch (java.io.IOException e) {
			throw new DevBridge.DevException(e.getMessage());
		}
		JsonObject o = new JsonObject();
		o.addProperty("site", site);
		o.addProperty("entries", mine.size());
		o.addProperty("owned", owned);
		o.addProperty("mismatches", bad);
		o.add("first", first);
		if (cells != null) {
			o.add("list", cells);
		}
		return o;
	}

	/** The region hash with exclusions (states as NBT, block entities as their full NBT, like dev.box.hash). */
	static JsonObject hash(ServerLevel level, int[] b, List<int[]> exclude, boolean withCells) {
		try {
			MessageDigest md = MessageDigest.getInstance("SHA-256");
			BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
			JsonArray cells = withCells ? new JsonArray() : null;
			int counted = 0;
			for (int y = b[1]; y <= b[4]; y++) {
				for (int z = b[2]; z <= b[5]; z++) {
					for (int x = b[0]; x <= b[3]; x++) {
						boolean skip = false;
						for (int[] e : exclude) {
							if (x >= e[0] && x <= e[3] && y >= e[1] && y <= e[4] && z >= e[2] && z <= e[5]) {
								skip = true;
								break;
							}
						}
						if (skip) {
							continue;
						}
						p.set(x, y, z);
						BlockState s = level.getBlockState(p);
						String st = NbtUtils.writeBlockState(s).toString();
						md.update(st.getBytes(java.nio.charset.StandardCharsets.UTF_8));
						BlockEntity be = level.getBlockEntity(p);
						String beNbt = "";
						if (be != null) {
							TagValueOutput out = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
							be.saveWithFullMetadata(out);
							beNbt = out.buildResult().toString();
							md.update(beNbt.getBytes(java.nio.charset.StandardCharsets.UTF_8));
						}
						md.update((byte) '|');
						counted++;
						if (cells != null) {
							cells.add(x + "," + y + "," + z + " " + st + (beNbt.isEmpty() ? "" : " be=" + beNbt));
						}
					}
				}
			}
			JsonObject o = new JsonObject();
			o.addProperty("sha256", HexFormat.of().formatHex(md.digest()));
			o.addProperty("cells", counted);
			if (cells != null) {
				o.add("list", cells);
			}
			return o;
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/** [x, y, z] arrays. */
	static final class PlacementXyz {
		static int[] xyz(JsonArray a) {
			return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
		}
	}

	/** Unused: kept for SNBT block entity data in cells (a later hook). */
	static CompoundTag snbt(String s) {
		try {
			return TagParser.parseCompoundFully(s);
		} catch (Exception e) {
			throw new DevBridge.DevException("not SNBT: " + s);
		}
	}
}
