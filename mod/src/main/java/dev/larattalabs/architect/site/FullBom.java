package dev.larattalabs.architect.site;

import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.BedSafety;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.GhostModel;
import dev.larattalabs.architect.placement.TemplateGrid;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.LongFunction;
import java.util.function.BiPredicate;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.BedBlock;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CoralBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.PathBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.material.Fluids;
import org.jspecify.annotations.Nullable;

/**
 * C26 (docs/CONTRACT.md phase 6c slice Y, "Full BOM before placing"): the whole bill of a construction placement, computed from the
 * dry-run plan {@link Sites#verdict} already builds, without touching the world.
 *
 * <p>It mirrors what the build queues ({@link Builder#planConvert}): the template's non-air cells, the foundation fill, and the
 * approach's fill, path and slabs, each at the state its <b>last write</b> leaves it, in {@link Sites}'s build order (template, unsafe
 * beds out, foundation fill, terrain cut, approach cut, approach fill, path, slabs). A queued cell that ends as air costs nothing, so a
 * cut cell, a bed left out and a cell the approach clears are free by construction. Each remaining cell costs
 * {@link Cells#cost} of its state, the same call the builder's bill uses.
 *
 * <p>{@code exact} is true when no planned cell is a known <b>drift source</b>: a block whose tick, run when the placement settles
 * (P6), changes what is written or what it costs. Known sources: a gravity block over a free cell (it falls: the cell is air), a dirt
 * path or farmland under a solid block whose item differs from dirt, and a coral block with no water next to it (it dies). Pure of
 * side effects; server thread.
 */
final class FullBom {
	/** At most this many drift cells are listed in the notes. */
	static final int MAX_LISTED = 16;

	/** The bill by item id, whether it is exact, and the drift cells (for the verdict's notes). */
	record Result(Map<String, Integer> items, boolean exact, List<String> driftCells, int cells) {
	}

	private FullBom() {
	}

	/**
	 * What a plan writes, in world coordinates: {@code template} is three ints per cell (x, y, z) with its states (air included),
	 * and the other arrays are x, y, z triples as the plan holds them.
	 */
	record Inputs(int[] templateXyz, BlockState[] templateStates, BiPredicate<Long, BlockState> unsafeBed, int[] fill, int[] clear, int[] approachClear,
		int[] approachFill, int[] approachPath, int[] approachSlabs, BlockState foundation, BlockState approachFillState, BlockState path,
		BlockState slab) {
	}

	/** The plan of a dry-run verdict as {@link Inputs}. */
	static Inputs inputs(ServerLevel level, Blueprint bp, Sites.SitePlan plan) {
		TemplateGrid grid = plan.grid();
		GhostModel m = grid.ghost(plan.turns());
		var box = plan.box();
		int[] xyz = new int[m.count() * 3];
		for (int i = 0; i < m.count(); i++) {
			xyz[3 * i] = box.minX() + m.x(i);
			xyz[3 * i + 1] = box.minY() + m.y(i);
			xyz[3 * i + 2] = box.minZ() + m.z(i);
		}
		BiPredicate<Long, BlockState> unsafe = (p, bed) -> {
			// the level's bed rule, as Sites.removeUnsafeBeds asks it
			var rule = ((BedBlock) bed.getBlock()).getBedRule(level, BlockPos.of(p));
			return BedSafety.unsafe(rule.canSleep() == net.minecraft.world.attribute.BedRule.Rule.NEVER, rule.destroyOnUse(), rule.destroyOnLeave());
		};
		BlockState foundation = Sites.foundationState(bp);
		TerrainFit.Plan t = plan.plan();
		Approach.Plan a = plan.approach();
		boolean any = a.rows() > 0;
		int[] none = new int[0];
		return new Inputs(xyz, grid.states(), unsafe, t.fill(), t.clear(), any ? a.clear() : none, any ? a.fill() : none, any ? a.path() : none,
			any ? a.slabs() : none, foundation, EntranceStyle.state(a.fillBlock(), foundation), any ? Sites.approachPath(bp, a) : foundation,
			any ? Sites.approachBlock(bp, true) : foundation);
	}

	static @Nullable Result of(ServerLevel level, Blueprint bp, Sites.SitePlan plan) {
		return compute(inputs(level, bp, plan), p -> {
			int x = BlockPos.getX(p);
			int z = BlockPos.getZ(p);
			LevelChunk c = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
			return c == null ? null : c.getBlockState(BlockPos.of(p));
		});
	}

