package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.site.LotMask;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.block.TrapDoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.jspecify.annotations.Nullable;

/**
 * (7a K3, docs/CONTRACT.md "Phase 7a slice K3" §5) The bind check of a lot standing on a wall's line: its bound entry, fitted exactly as
 * the realise fits it (LotFitting on the lot's box and front, centred, setback 0, the template rotated by the fit's turns), must keep
 * the box's outer faces impassable (except the passage), and a gatehouse's passage floor must be standable. The passage itself is
 * always open after the realise: the entry's blocks there are dropped (the lot's {@link LotMask}, IRR's rule) and counted here.
 *
 * <p>The artifact's {@code lots[].onWall}: {@code {wall, at, floorY, outerFaces: {cells: runs}, passage?: {width, height, cells: runs,
 * floor: [x, z, y, ...], front, back, lintelY}}}, runs flat ({@code [x, z, y0, y1, ...]}) or nested. A missing or malformed
 * {@code onWall} is no wall lot; a malformed {@code passage} is no passage. Never throws on the artifact's shape.
 */
public final class WallLotCheck {
	private WallLotCheck() {
	}

	/** Cells listed in a refusal at most. */
	static final int LISTED = 8;

	/**
	 * A lot's {@code onWall}, read.
	 *
	 * @param outer the outer faces' column runs, flat
	 * @param passage the passage's column runs, flat (null: no passage)
	 * @param floor the passage floor's cells, flat {@code x, z, y} triples (empty: none given)
	 */
	record OnWall(String wall, @Nullable String at, int[] outer, int @Nullable [] passage, int[] floor) {
		static @Nullable OnWall of(JsonObject lot) {
			if (!(lot.get("onWall") instanceof JsonObject w) || !(w.get("wall") instanceof JsonPrimitive wall) || !wall.isString()
				|| !(w.get("outerFaces") instanceof JsonObject of) || !(of.get("cells") instanceof JsonArray oc)) {
				return null;
			}
			String at = w.get("at") instanceof JsonPrimitive a && a.isString() ? a.getAsString() : null;
			int[] passage = null;
			int[] floor = new int[0];
			if (w.get("passage") instanceof JsonObject p && p.get("cells") instanceof JsonArray pc) {
				int[] runs = LotMask.flatRuns(pc);
				if (runs.length > 0) {
					passage = runs;
					if (p.get("floor") instanceof JsonArray fl) {
						floor = triples(fl);
					}
				}
			}
			return new OnWall(wall.getAsString(), at, LotMask.flatRuns(oc), passage, floor);
		}

		LongOpenHashSet passageCells() {
			LongOpenHashSet s = new LongOpenHashSet();
			if (passage != null) {
				for (int i = 0; i + 3 < passage.length; i += 4) {
					for (int y = passage[i + 2]; y <= passage[i + 3]; y++) {
						s.add(BlockPos.asLong(passage[i], y, passage[i + 1]));
					}
				}
			}
			return s;
		}
	}

	/** Flat triples (flat ints, or nested 3-arrays), malformed entries skipped. */
	private static int[] triples(JsonArray a) {
		List<Integer> out = new ArrayList<>();
		if (!a.isEmpty() && a.get(0) instanceof JsonArray) {
			for (JsonElement e : a) {
				if (e instanceof JsonArray t && t.size() == 3 && num(t.get(0)) && num(t.get(1)) && num(t.get(2))) {
					out.add(t.get(0).getAsInt());
					out.add(t.get(1).getAsInt());
					out.add(t.get(2).getAsInt());
				}
			}
		} else {
			for (int i = 0; i + 2 < a.size(); i += 3) {
				if (num(a.get(i)) && num(a.get(i + 1)) && num(a.get(i + 2))) {
					out.add(a.get(i).getAsInt());
					out.add(a.get(i + 1).getAsInt());
					out.add(a.get(i + 2).getAsInt());
				}
			}
		}
		return out.stream().mapToInt(Integer::intValue).toArray();
	}

	private static boolean num(JsonElement e) {
		return e instanceof JsonPrimitive p && p.isNumber();
	}

