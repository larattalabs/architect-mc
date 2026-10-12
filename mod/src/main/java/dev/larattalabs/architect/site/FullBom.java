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
	record Result(Map<String, Integer> items, boolean exact, List<String> driftCells, int cells, Map<Long, BlockState> states) {
	}

	private FullBom() {
	}

	/**
	 * What a plan writes, in world coordinates: {@code template} is three ints per cell (x, y, z) with its states (air included),
	 * and the other arrays are x, y, z triples as the plan holds them.
	 */
	record Inputs(net.minecraft.world.level.block.Rotation rotation, int[] templateXyz, BlockState[] templateStates, BiPredicate<Long, BlockState> unsafeBed, int[] fill, int[] clear, int[] approachClear,
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
		return new Inputs(net.minecraft.world.level.block.Rotation.values()[Math.floorMod(plan.turns(), 4)], xyz, grid.states(), unsafe, t.fill(), t.clear(), any ? a.clear() : none, any ? a.fill() : none, any ? a.path() : none,
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
		boolean[] unknownT = {false};
		Map<Long, BlockState> writes = new HashMap<>();
		Map<Long, Integer> phase = new HashMap<>(); // the build step of a cell's last write: 0 template, 1 fill, 2 cut, 3 approach cut, 4 approach fill, 5 path, 6 slabs
		Set<Long> queued = new LinkedHashSet<>();
		BlockState air = Blocks.AIR.defaultBlockState();
		// 1. the template (air cells are written too: a room is cleared), 2. unsafe beds out
		for (int i = 0; i < in.templateStates().length; i++) {
			long p = BlockPos.asLong(in.templateXyz()[3 * i], in.templateXyz()[3 * i + 1], in.templateXyz()[3 * i + 2]);
			BlockState s = in.templateStates()[i].rotate(in.rotation()); // the placed state (a wall torch's facing, a stair's shape)
			phase.put(p, 0);
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
		// the template's own final pass (StructureTemplate.placeInWorld, flags without UPDATE_KNOWN_SHAPE): once every block is written, each is
		// shape-updated against all six neighbours as the world is THEN (the template over the original terrain, before the foundation
		// and the approach), bottom up. A door over a gap the foundation fills later, a lantern on a chest, goes (drops suppressed).
		net.minecraft.world.level.ScheduledTickAccess ticks0 = noTicks();
		net.minecraft.util.RandomSource random0 = net.minecraft.util.RandomSource.create(0L);
		LongFunction<@Nullable BlockState> at0 = p -> {
			BlockState w = writes.get(p);
			return w != null ? w : world.apply(p);
		};
		net.minecraft.world.level.LevelReader reader0 = reader(at0, unknownT);
		net.minecraft.core.Direction[] order = {net.minecraft.core.Direction.WEST, net.minecraft.core.Direction.EAST, net.minecraft.core.Direction.NORTH,
			net.minecraft.core.Direction.SOUTH, net.minecraft.core.Direction.DOWN, net.minecraft.core.Direction.UP};
		List<Long> bottomUp = new ArrayList<>();
		for (int i = 0; i < in.templateStates().length; i++) {
			bottomUp.add(BlockPos.asLong(in.templateXyz()[3 * i], in.templateXyz()[3 * i + 1], in.templateXyz()[3 * i + 2]));
		}
		bottomUp.sort(java.util.Comparator.comparingInt(BlockPos::getY));
		for (long p : bottomUp) {
			BlockState s = writes.get(p);
			if (s == null || s.isAir()) {
				continue;
			}
			BlockPos cell = BlockPos.of(p);
			BlockState now = s;
			for (net.minecraft.core.Direction d : order) {
				BlockPos np = cell.relative(d);
				BlockState nb = at0.apply(np.asLong());
				if (nb == null) {
					unknownT[0] = true;
					continue;
				}
				try {
					now = now.updateShape(reader0, ticks0, cell, d, np, nb, random0);
				} catch (RuntimeException e) {
					unknownT[0] = true;
				}
				if (now.isAir()) {
					break;
				}
			}
			if (now != s) {
				writes.put(p, now);
			}
		}
		cells(in.fill(), in.foundation(), writes, queued, phase, 1);
		cells(in.clear(), air, writes, null, phase, 2);
		cells(in.approachClear(), air, writes, null, phase, 3);
		cells(in.approachFill(), in.approachFillState(), writes, queued, phase, 4);
		cells(in.approachPath(), in.path(), writes, queued, phase, 5);
		cells(in.approachSlabs(), in.slab(), writes, queued, phase, 6);
		Map<String, Integer> items = new TreeMap<>();
		List<String> drift = new ArrayList<>();
		boolean[] unknown = {unknownT[0]};
		int n = 0;
		Map<Long, BlockState> finalStates = new java.util.LinkedHashMap<>();
		LongFunction<@Nullable BlockState> at = p -> {
			BlockState w = writes.get(p);
			return w != null ? w : world.apply(p);
		};
		// the shape updates of the writes (Level.setBlock without UPDATE_KNOWN_SHAPE): a cell is told about each neighbour written AFTER it,
		// and a block whose updateShape answers air (a door over a floor the approach then replaced, what hung on it) is destroyed with
		// its drops suppressed. A block written after its neighbours, or beside neighbours no later step wrote, is never re-checked.
		net.minecraft.world.level.LevelReader reader = reader(at, unknown);
		net.minecraft.world.level.ScheduledTickAccess ticks = noTicks();
		net.minecraft.util.RandomSource random = net.minecraft.util.RandomSource.create(0L);
		net.minecraft.core.Direction[] dirs = net.minecraft.core.Direction.values();
		for (int round = 0; round < 8; round++) {
			boolean changed = false;
			for (long p : queued) {
				BlockState s = writes.get(p);
				if (s == null || s.isAir()) {
					continue;
				}
				int pc = phase.getOrDefault(p, 0);
				BlockPos cell = BlockPos.of(p);
				for (net.minecraft.core.Direction d : dirs) {
					BlockPos np = cell.relative(d);
					if (phase.getOrDefault(np.asLong(), -1) <= pc) {
						continue;
					}
					BlockState nb = at.apply(np.asLong());
					if (nb == null) {
						unknown[0] = true;
						continue;
					}
					BlockState now = writes.get(p);
					BlockState after;
					try {
						after = now.updateShape(reader, ticks, cell, d, np, nb, random);
					} catch (RuntimeException e) {
						unknown[0] = true;
						continue;
					}
					if (after != now) {
						writes.put(p, after);
						if (after.isAir()) {
							phase.put(p, 99);
						}
						changed = true;
						if (after.isAir()) {
							break;
						}
					}
				}
			}
			if (!changed) {
				break;
			}
		}
		for (long p : queued) {
			BlockState s = writes.get(p);
			if (s == null || s.isAir()) {
				continue;
			}
			n++;
			finalStates.put(p, s);
			for (SurvivalItems.Cost c : Cells.cost(s)) {
				items.merge(c.item(), c.count(), Integer::sum);
			}
			String why = drift(at, p, s, unknown);
			if (why != null) {
				drift.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p) + " " + Cells.blockId(s) + " (" + why + ")");
			}
		}
		return new Result(items, drift.isEmpty() && !unknown[0], drift, n, finalStates);
	}

	private static void cells(int[] xyz, BlockState s, Map<Long, BlockState> writes, @Nullable Set<Long> queued, Map<Long, Integer> phase, int step) {
		for (int i = 0; i + 2 < xyz.length; i += 3) {
			long p = BlockPos.asLong(xyz[i], xyz[i + 1], xyz[i + 2]);
			writes.put(p, s);
			phase.put(p, step);
			if (queued != null) {
				queued.add(p);
			}
		}
	}

	/** A {@link net.minecraft.world.level.ScheduledTickAccess} that drops what is scheduled (a shape update only asks to schedule). */
	static net.minecraft.world.level.ScheduledTickAccess noTicks() {
		return (net.minecraft.world.level.ScheduledTickAccess) java.lang.reflect.Proxy.newProxyInstance(FullBom.class.getClassLoader(),
			new Class<?>[] {net.minecraft.world.level.ScheduledTickAccess.class}, (proxy, m, args) -> {
				switch (m.getName()) {
					case "scheduleTick" -> {
						return null;
					}
					case "hashCode" -> {
						return System.identityHashCode(proxy);
					}
					case "equals" -> {
						return proxy == args[0];
					}
					default -> throw new UnsupportedOperationException(m.getName());
				}
			});
	}

	/** A {@link net.minecraft.world.level.LevelReader} over the planned cells: {@code getBlockState} and {@code getFluidState}, nothing else. */
	static net.minecraft.world.level.LevelReader reader(LongFunction<@Nullable BlockState> at, boolean[] unknown) {
		return (net.minecraft.world.level.LevelReader) java.lang.reflect.Proxy.newProxyInstance(FullBom.class.getClassLoader(),
			new Class<?>[] {net.minecraft.world.level.LevelReader.class}, (proxy, m, args) -> {
				switch (m.getName()) {
					case "getBlockState", "getFluidState" -> {
						if (args != null && args.length == 1 && args[0] instanceof BlockPos pos) {
							BlockState st = at.apply(pos.asLong());
							if (st == null) {
								unknown[0] = true;
								st = Blocks.AIR.defaultBlockState();
							}
							return m.getName().equals("getBlockState") ? st : st.getFluidState();
						}
					}
					case "getBlockEntity" -> {
						return null;
					}
					case "hashCode" -> {
						return System.identityHashCode(proxy);
					}
					case "equals" -> {
						return proxy == args[0];
					}
					case "toString" -> {
						return "FullBom.reader";
					}
					default -> {
					}
				}
				if (m.isDefault()) {
					return java.lang.reflect.InvocationHandler.invokeDefault(proxy, m, args);
				}
				throw new UnsupportedOperationException(m.getName());
			});
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
