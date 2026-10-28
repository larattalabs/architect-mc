package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (7a GJ, docs/CONTRACT.md "Phase 7a slice GJ") A district joins a walled town through one of its wall's standing gates; the mod's half.
 * <ul>
 * <li>{@link #gates}: a standing region's gates from its IR (the plan meta never reaches the mod): the kit's
 * {@code kit/lib/region/beside.mjs besideGates}, equal on every fixture ({@code GateJoinTest}).</li>
 * <li>{@link #standsCheck}: each gate's opening as the world holds it now (plan time): a gate walled up or with its door gone is marked
 * {@code stands: false} with why, and the kit skips it.</li>
 * <li>{@link #wallRegionRound}: a wall region round a town (§4): the owner's standing region, other than the town, with a wall part,
 * whose claim holds the town claim's centre.</li>
 * <li>{@link #recheck}: the realise re-check's gate rule (§7): every traverse cell held by the wall's region with the block type it
 * wrote (a door's {@code open}/{@code powered} volatile), its opening clear; else ARTIFACT_STALE naming the gate.</li>
 * </ul>
 */
public final class GateJoin {
	private GateJoin() {
	}

	private static final Map<String, int[]> FACING = Map.of("north", new int[] {0, -1}, "south", new int[] {0, 1}, "east", new int[] {1, 0}, "west",
		new int[] {-1, 0});

	/** A gate's door from a block state string: {@code door}, {@code fence_gate} or {@code none} (the kit's gateDoorOf). */
	static String doorOf(@Nullable String state) {
		if (state == null) {
			return "none";
		}
		String id = state.replaceAll("\\[.*$", "");
		if (id.endsWith("_door")) {
			return "door";
		}
		if (id.endsWith("_fence_gate")) {
			return "fence_gate";
		}
		return "none";
	}

	/** One column of a wall part: the block at the walk's feet (absent: none written there), a solid write above it, and every y's block. */
	private static final class Col {
		boolean has;
		@Nullable String at;
		boolean above;
		final Map<Integer, @Nullable String> ys = new HashMap<>();
	}

	private static long key(int x, int z) {
		return ((long) x << 32) | (z & 0xffffffffL);
	}

	/**
	 * (§2, §3) The region's gates: per graph node of kind {@code gate}, its wall part's opening columns 4-connected to its {@code at} column
	 * (air, a door or a fence gate at {@code at.y} under a written lintel), its outer and inner cells on {@code at}'s line, the clear height and
	 * the door. The kit's besideGates, field for field, sorted by gate id.
	 */
	public static JsonArray gates(String id, JsonObject ir) {
		TreeMap<String, JsonObject> out = new TreeMap<>();
		if (!(ir.get("graph") instanceof JsonObject g) || !(g.get("nodes") instanceof JsonArray nodes)) {
			return new JsonArray();
		}
		for (JsonElement ne : nodes) {
			JsonObject n = ne.getAsJsonObject();
			if (!"gate".equals(BesideReach.str(n, "kind")) || !(n.get("at") instanceof JsonArray at) || !(n.get("ports") instanceof JsonArray ports)
				|| ports.isEmpty()) {
				continue;
			}
			JsonObject port = ports.get(0).getAsJsonObject();
			int[] f = FACING.get(BesideReach.str(port, "facing"));
			String ref = BesideReach.str(n, "ref");
			if (f == null || ref == null) {
				continue;
			}
			String pid = ("w_" + ref).length() > 48 ? ("w_" + ref).substring(0, 48) : "w_" + ref;
			JsonObject part = null;
			if (ir.get("parts") instanceof JsonArray parts) {
				for (JsonElement pe : parts) {
					if (pid.equals(BesideReach.str(pe.getAsJsonObject(), "id"))) {
						part = pe.getAsJsonObject();
					}
				}
			}
			if (part == null) {
				continue;
			}
			int ax = at.get(0).getAsInt(), ay = at.get(1).getAsInt(), az = at.get(2).getAsInt();
			Map<Long, Col> col = new HashMap<>();
			if (part.get("ops") instanceof JsonArray ops) {
				for (JsonElement oe : ops) {
					JsonObject op = oe.getAsJsonObject();
					if (!"columns".equals(BesideReach.str(op, "op")) || !(op.get("cols") instanceof JsonArray cols)) {
						continue;
					}
					JsonArray mats = op.get("materials") instanceof JsonArray m ? m : new JsonArray();
					for (int i = 0; i + 4 < cols.size(); i += 5) {
						int x = cols.get(i).getAsInt(), z = cols.get(i + 1).getAsInt(), y0 = cols.get(i + 2).getAsInt(), y1 = cols.get(i + 3).getAsInt();
						int mi = cols.get(i + 4).getAsInt();
						String mat = mi >= 0 && mi < mats.size() && !mats.get(mi).isJsonNull() ? mats.get(mi).getAsString() : null;
						Col c = col.computeIfAbsent(key(x, z), k -> new Col());
						for (int y = y0; y <= y1; y++) {
							c.ys.put(y, mat);
						}
						if (y0 <= ay && y1 >= ay) {
							c.has = true;
							c.at = mat;
						}
						if (y1 > ay && mat != null && "none".equals(doorOf(mat))) {
							c.above = true;
						}
					}
				}
			}
			java.util.function.LongPredicate opening = k -> {
				Col c = col.get(k);
				return c != null && c.above && c.has && (c.at == null || !"none".equals(doorOf(c.at)));
			};
			if (!opening.test(key(ax, az))) {
				continue;
			}
			int w = Math.max(1, port.get("width") instanceof JsonElement we && we.isJsonPrimitive() ? we.getAsInt() : 1);
			TreeSet<Long> seen = new TreeSet<>();
			ArrayDeque<int[]> q = new ArrayDeque<>();
			seen.add(key(ax, az));
			q.add(new int[] {ax, az});
			while (!q.isEmpty()) {
				int[] p = q.poll();
				for (int[] d : new int[][] {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
					int nx = p[0] + d[0], nz = p[1] + d[1];
					long k = key(nx, nz);
					if (seen.contains(k) || Math.abs(nx - ax) > w + 8 || Math.abs(nz - az) > w + 8 || !opening.test(k)) {
						continue;
					}
					seen.add(k);
					q.add(new int[] {nx, nz});
				}
			}
			List<int[]> cells = new ArrayList<>();
			for (long k : seen) {
				cells.add(new int[] {(int) (k >> 32), (int) k});
			}
			cells.sort((a, b) -> a[0] != b[0] ? Integer.compare(a[0], b[0]) : Integer.compare(a[1], b[1]));
			int dMax = Integer.MIN_VALUE, dMin = Integer.MAX_VALUE;
			int[] o = null, i0 = null;
			for (int[] c : cells) {
				boolean onLine = f[0] != 0 ? c[1] == az : c[0] == ax;
				if (!onLine) {
					continue;
				}
				int d = c[0] * f[0] + c[1] * f[1];
				if (d > dMax) {
					dMax = d;
					o = c;
				}
				if (d < dMin) {
					dMin = d;
					i0 = c;
				}
			}
			String doorBlock = null;
			for (int[] c : cells) {
				String s = col.get(key(c[0], c[1])).at;
				if (s != null && !"none".equals(doorOf(s))) {
					doorBlock = s.replaceAll("\\[.*$", "");
					break;
				}
			}
			int h = Integer.MAX_VALUE;
			for (int[] c : cells) {
				Col cc = col.get(key(c[0], c[1]));
				int t = 0;
				while (cc.ys.containsKey(ay + t) && (cc.ys.get(ay + t) == null || !"none".equals(doorOf(cc.ys.get(ay + t))))) {
					t++;
				}
				h = Math.min(h, t);
			}
			JsonObject r = new JsonObject();
			r.addProperty("region", id);
			r.addProperty("wall", ref);
			String gid = String.valueOf(BesideReach.str(n, "id")).replaceFirst("^gate:", "");
			r.addProperty("id", gid);
			r.add("at", BesideReach.arr(new int[] {ax, ay, az}));
			r.addProperty("y", ay - 1);
			r.addProperty("h", h);
			r.addProperty("width", w);
			r.add("facing", BesideReach.arr(f));
			r.addProperty("door", doorOf(doorBlock));
			if (doorBlock == null) {
				r.add("doorBlock", com.google.gson.JsonNull.INSTANCE);
			} else {
				r.addProperty("doorBlock", doorBlock);
			}
			JsonArray ca = new JsonArray();
			cells.forEach(c -> ca.add(BesideReach.arr(c)));
			r.add("cells", ca);
			r.add("outer", BesideReach.arr(new int[] {o[0] + f[0], o[1] + f[1]}));
			r.add("inner", BesideReach.arr(new int[] {i0[0] - f[0], i0[1] - f[1]}));
			out.put(gid, r);
		}
		JsonArray a = new JsonArray();
		out.values().forEach(a::add);
		return a;
	}

	/**
	 * Whether the block standing is the one the wall wrote, by type: a door's open and powered are volatile (its type compares), and a
	 * dirt path the world turned to dirt (vanilla, a block once over it) is still the walk.
	 */
	static boolean sameKind(BlockState wrote, BlockState now) {
		if (wrote.getBlock() == now.getBlock()) {
			return true;
		}
		return wrote.is(net.minecraft.world.level.block.Blocks.DIRT_PATH) && now.is(net.minecraft.world.level.block.Blocks.DIRT);
	}

	/** Whether a block may stand in a gate's opening: air (or any non-colliding air-like block), a door or a fence gate, in any state. */
	static boolean openingBlock(BlockState s) {
		Block b = s.getBlock();
		return s.isAir() || b instanceof DoorBlock || b instanceof FenceGateBlock;
	}

	/**
	 * (§2) Each gate as the world holds it now (plan time, the server thread): its opening (every cell from the walk's feet up its clear
	 * height) air, a door or a fence gate, and its walk floor not air. A gate that fails gets {@code stands: false} and {@code why}; the kit
	 * skips it ("not standing as built").
	 */
	public static void standsCheck(ServerLevel level, JsonArray gates) {
		for (JsonElement ge : gates) {
			JsonObject g = ge.getAsJsonObject();
			int y = g.get("y").getAsInt(), h = g.get("h").getAsInt();
			String why = null;
			for (JsonElement ce : g.getAsJsonArray("cells")) {
				JsonArray c = ce.getAsJsonArray();
				int x = c.get(0).getAsInt(), z = c.get(1).getAsInt();
				if (level.getBlockState(new BlockPos(x, y, z)).isAir()) {
					why = "its walk at " + x + ", " + y + ", " + z + " is air";
					break;
				}
				for (int yy = y + 1; yy <= y + h && why == null; yy++) {
					BlockState s = level.getBlockState(new BlockPos(x, yy, z));
					if (!openingBlock(s)) {
						why = "its opening at " + x + ", " + yy + ", " + z + " holds " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(s.getBlock());
					}
				}
				if (why != null) {
					break;
				}
			}
			if (why != null) {
				g.addProperty("stands", false);
				g.addProperty("why", why);
			}
		}
	}

	/**
	 * (§4) The wall region round a standing town: the first (by id) region of the town's owner and dimension, standing and not in flight,
	 * other than the town, whose effective IR has a wall part ({@code w_<id>}) with a gate node, and whose claim holds the town claim's
	 * centre. Null when none.
	 */
	public static RegionsImpl.@Nullable Live wallRegionRound(RegionsImpl.Live town) {
		int[] tc = town.rec().claim;
		int cx = (tc[0] + tc[3]) >> 1, cz = (tc[2] + tc[5]) >> 1;
		TreeMap<String, RegionsImpl.Live> found = new TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			if (l == town || l.rec().state == RegionState.REMOVED || RegionsImpl.besideBusy(l) != null || !java.util.Objects.equals(l.rec().owner, town
				.rec().owner) || !l.rec().dimension.equals(town.rec().dimension)) {
				continue;
			}
			int[] c = l.rec().claim;
			if (cx < c[0] || cx > c[3] || cz < c[2] || cz > c[5]) {
				continue;
			}
			JsonObject ir = Revisions.effective(l);
			if (ir == null || gates(l.rec().id, ir).isEmpty()) {
				continue;
			}
			found.put(l.rec().id, l);
		}
		return found.isEmpty() ? null : found.firstEntry().getValue();
	}

	/** The top active journal cell at each position of {@code cols} (guard leaves excluded): its group and its after state. Server thread. */
	record Top(String group, @Nullable BlockState after, long layer) {
	}

	static Map<Long, Top> tops(String dimension, BesideReach.Cols cols) throws IOException {
		Map<Long, Top> out = new HashMap<>();
		JournalStore store = WorldJournal.storeOrNull();
		int[] rect = cols.rect();
		if (store == null || rect == null) {
			return out;
		}
		int[] box = {rect[0], Integer.MIN_VALUE / 2, rect[1], rect[2], Integer.MAX_VALUE / 2, rect[3]};
		for (JournalStore.Meta m : store.find(mm -> mm.active() && !WorldJournal.LEAVES.equals(mm.kind()) && mm.intersects(dimension, box))) {
			for (long sk : m.sections()) {
				int sx = SectionPos.x(sk), sz = SectionPos.z(sk);
				if (sx * 16 + 15 < rect[0] || sx * 16 > rect[2] || sz * 16 + 15 < rect[1] || sz * 16 > rect[3]) {
					continue;
				}
				SectionCells sc = store.section(m.id(), sk);
				if (sc == null) {
					continue;
				}
				for (int k = 0; k < sc.size(); k++) {
					long p = sc.pos(k);
					if (!cols.has(Journal.x(p), Journal.z(p))) {
						continue;
					}
					Top had = out.get(p);
					if (had != null && had.layer() >= sc.layer(k)) {
						continue;
					}
					Journal.Value after = sc.after(k);
					BlockState st = after == null ? null : net.minecraft.nbt.NbtUtils.readBlockState(net.minecraft.core.registries.BuiltInRegistries.BLOCK, after
						.state());
					out.put(p, new Top(m.group(), st, sc.layer(k)));
				}
			}
		}
		return out;
	}

	/**
	 * (§7) The gate rule of the realise re-check, once before any write: the gate's region stands (not removed, not in flight), and every
	 * traverse cell (its opening's columns, from the walk up its clear height) is held on top by that region's group with the block type it
	 * wrote (a door's open and powered volatile) and stands so in the world; the opening clear. Else {"ARTIFACT_STALE", why} naming the gate.
	 * Server thread.
	 */
	public static String @Nullable [] recheck(String dimension, ServerLevel level, JsonObject gate) {
		String region = BesideReach.str(gate, "region"), gid = BesideReach.str(gate, "id");
		String name = "gate " + gid + " of region " + region;
		RegionsImpl.Live w = region == null ? null : RegionsImpl.live(region);
		if (w == null || w.rec().state == RegionState.REMOVED) {
			return new String[] {"ARTIFACT_STALE", name + ": the region was removed; re-plan"};
		}
		String busy = RegionsImpl.besideBusy(w);
		if (busy != null) {
			return new String[] {"ARTIFACT_STALE", name + ": region " + region + " is " + busy + "; re-plan"};
		}
		BesideReach.Cols cols = BesideReach.colsOf(gate.getAsJsonArray("cells"));
		int y = gate.get("y").getAsInt(), h = gate.get("h").getAsInt();
		Map<Long, Top> top;
		try {
			top = tops(dimension, cols);
		} catch (IOException e) {
			return new String[] {"JOURNAL_UNAVAILABLE", name + ": the journal could not be read (" + e.getMessage() + ")"};
		}
		String[] bad = {null};
		// the opening first (a player's block in it names the gate as not clear), then the holder and the blocks the wall wrote
		cols.forEach((x, z) -> {
			for (int yy = y + 1; yy <= y + h && bad[0] == null; yy++) {
				BlockState now = level.getBlockState(new BlockPos(x, yy, z));
				if (!openingBlock(now)) {
					bad[0] = name + " is not clear at " + x + ", " + yy + ", " + z + " (" + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(now.getBlock())
						+ "); re-plan";
				}
			}
		});
		cols.forEach((x, z) -> {
			for (int yy = y; yy <= y + h && bad[0] == null; yy++) {
				BlockState now = level.getBlockState(new BlockPos(x, yy, z));
				Top t = top.get(BlockPos.asLong(x, yy, z));
				if (t == null) {
					continue; // a cell the wall never wrote (air it found there): nothing of the gate's to compare
				}
				if (!t.group().equals(w.rec().groupId)) {
					bad[0] = name + " at " + x + ", " + yy + ", " + z + " is held since the plan by another site; re-plan";
					return;
				}
				if (t.after() != null && !sameKind(t.after(), now)) {
					bad[0] = name + " at " + x + ", " + yy + ", " + z + " is " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(now.getBlock())
						+ ", not the " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(t.after().getBlock()) + " its wall wrote; re-plan";
					return;
				}
			}
		});
		return bad[0] == null ? null : new String[] {"ARTIFACT_STALE", bad[0]};
	}
}