	/**
	 * The result of one lot's check.
	 *
	 * @param why the refusal, or null
	 * @param open the outer-face cells left open
	 * @param floorBad the passage floor cells not standable
	 * @param passageDropped the entry's non-air blocks the realise drops on the passage
	 */
	record Result(@Nullable String why, int open, int floorBad, int passageDropped) {
	}

	/**
	 * The first lot on a wall whose bound entry fails, as its refusal; null when every one holds. {@code entries}: the merged entries
	 * (the artifact lots' own {@code entry} and the request's {@code lotEntries}). A lot with no bound entry, no {@code onWall}, an
	 * unreadable box or no library entry is skipped (the realise answers an unknown entry its own way).
	 */
	static @Nullable String problem(JsonObject body, Map<String, String> entries) {
		if (!(body.get("lots") instanceof JsonArray la)) {
			return null;
		}
		for (JsonElement e : la) {
			if (!(e instanceof JsonObject l) || !(l.get("id") instanceof JsonPrimitive idp)) {
				continue;
			}
			String entry = entries.get(idp.getAsString());
			OnWall w = entry == null ? null : OnWall.of(l);
			Anchors.Bounds box = w == null ? null : box(l);
			if (box == null) {
				continue;
			}
			String bpId = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
			Blueprint bp = Blueprints.get(bpId);
			TemplateGrid g = bp == null ? null : TemplateGrid.of(bpId);
			if (g == null) {
				continue;
			}
			LotFitting.Fit f = LotFitting.fit(bp, box, front(l), true, 0, true);
			Result r = check(idp.getAsString(), w, f.turns(), f.ox(), f.oy(), f.oz(), g.ghost(f.turns()), g.states());
			if (r.why() != null) {
				return r.why();
			}
		}
		return null;
	}

	/** An artifact lot's box ({@code [minX, minY, minZ, maxX, maxY, maxZ]}, or the IR's object form), or null. */
	static Anchors.@Nullable Bounds box(JsonObject l) {
		JsonElement b = l.get("box");
		if (b instanceof JsonArray a && a.size() >= 6) {
			for (int i = 0; i < 6; i++) {
				if (!num(a.get(i))) {
					return null;
				}
			}
			return new Anchors.Bounds(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt(), a.get(3).getAsInt(), a.get(4).getAsInt(), a.get(5)
				.getAsInt());
		}
		if (b instanceof JsonObject o) {
			String[] k = {"minX", "minY", "minZ", "maxX", "maxY", "maxZ"};
			int[] v = new int[6];
			for (int i = 0; i < 6; i++) {
				if (!num(o.get(k[i]))) {
					return null;
				}
				v[i] = o.get(k[i]).getAsInt();
			}
			return new Anchors.Bounds(v[0], v[1], v[2], v[3], v[4], v[5]);
		}
		return null;
	}

	/** An artifact lot's front (the realise reads the IR's, the same plan's); south when absent, as {@code irrigationDropped}. */
	static String front(JsonObject l) {
		String f = l.get("front") instanceof JsonPrimitive p && p.isString() ? p.getAsString() : "south";
		return switch (f) {
			case "north", "east", "south", "west" -> f;
			default -> "south";
		};
	}

	/**
	 * (7a K3) How many of an entry's non-air blocks the realise drops on an artifact lot's passage (and not already on its irrigation
	 * cells, which {@code irrigationDropped} counts). 0 for a lot with no passage.
	 */
	static long passageDropped(JsonObject lot, Blueprint bp, String id) {
		JsonObject pass = RegionsImpl.passageExt(lot);
		Anchors.Bounds box = pass == null ? null : box(lot);
		if (box == null) {
			return 0;
		}
		JsonObject only = new JsonObject();
		only.add(LotMask.EXT_PASSAGE, pass);
		LongOpenHashSet cells = LotMask.cells(only);
		LongOpenHashSet irr = new LongOpenHashSet();
		if (lot.get("irrigation") instanceof JsonObject g && g.get("cells") instanceof JsonArray c) {
			LotMask.addRuns(c, irr);
		}
		LotFitting.Fit f = LotFitting.fit(bp, box, front(lot), true, 0, true);
		return RegionsImpl.droppedBlocks(id, f, p -> cells.contains(p) && !irr.contains(p));
	}