	/**
	 * The bill of {@code in}: every cell the build queues at the state of its last write, costed with {@link Cells#cost}. {@code world}:
	 * the state at a cell the plan does not write (null = unknown, which makes the bill inexact);
	 */
	static Result compute(Inputs in, LongFunction<@Nullable BlockState> world) {
		Map<Long, BlockState> writes = new HashMap<>();
		Set<Long> queued = new LinkedHashSet<>();
		BlockState air = Blocks.AIR.defaultBlockState();
		// 1. the template (air cells are written too: a room is cleared), 2. unsafe beds out
		for (int i = 0; i < in.templateStates().length; i++) {
			long p = BlockPos.asLong(in.templateXyz()[3 * i], in.templateXyz()[3 * i + 1], in.templateXyz()[3 * i + 2]);
			BlockState s = in.templateStates()[i];
			if (s.getBlock() instanceof BedBlock && in.unsafeBed().test(p, s)) {
				writes.put(p, air);
				queued.add(p);
				continue;
			}
			writes.put(p, s);
			if (!s.isAir()) {
				queued.add(p);
			}
		}
		cells(in.fill(), in.foundation(), writes, queued);
		cells(in.clear(), air, writes, null);
		cells(in.approachClear(), air, writes, null);
		cells(in.approachFill(), in.approachFillState(), writes, queued);
		cells(in.approachPath(), in.path(), writes, queued);
		cells(in.approachSlabs(), in.slab(), writes, queued);
		Map<String, Integer> items = new TreeMap<>();
		List<String> drift = new ArrayList<>();
		boolean[] unknown = {false};
		int n = 0;
		LongFunction<@Nullable BlockState> at = p -> {
			BlockState w = writes.get(p);
			return w != null ? w : world.apply(p);
		};
		for (long p : queued) {
			BlockState s = writes.get(p);
			if (s == null || s.isAir()) {
				continue;
			}
			n++;
			for (SurvivalItems.Cost c : Cells.cost(s)) {
				items.merge(c.item(), c.count(), Integer::sum);
			}
			String why = drift(at, p, s, unknown);
			if (why != null) {
				drift.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p) + " " + Cells.blockId(s) + " (" + why + ")");
			}
		}
		return new Result(items, drift.isEmpty() && !unknown[0], drift, n);
	}

	private static void cells(int[] xyz, BlockState s, Map<Long, BlockState> writes, @Nullable Set<Long> queued) {
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			long p = BlockPos.asLong(xyz[i], xyz[i + 1], xyz[i + 2]);
			writes.put(p, s);
			if (queued != null) {
				queued.add(p);
			}
		}
	}

	/** Why the settle at P6 may change this cell's cost, or null. */
	private static @Nullable String drift(LongFunction<@Nullable BlockState> at, long p, BlockState s, boolean[] unknown) {
		if (s.getBlock() instanceof FallingBlock) {
			BlockState below = at.apply(BlockPos.asLong(BlockPos.getX(p), BlockPos.getY(p) - 1, BlockPos.getZ(p)));
			if (below == null) {
				unknown[0] = true;
				return null;
			}
			return FallingBlock.isFree(below) ? "gravity block over a free cell" : null;
		}
		if (s.getBlock() instanceof PathBlock || s.is(Blocks.FARMLAND)) {
			BlockState above = at.apply(BlockPos.asLong(BlockPos.getX(p), BlockPos.getY(p) + 1, BlockPos.getZ(p)));
			if (above == null) {
				unknown[0] = true;
				return null;
			}
			if (above.isSolid() && !(above.getBlock() instanceof net.minecraft.world.level.block.FenceGateBlock)
				&& !Cells.cost(s).equals(Cells.cost(Blocks.DIRT.defaultBlockState()))) {
				return "turns to dirt under a solid block";
			}
			return null;
		}
		if (s.getBlock() instanceof CoralBlock) {
			int[][] d = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
			for (int[] o : d) {
				BlockState nb = at.apply(BlockPos.asLong(BlockPos.getX(p) + o[0], BlockPos.getY(p) + o[1], BlockPos.getZ(p) + o[2]));
				if (nb == null) {
					unknown[0] = true;
					return null;
				}
				if (nb.getFluidState().is(Fluids.WATER) || nb.getFluidState().is(Fluids.FLOWING_WATER)) {
					return null;
				}
			}
			return "coral with no water next to it dies";
		}
		return null;
	}
}
