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
import java.util.HashSet;
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
	record Result(Map<String, Integer> items, boolean exact, List<String> driftCells, int cells, Map<Long, BlockState> states, List<String> inexactBecause) {
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
	 * the state at a cell the plan does not write (null = unknown, which makes the bill inexact).
	 *
	 * <p>The writes run through {@link Sim}, which repeats what {@code Level.setBlock} does without UPDATE_KNOWN_SHAPE: every changed cell
	 * tells its six neighbours (a door loses its upper half's cell, a torch its wall) and a neighbour whose shape update answers air is
	 * destroyed. {@code StructureTemplate.placeInWorld} adds its own passes (the shape's edge faces, then every placed block against its
	 * neighbours). So a door written over a hillside, whose upper cell the template clears next, is gone before the first block is built.
	 */
	static Result compute(Inputs in, LongFunction<@Nullable BlockState> world) {
		Flag unknown = new Flag();
		Sim sim = new Sim(world, unknown);
		Set<Long> queued = new LinkedHashSet<>();
		BlockState air = Blocks.AIR.defaultBlockState();
		int n = in.templateStates().length;
		long[] tp = new long[n];
		Set<Long> shape = new HashSet<>();
		List<Long> unsafeBeds = new ArrayList<>();
		// 1. the template, block by block in its saved order (air cells are written too: a room is cleared)
		for (int i = 0; i < n; i++) {
			long p = BlockPos.asLong(in.templateXyz()[3 * i], in.templateXyz()[3 * i + 1], in.templateXyz()[3 * i + 2]);
			tp[i] = p;
			shape.add(p);
			BlockState s = in.templateStates()[i].rotate(in.rotation()); // the placed state (a wall torch's facing, a stair's shape)
			sim.set(p, s, true);
			if (!s.isAir()) {
				queued.add(p);
			}
			if (s.getBlock() instanceof BedBlock && in.unsafeBed().test(p, s)) {
				unsafeBeds.add(p);
			}
		}
		// 2. updateShapeAtEdge: the faces of the placed shape, the cell and its outside neighbour told about each other
		net.minecraft.core.Direction[] all = net.minecraft.core.Direction.values();
		for (long p : tp) {
			BlockPos cell = BlockPos.of(p);
			for (net.minecraft.core.Direction d : all) {
				BlockPos np = cell.relative(d);
				if (shape.contains(np.asLong())) {
					continue;
				}
				BlockState st = sim.at(p);
				BlockState nst = sim.at(np.asLong());
				if (st == null || nst == null) {
					unknown.set("a cell next to the template is not loaded");
					continue;
				}
				BlockState updated = sim.shape(st, cell, d, np, nst);
				if (updated != st) {
					sim.set(p, updated, true);
				}
				BlockState nUpdated = sim.shape(nst, np, d.getOpposite(), cell, updated);
				if (nUpdated != nst) {
					sim.set(np.asLong(), nUpdated, true);
				}
			}
		}
		// 3. every placed block against its six neighbours (no cascade: UPDATE_KNOWN_SHAPE)
		for (long p : tp) {
			BlockState st = sim.at(p);
			if (st == null || st.isAir()) {
				continue;
			}
			BlockPos cell = BlockPos.of(p);
			BlockState u = st;
			for (net.minecraft.core.Direction d : SHAPE_ORDER) {
				BlockPos np = cell.relative(d);
				BlockState nb = sim.at(np.asLong());
				if (nb == null) {
					unknown.set("a cell next to the template is not loaded");
					continue;
				}
				u = sim.shape(u, cell, d, np, nb);
			}
			if (u != st) {
				sim.set(p, u, false);
			}
		}
		// 4. the unsafe beds out, 5. the foundation, the terrain cut, the approach (each write with its cascade)
		for (long p : unsafeBeds) {
			sim.set(p, air, true);
		}
		sim.cells(in.fill(), in.foundation(), queued);
		sim.cells(in.clear(), air, null);
		sim.cells(in.approachClear(), air, null);
		sim.cells(in.approachFill(), in.approachFillState(), queued);
		sim.cells(in.approachPath(), in.path(), queued);
		sim.cells(in.approachSlabs(), in.slab(), queued);
		Map<String, Integer> items = new TreeMap<>();
		List<String> drift = new ArrayList<>();
		int count = 0;
		Map<Long, BlockState> finalStates = new java.util.LinkedHashMap<>();
		LongFunction<@Nullable BlockState> at = sim::at;
		for (long p : queued) {
			BlockState s = sim.writes.get(p);
			if (s == null || s.isAir()) {
				continue;
			}
			count++;
			finalStates.put(p, s);
			for (SurvivalItems.Cost c : Cells.cost(s)) {
				items.merge(c.item(), c.count(), Integer::sum);
			}
			String why = drift(at, p, s, unknown);
			if (why != null) {
				drift.add(BlockPos.getX(p) + "," + BlockPos.getY(p) + "," + BlockPos.getZ(p) + " " + Cells.blockId(s) + " (" + why + ")");
			}
		}
		if (sim.runaway) {
			unknown.set("the shape updates did not settle");
		}
		return new Result(items, drift.isEmpty() && !unknown.on, drift, count, finalStates, List.copyOf(unknown.why));
	}

	/** Whether the bill may be off, and why (for the verdict's notes). */
	static final class Flag {
		boolean on;
		final Set<String> why = new LinkedHashSet<>();

		void set(String reason) {
			on = true;
			if (why.size() < 6) {
				why.add(reason);
			}
		}
	}

	/** {@code Block.UPDATE_SHAPE_ORDER}: the order a block is told about its neighbours. */
	static final net.minecraft.core.Direction[] SHAPE_ORDER = {net.minecraft.core.Direction.WEST, net.minecraft.core.Direction.EAST,
		net.minecraft.core.Direction.NORTH, net.minecraft.core.Direction.SOUTH, net.minecraft.core.Direction.DOWN, net.minecraft.core.Direction.UP};

	/** A small world over the plan's writes that repeats {@code Level.setBlock}'s shape updates. */
	static final class Sim {
		final Map<Long, BlockState> writes = new HashMap<>();
		private final LongFunction<@Nullable BlockState> world;
		private final Flag unknown;
		private final net.minecraft.world.level.LevelReader reader;
		private final net.minecraft.world.level.ScheduledTickAccess ticks = noTicks();
		private final net.minecraft.util.RandomSource random = net.minecraft.util.RandomSource.create(0L);
		private final java.util.ArrayDeque<long[]> queue = new java.util.ArrayDeque<>();
		private final java.util.ArrayDeque<BlockState> queueStates = new java.util.ArrayDeque<>();
		private boolean running;
		private int steps;
		boolean runaway;

		Sim(LongFunction<@Nullable BlockState> world, Flag unknown) {
			this.world = world;
			this.unknown = unknown;
			this.reader = reader(this::at, unknown);
		}

		@Nullable BlockState at(long p) {
			BlockState w = writes.get(p);
			return w != null ? w : world.apply(p);
		}

		BlockState shape(BlockState st, BlockPos pos, net.minecraft.core.Direction toNeighbour, BlockPos neighbour, BlockState neighbourState) {
			if (st.isAir()) {
				return st;
			}
			try {
				return st.updateShape(reader, ticks, pos, toNeighbour, neighbour, neighbourState, random);
			} catch (RuntimeException e) {
				unknown.set("a cell the plan reads is not loaded");
				return st;
			}
		}

		/** {@code Level.setBlock(p, s, flags)}: nothing when the cell already holds {@code s}; with {@code cascade} the six neighbours are told. */
		void set(long p, BlockState s, boolean cascade) {
			BlockState old = at(p);
			if (old == null) {
				unknown.set("an updateShape threw");
			}
			if (old == s) {
				return;
			}
			writes.put(p, s);
			if (!cascade) {
				return;
			}
			tell(p, s);
			if (running) {
				return;
			}
			running = true;
			try {
				while (!queue.isEmpty()) {
					if (++steps > 4_000_000) {
						runaway = true;
						queue.clear();
						queueStates.clear();
						break;
					}
					long[] u = queue.poll();
					BlockState changedState = queueStates.poll();
					BlockState cur = at(u[0]);
					if (cur == null) {
						unknown.set("a cell the plan reads is not loaded");
						continue;
					}
					BlockState next = shape(cur, BlockPos.of(u[0]), net.minecraft.core.Direction.values()[(int) u[1]], BlockPos.of(u[2]), changedState);
					if (next != cur) {
						// Block.updateOrDestroy: air destroys (drops suppressed), anything else is written; both tell the neighbours in turn
						writes.put(u[0], next);
						tell(u[0], next);
					}
				}
			} finally {
				running = false;
			}
		}

		/** {@code updateNeighbourShapes}: queues the six neighbours of {@code p}, told that it now holds {@code s}. */
		private void tell(long p, BlockState s) {
			BlockPos cell = BlockPos.of(p);
			for (net.minecraft.core.Direction d : SHAPE_ORDER) {
				queue.add(new long[] {cell.relative(d).asLong(), d.getOpposite().ordinal(), p});
				queueStates.add(s);
			}
		}

		void cells(int[] xyz, BlockState s, @Nullable Set<Long> queued) {
			for (int i = 0; i + 2 < xyz.length; i += 3) {
				long p = BlockPos.asLong(xyz[i], xyz[i + 1], xyz[i + 2]);
				set(p, s, true);
				if (queued != null) {
					queued.add(p);
				}
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
	static net.minecraft.world.level.LevelReader reader(LongFunction<@Nullable BlockState> at, Flag unknown) {
		return (net.minecraft.world.level.LevelReader) java.lang.reflect.Proxy.newProxyInstance(FullBom.class.getClassLoader(),
			new Class<?>[] {net.minecraft.world.level.LevelReader.class}, (proxy, m, args) -> {
				switch (m.getName()) {
					case "getBlockState", "getFluidState" -> {
						if (args != null && args.length == 1 && args[0] instanceof BlockPos pos) {
							BlockState st = at.apply(pos.asLong());
							if (st == null) {
								unknown.set("a cell a block asks about is not loaded");
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
	private static @Nullable String drift(LongFunction<@Nullable BlockState> at, long p, BlockState s, Flag unknown) {
		if (s.getBlock() instanceof FallingBlock) {
			BlockState below = at.apply(BlockPos.asLong(BlockPos.getX(p), BlockPos.getY(p) - 1, BlockPos.getZ(p)));
			if (below == null) {
				unknown.set("the cell below a gravity block is not loaded");
				return null;
			}
			return FallingBlock.isFree(below) ? "gravity block over a free cell" : null;
		}
		if (s.getBlock() instanceof PathBlock || s.is(Blocks.FARMLAND)) {
			BlockState above = at.apply(BlockPos.asLong(BlockPos.getX(p), BlockPos.getY(p) + 1, BlockPos.getZ(p)));
			if (above == null) {
				unknown.set("the cell above a path is not loaded");
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
					unknown.set("a neighbour of a coral is not loaded");
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