	/**
	 * The entry's blocks where the realise writes them: world position to the template's state rotated by {@code turns}. Index {@code i}
	 * of {@code m} ({@link TemplateGrid#ghost}) is index {@code i} of {@code states} ({@link GhostModel#of} keeps the cell order). Pure.
	 */
	static Long2ObjectOpenHashMap<BlockState> placed(int turns, int ox, int oy, int oz, GhostModel m, BlockState[] states) {
		Rotation rot = Rotation.values()[Math.floorMod(turns, 4)];
		Long2ObjectOpenHashMap<BlockState> out = new Long2ObjectOpenHashMap<>(m.count());
		for (int i = 0; i < m.count(); i++) {
			out.put(BlockPos.asLong(ox + m.x(i), oy + m.y(i), oz + m.z(i)), states[i].rotate(rot));
		}
		return out;
	}

	/** One lot's check over its fitted, rotated template. Pure (given a bootstrapped registry). */
	static Result check(String lotId, OnWall w, int turns, int ox, int oy, int oz, GhostModel m, BlockState[] states) {
		Long2ObjectOpenHashMap<BlockState> at = placed(turns, ox, oy, oz, m, states);
		LongOpenHashSet passage = w.passageCells();
		int dropped = 0;
		for (long p : passage) {
			BlockState s = at.get(p);
			if (s != null && !s.isAir()) {
				dropped++;
			}
		}
		// the outer faces, except the passage: impassable
		List<String> open = new ArrayList<>();
		int nOpen = 0;
		int[] o = w.outer();
		for (int i = 0; i + 3 < o.length; i += 4) {
			for (int y = o[i + 2]; y <= o[i + 3]; y++) {
				long p = BlockPos.asLong(o[i], y, o[i + 1]);
				if (!passage.contains(p) && !closes(at.get(p))) {
					if (nOpen++ < LISTED) {
						open.add(o[i] + "," + y + "," + o[i + 1]);
					}
				}
			}
		}
		// the passage floor (x, z, y triples): standable
		List<String> bad = new ArrayList<>();
		int nBad = 0;
		int[] fl = w.floor();
		for (int i = 0; i + 2 < fl.length; i += 3) {
			if (!standable(at.get(BlockPos.asLong(fl[i], fl[i + 2], fl[i + 1])))) {
				if (nBad++ < LISTED) {
					bad.add(fl[i] + "," + fl[i + 2] + "," + fl[i + 1]);
				}
			}
		}
		String why = null;
		if (nOpen > 0) {
			why = "lot " + lotId + " on wall " + w.wall() + ": the design leaves the wall open at " + String.join(" ", open) + (nOpen > LISTED ? " ..." : "")
				+ " (" + nOpen + " cells)";
		} else if (nBad > 0) {
			why = "lot " + lotId + " on wall " + w.wall() + ": the passage floor is not standable at " + String.join(" ", bad) + (nBad > LISTED ? " ..." : "")
				+ " (" + nBad + " cells)";
		}
		return new Result(why, nOpen, nBad, dropped);
	}

	private static boolean passable(Block b) {
		return b instanceof DoorBlock || b instanceof FenceGateBlock || b instanceof TrapDoorBlock;
	}

	/**
	 * Whether an entry block closes a cell of the wall: a collision shape reaching the cell's full height (a full block, a pane, a fence,
	 * a wall block, stairs), not a door, fence gate or trapdoor. Null (no entry block there) and air are open.
	 */
	static boolean closes(@Nullable BlockState s) {
		if (s == null || s.isAir() || passable(s.getBlock())) {
			return false;
		}
		VoxelShape v = s.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		return !v.isEmpty() && v.max(Direction.Axis.Y) >= 1.0;
	}

	/**
	 * Whether a passage floor cell is standable: no entry block there (the region's pad stays), or an entry block with a collision top
	 * in (0, 1] (not a fence or wall block's 1.5, not a door, trapdoor or fence gate, not air or a fluid: no collision).
	 */
	static boolean standable(@Nullable BlockState s) {
		if (s == null) {
			return true;
		}
		if (s.isAir() || passable(s.getBlock())) {
			return false;
		}
		VoxelShape v = s.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		if (v.isEmpty()) {
			return false;
		}
		double top = v.max(Direction.Axis.Y);
		return top > 0 && top <= 1.0;
	}
}
