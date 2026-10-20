package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.survival.BuildOrder;
import dev.larattalabs.architect.survival.CellBits;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import dev.larattalabs.architect.survival.SurvivalWorld;
import dev.larattalabs.architect.survival.WaitCalc;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueInput;
import org.jspecify.annotations.Nullable;

/**
 * (6c RS, docs/CONTRACT.md "Phase 6c slice RS" §5, §6) A survival region's construction targets. A tile of a survival IR (ARTL v2: each
 * cell's class and group) is written in two parts: its free-pass cells as an ordinary CELL entry, at once; and per group (a plan part)
 * with held or paid cells, a <b>target</b>: a cell site ({@code c<n>}) of the region's owner whose journal entry holds those cells' before
 * and planned after, written nothing at put-down, fed from the owner's stockpile like a construction road ({@link RoadBuilder}'s model:
 * {@code RoadBuilder.run} and {@code stepFed} hand a target here).
 *
 * <p>A target builds in <b>runs</b>: its cells in build order ({@link BuildOrder}, bottom up; a cut or carve after every paid cell above it
 * and beside it within 1), cut at put-down into courses (one y each) of at most a quarter of the stockpile's capacity in stacks. A run
 * places its first cell only when its whole bill is available to the target ({@code stock - reserved} at its place in the feed order), and
 * the target reserves only its current run's bill. Held cells (free cells of a part with paid ones, §4.3) cost nothing and wait in the
 * runs with the paid ones. Cells are written as the tile writes them ({@link Sites#CELL_FLAGS}, the entry's block-entity NBT), so a
 * built target equals its INSTANT twin cell for cell. What is built is derived from the world (a rescan), never persisted per tick.
 * Server thread.
 */
public final class RegionTargets {
	/** The target's spec member: {@code {region, part, group, held: base64 over the queue, runs: [end...], capStacks}}. */
	public static final String SPEC = "regionTarget";
	/** The target's ext keys (S-RS-1: SITE_WAITING carries the region and the part). */
	public static final String EXT_REGION = "architect_mc:region";
	public static final String EXT_PART = "architect_mc:part";

	/** Per target: its decoded plan (held cells, run ends, carve deps) and which run has started (in memory: a rescan shows a run started). */
	private static final Map<String, Plan> PLANS = new ConcurrentHashMap<>();

	private RegionTargets() {
	}

	/** A target's run-time plan. */
	static final class Plan {
		final long placedAt;
		final BitSet held;
		final int[] ends;
		/** Per queue index: the queue indexes that must be built first (a cut's paid neighbours above and beside), or null. */
		final int @Nullable [][] deps;
		int started = -1;
		/** The entry's before over the target's box (what the builder may replace), read once. */
		@Nullable Cells before;

		Plan(long placedAt, BitSet held, int[] ends, int @Nullable [][] deps) {
			this.placedAt = placedAt;
			this.held = held;
			this.ends = ends;
			this.deps = deps;
		}

		int runOf(int q) {
			for (int k = 0; k < ends.length; k++) {
				if (q < ends[k]) {
					return k;
				}
			}
			return ends.length - 1;
		}

		int start(int run) {
			return run == 0 ? 0 : ends[run - 1];
		}
	}

	/** Whether a cell site is a region's construction target. */
	public static boolean is(@Nullable Infra i) {
		return i != null && i.spec().has(SPEC);
	}

	static JsonObject spec(Infra i) {
		return i.spec().getAsJsonObject(SPEC);
	}

	/** The region a target builds for, or null. */
	public static @Nullable String regionOf(Infra i) {
		return is(i) && spec(i).has("region") ? spec(i).get("region").getAsString() : null;
	}

	/** The plan part a target builds, or null. */
	public static @Nullable String partOf(Infra i) {
		return is(i) && spec(i).has("part") ? spec(i).get("part").getAsString() : null;
	}

	// ------------------------------------------------------------------ the split of a tile (put-down)

	/** A group's cells of a tile: its target's cells, the held ones marked. */
	record Group(int group, String part, long[] pos, Value[] vals, BitSet held) {
	}

	/** A survival tile's cells split: the free pass (written now) and the groups' targets. {@code freeOf}: free-pass cells per group. */
	record Split(long[] freePos, Value[] freeVals, List<Group> groups, Map<String, Long> freeOf) {
	}

	/**
	 * Splits a checked tile's cells by the evaluator's classes ({@code tile}: the ARTL v2 cells the check started from). A cell the
	 * check added (a felled tree, a dependent, a held leaf's neighbour) is not in the tile: the free pass.
	 */
	static Split split(Packed.Tile tile, InfraPlace.Check c, List<String> groupIds) {
		Long2IntOpenHashMap at = new Long2IntOpenHashMap(tile.size() * 2);
		at.defaultReturnValue(-1);
		for (int i = 0; i < tile.size(); i++) {
			at.put(tile.pos()[i], i);
		}
		byte[] cls = tile.cls();
		int[] grp = tile.group();
		List<Long> fp = new ArrayList<>();
		List<Value> fv = new ArrayList<>();
		Map<Integer, List<Integer>> byGroup = new TreeMap<>();
		Map<String, Long> freeOf = new TreeMap<>();
		long[] pos = c.positions();
		Value[] vals = c.values();
		for (int k = 0; k < pos.length; k++) {
			int i = at.get(pos[k]);
			if (i < 0 || cls == null || cls[i] == Packed.FREE) {
				fp.add(pos[k]);
				fv.add(vals[k]);
				if (i >= 0 && grp != null && grp[i] < groupIds.size()) {
					freeOf.merge(groupIds.get(grp[i]), 1L, Long::sum);
				}
				continue;
			}
			byGroup.computeIfAbsent(grp[i], x -> new ArrayList<>()).add(k);
		}
		List<Group> groups = new ArrayList<>();
		for (var e : byGroup.entrySet()) {
			List<Integer> ks = e.getValue();
			long[] gp = new long[ks.size()];
			Value[] gv = new Value[ks.size()];
			BitSet held = new BitSet();
			for (int j = 0; j < ks.size(); j++) {
				int k = ks.get(j);
				gp[j] = pos[k];
				gv[j] = vals[k];
				if (cls[at.get(pos[k])] == Packed.HELD) {
					held.set(j);
				}
			}
			String part = e.getKey() < groupIds.size() ? groupIds.get(e.getKey()) : "group" + e.getKey();
			groups.add(new Group(e.getKey(), part, gp, gv, held));
		}
		long[] fpa = new long[fp.size()];
		for (int i = 0; i < fpa.length; i++) {
			fpa[i] = fp.get(i);
		}
		return new Split(fpa, fv.toArray(new Value[0]), groups, freeOf);
	}

	// ------------------------------------------------------------------ the order and the runs

	/** A target's queue in build order (indexes into its cells) with its runs' ends and the cuts' dependencies. */
	record Order(int[] order, int[] ends, int[][] deps) {
	}

	/**
	 * The build order of a target's cells (§6.4): {@link BuildOrder} (bottom up; full, partial, attachables; pairs together), then each
	 * held cut (its target air) moved after every paid cell above it and beside it within 1 (a bore's roof lining before the carve under
	 * it, a terrace's retaining wall before the cut behind it). Runs (§6.2): a new run at each new y (a course) and whenever the run's bill
	 * would pass {@code capStacks} stacks (a quarter of the stockpile's capacity, cut now). {@code costs}: each cell's items (held: none).
	 */
	static Order order(long[] pos, BlockState[] st, BitSet held, List<List<SurvivalItems.Cost>> costs, int capStacks,
		java.util.function.ToIntFunction<String> maxStack) {
		int n = pos.length;
		Long2IntOpenHashMap at = new Long2IntOpenHashMap(n * 2);
		at.defaultReturnValue(-1);
		for (int i = 0; i < n; i++) {
			at.put(pos[i], i);
		}
		int[] y = new int[n], kind = new int[n], support = new int[n], pairOf = new int[n];
		for (int i = 0; i < n; i++) {
			BlockPos p = BlockPos.of(pos[i]);
			y[i] = p.getY();
			kind[i] = Builder.kind(st[i]);
			support[i] = -1;
			if (kind[i] == BuildOrder.ATTACHABLE) {
				int s = at.get(p.relative(Builder.supportDirection(st[i])).asLong());
				support[i] = s == i ? -1 : s;
			}
			pairOf[i] = -1;
			BlockState s = st[i];
			BlockPos first = null;
			if (s.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.DOUBLE_BLOCK_HALF) && s.getValue(
				net.minecraft.world.level.block.state.properties.BlockStateProperties.DOUBLE_BLOCK_HALF) == net.minecraft.world.level.block.state.properties.DoubleBlockHalf.UPPER) {
				first = p.below();
			} else if (s.getBlock() instanceof net.minecraft.world.level.block.BedBlock && s.getValue(net.minecraft.world.level.block.BedBlock.PART)
				== net.minecraft.world.level.block.state.properties.BedPart.HEAD) {
				first = p.relative(s.getValue(net.minecraft.world.level.block.BedBlock.FACING).getOpposite());
			}
			if (first != null) {
				int f = at.get(first.asLong());
				pairOf[i] = f >= 0 && st[f].is(s.getBlock()) ? f : -1;
			}
		}
		int[] base = BuildOrder.order(y, kind, support, pairOf);
		int[] rank = new int[n];
		for (int r = 0; r < n; r++) {
			rank[base[r]] = r;
		}
		// a held cut waits for the paid cells above and beside it within 1
		int[][] deps = new int[n][];
		long[] key = new long[n];
		for (int i = 0; i < n; i++) {
			key[i] = 2L * rank[i];
			if (!held.get(i) || !st[i].isAir()) {
				continue;
			}
			BlockPos p = BlockPos.of(pos[i]);
			List<Integer> d = new ArrayList<>();
			int latest = -1;
			for (int dy = 0; dy <= 1; dy++) {
				for (int dx = -1; dx <= 1; dx++) {
					for (int dz = -1; dz <= 1; dz++) {
						if (dx == 0 && dy == 0 && dz == 0) {
							continue;
						}
						int j = at.get(BlockPos.asLong(p.getX() + dx, p.getY() + dy, p.getZ() + dz));
						if (j >= 0 && !held.get(j)) {
							d.add(j);
							latest = Math.max(latest, rank[j]);
						}
					}
				}
			}
			if (!d.isEmpty()) {
				deps[i] = d.stream().mapToInt(Integer::intValue).toArray();
				if (latest > rank[i]) {
					key[i] = 2L * latest + 1;
				}
			}
		}
		Integer[] idx = new Integer[n];
		for (int i = 0; i < n; i++) {
			idx[i] = i;
		}
		java.util.Arrays.sort(idx, (a, b) -> key[a] != key[b] ? Long.compare(key[a], key[b]) : Integer.compare(rank[a], rank[b]));
		int[] order = new int[n];
		for (int r = 0; r < n; r++) {
			order[r] = idx[r];
		}
		// the runs: a course per y, cut by the bill cap
		List<Integer> ends = new ArrayList<>();
		Map<String, Integer> bill = new HashMap<>();
		int runY = Integer.MIN_VALUE;
		for (int r = 0; r < n; r++) {
			int i = order[r];
			Map<String, Integer> next = new HashMap<>(bill);
			for (SurvivalItems.Cost c : costs.get(i)) {
				next.merge(c.item(), c.count(), Integer::sum);
			}
			boolean newCourse = r > 0 && y[i] != runY;
			boolean over = r > 0 && !bill.isEmpty() && stacks(next, maxStack) > Math.max(1, capStacks);
			if (newCourse || over) {
				ends.add(r);
				bill.clear();
				next = new HashMap<>();
				for (SurvivalItems.Cost c : costs.get(i)) {
					next.merge(c.item(), c.count(), Integer::sum);
				}
			}
			bill = next;
			runY = y[i];
		}
		if (n > 0) {
			ends.add(n);
		}
		// (§4.3) a held cell is written with the paid ones: a run with no paid cell joins the next run that has one (the last such joins the
		// run before it), so no cut or fill of a part with a wall goes in before a paid course of it
		List<Integer> merged = new ArrayList<>();
		int from = 0;
		boolean pendingFree = false;
		for (int e : ends) {
			boolean paid = false;
			for (int r = from; r < e && !paid; r++) {
				paid = !costs.get(order[r]).isEmpty();
			}
			if (paid) {
				merged.add(e);
				pendingFree = false;
			} else {
				pendingFree = true;
			}
			from = e;
		}
		if (pendingFree) {
			if (merged.isEmpty()) {
				merged.add(n);
			} else {
				merged.set(merged.size() - 1, n);
			}
		}
		ends.clear();
		ends.addAll(merged);
		// the deps by queue index (the order's positions)
		int[] posOf = new int[n];
		for (int r = 0; r < n; r++) {
			posOf[order[r]] = r;
		}
		int[][] qdeps = new int[n][];
		for (int r = 0; r < n; r++) {
			int[] d = deps[order[r]];
			if (d != null) {
				qdeps[r] = java.util.Arrays.stream(d).map(j -> posOf[j]).toArray();
			}
		}
		return new Order(order, ends.stream().mapToInt(Integer::intValue).toArray(), qdeps);
	}

	/**
	 * (§6.4, the broken variant {@code _unsafe.carveFirst}'s check) The order position of the first held cut (its target air) that comes
	 * before a paid cell above it or beside it within 1 (a bore open before its lining), or -1 when every cut waits for them.
	 */
	static int firstUnsafeCut(long[] pos, BlockState[] st, BitSet held, int[] order) {
		int n = pos.length;
		Long2IntOpenHashMap at = new Long2IntOpenHashMap(n * 2);
		at.defaultReturnValue(-1);
		for (int i = 0; i < n; i++) {
			at.put(pos[i], i);
		}
		int[] rank = new int[n];
		for (int r = 0; r < n; r++) {
			rank[order[r]] = r;
		}
		for (int r = 0; r < n; r++) {
			int i = order[r];
			if (!held.get(i) || !st[i].isAir()) {
				continue;
			}
			BlockPos p = BlockPos.of(pos[i]);
			for (int dy = 0; dy <= 1; dy++) {
				for (int dx = -1; dx <= 1; dx++) {
					for (int dz = -1; dz <= 1; dz++) {
						int j = at.get(BlockPos.asLong(p.getX() + dx, p.getY() + dy, p.getZ() + dz));
						if (j >= 0 && j != i && !held.get(j) && rank[j] > r) {
							return r;
						}
					}
				}
			}
		}
		return -1;
	}

	/** A bill's size in stacks: sum over items of ceil(n / max stack). */
	static int stacks(Map<String, Integer> bill, java.util.function.ToIntFunction<String> maxStack) {
		int s = 0;
		for (var e : bill.entrySet()) {
			int m = Math.max(1, maxStack.applyAsInt(e.getKey()));
			s += (e.getValue() + m - 1) / m;
		}
		return s;
	}

	/** A quarter of the owner's stockpile capacity in stacks (§6.2, N-Y-1), at least 1; 16 crates' when it has none. */
	static int capStacks(MinecraftServer srv, @Nullable String owner) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		int cap = p == null ? StockLedger.STACKS_PER_CRATE * Stockpiles.MAX_CRATES : Stockpiles.capacity(srv, p);
		return Math.max(1, cap / 4);
	}

	/**
	 * The record of a group's target: a cell site of the region's owner (its box the cells' bounds), its construction (BUILDING, the queue
	 * in build order as box indexes, no crate: the owner's stockpile) and its spec (region, part, held cells over the queue, run ends).
	 */
	static Infra record(MinecraftServer srv, String id, String kind, @Nullable String owner, @Nullable JsonObject ext, Site.@Nullable Member member,
		String dimension, String regionId, Group g, String tile) {
		int n = g.pos().length;
		int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
		BlockState[] st = new BlockState[n];
		List<List<SurvivalItems.Cost>> costs = new ArrayList<>(n);
		for (int i = 0; i < n; i++) {
			BlockPos p = BlockPos.of(g.pos()[i]);
			x0 = Math.min(x0, p.getX());
			y0 = Math.min(y0, p.getY());
			z0 = Math.min(z0, p.getZ());
			x1 = Math.max(x1, p.getX());
			y1 = Math.max(y1, p.getY());
			z1 = Math.max(z1, p.getZ());
			st[i] = WorldJournal.state(g.vals()[i]);
			costs.add(g.held().get(i) ? List.of() : Cells.cost(dry(st[i])));
		}
		Anchors.Bounds box = new Anchors.Bounds(x0, y0, z0, x1, y1, z1);
		int cap = capStacks(srv, owner);
		Order o = order(g.pos(), st, g.held(), costs, cap, Stockpiles::maxStack);
		int dx = x1 - x0 + 1, dz = z1 - z0 + 1;
		int[] queue = new int[n];
		BitSet held = new BitSet();
		for (int r = 0; r < n; r++) {
			int i = o.order()[r];
			BlockPos p = BlockPos.of(g.pos()[i]);
			queue[r] = Construction.index(p.getX() - x0, p.getY() - y0, p.getZ() - z0, dx, dz);
			if (g.held().get(i)) {
				held.set(r);
			}
		}
		JsonObject rs = new JsonObject();
		rs.addProperty("region", regionId);
		rs.addProperty("part", g.part());
		rs.addProperty("group", g.group());
		rs.addProperty("tile", tile);
		rs.addProperty("held", CellBits.base64(held));
		rs.addProperty("heldCells", held.cardinality());
		JsonArray ends = new JsonArray();
		for (int e : o.ends()) {
			ends.add(e);
		}
		rs.add("runs", ends);
		rs.addProperty("capStacks", cap);
		JsonObject spec = new JsonObject();
		spec.addProperty("kind", kind);
		spec.addProperty("policy", dev.larattalabs.architect.journal.Journal.Policy.CELL.name());
		spec.addProperty("tile", tile);
		spec.add(SPEC, rs);
		JsonObject x = ext == null ? new JsonObject() : ext.deepCopy();
		x.addProperty(EXT_REGION, regionId);
		x.addProperty(EXT_PART, g.part());
		Construction c = new Construction(Construction.BUILDING, queue, Builder.JOURNAL_TARGET, null, new BitSet(), false, null);
		return new Infra(id, Infra.CELLS + kind, owner, x, dimension, box, System.currentTimeMillis(), member, true, spec, c);
	}

	static BlockState dry(BlockState s) {
		return s.hasProperty(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED) ? s.setValue(
			net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED, false) : s;
	}

	// ------------------------------------------------------------------ the run (RoadBuilder.run hands a target here)

	/** A new builder run of a target: the journal target, held cells free, the waterlogged states kept (the tile writes them so). */
	static Builder.@Nullable Run newRun(MinecraftServer srv, Infra i) {
		Cells target = SiteJournal.target(i.id(), i.box());
		if (target == null) {
			Architect.LOGGER.warn("Region target {}: its journal target can't be read; it can only be removed", i.id());
			return null;
		}
		Builder.Run r = new Builder.Run(RoadBuilder.probe(i), target);
		JsonObject rs = spec(i);
		r.name = "part " + (rs.has("part") ? rs.get("part").getAsString() : "?") + " of region " + (rs.has("region") ? rs.get("region").getAsString() : "?");
		BitSet held = CellBits.fromBase64(rs.has("held") ? rs.get("held").getAsString() : "");
		for (int q = 0; q < r.size(); q++) {
			int k = r.queue[q];
			if (k >= 0 && k < target.size()) {
				r.target[q] = target.states[k]; // waterlogged as written (water is free)
			}
			if (held.get(q)) {
				for (SurvivalItems.Cost c : r.cost.get(q)) {
					r.unbuilt.merge(c.item(), -c.count(), Integer::sum);
					r.bom.merge(c.item(), -c.count(), Integer::sum);
				}
				r.cost.set(q, List.of());
			}
		}
		r.unbuilt.values().removeIf(v -> v == 0);
		r.bom.values().removeIf(v -> v == 0);
		PLANS.put(i.id(), plan(i, r));
		ServerLevel level = Sites.levelOf(srv, i.dimension());
		if (level != null) {
			r.rescan(level);
			r.newlyCount = 0;
			r.resend = false;
		}
		return r;
	}

	/** The target's plan: held cells, run ends, the cuts' dependencies (computed again from the queue: the same rule). */
	private static Plan plan(Infra i, Builder.Run r) {
		JsonObject rs = spec(i);
		BitSet held = CellBits.fromBase64(rs.has("held") ? rs.get("held").getAsString() : "");
		int[] ends;
		if (rs.get("runs") instanceof JsonArray a && !a.isEmpty()) {
			ends = new int[a.size()];
			for (int k = 0; k < a.size(); k++) {
				ends[k] = a.get(k).getAsInt();
			}
		} else {
			ends = new int[] {r.size()};
		}
		int[][] deps = new int[r.size()][];
		Long2IntOpenHashMap at = new Long2IntOpenHashMap(r.size() * 2);
		at.defaultReturnValue(-1);
		for (int q = 0; q < r.size(); q++) {
			at.put(r.pos(q).asLong(), q);
		}
		for (int q = 0; q < r.size(); q++) {
			if (!held.get(q) || !r.target[q].isAir()) {
				continue;
			}
			BlockPos p = r.pos(q);
			List<Integer> d = new ArrayList<>();
			for (int dy = 0; dy <= 1; dy++) {
				for (int dx = -1; dx <= 1; dx++) {
					for (int dz = -1; dz <= 1; dz++) {
						if (dx == 0 && dy == 0 && dz == 0) {
							continue;
						}
						int j = at.get(BlockPos.asLong(p.getX() + dx, p.getY() + dy, p.getZ() + dz));
						if (j >= 0 && !held.get(j)) {
							d.add(j);
						}
					}
				}
			}
			if (!d.isEmpty()) {
				deps[q] = d.stream().mapToInt(Integer::intValue).toArray();
			}
		}
		return new Plan(i.placedAt(), held, ends, deps);
	}

	static @Nullable Plan planOf(MinecraftServer srv, Infra i) {
		Plan p = PLANS.get(i.id());
		if (p == null || p.placedAt != i.placedAt()) {
			Builder.Run r = RoadBuilder.run(srv, i);
			if (r == null) {
				return null;
			}
			p = PLANS.get(i.id());
			if (p == null || p.placedAt != i.placedAt()) {
				p = plan(i, r);
				PLANS.put(i.id(), p);
			}
		}
		return p;
	}

	static void forget(String id) {
		PLANS.remove(id);
	}

	/** The first run with an unbuilt cell (the current run), or -1 when every cell is built. */
	static int currentRun(Builder.Run r, Plan pl) {
		int q = r.built.nextClearBit(0);
		return q >= r.size() ? -1 : pl.runOf(q);
	}

	/** A run's unbuilt bill. */
	static Map<String, Integer> runBill(Builder.Run r, Plan pl, int run) {
		Map<String, Integer> out = new TreeMap<>();
		if (run < 0) {
			return out;
		}
		for (int q = pl.start(run); q < pl.ends[run]; q++) {
			if (!r.built.get(q)) {
				for (SurvivalItems.Cost c : r.cost.get(q)) {
					out.merge(c.item(), c.count(), Integer::sum);
				}
			}
		}
		return out;
	}

	/** (§6.2, S-Y-1) What a target reserves in its stockpile's feed: its current run's unbuilt bill. */
	static Map<String, Integer> reservation(MinecraftServer srv, Infra t, Builder.Run r) {
		Plan pl = planOf(srv, t);
		return pl == null ? r.unbuilt : runBill(r, pl, currentRun(r, pl));
	}

	/** Whether a run has started: one of its cells is built, or it began this session. */
	static boolean started(Builder.Run r, Plan pl, int run) {
		if (pl.started == run) {
			return true;
		}
		int s = pl.start(run);
		int q = r.built.nextSetBit(s);
		return q >= 0 && q < pl.ends[run];
	}

	/** Dev (the gate's item 6b): each run's bill in stacks and the cap, for a target. */
	public static @Nullable JsonObject runsJson(MinecraftServer srv, String id) {
		Infra i = Infras.get(id);
		if (!is(i)) {
			return null;
		}
		Builder.Run r = RoadBuilder.run(srv, i);
		Plan pl = r == null ? null : planOf(srv, i);
		JsonObject o = new JsonObject();
		o.addProperty("target", id);
		o.add("spec", spec(i).deepCopy());
		if (r == null || pl == null) {
			return o;
		}
		o.remove("spec");
		o.addProperty("cells", r.size());
		o.addProperty("built", r.built.cardinality());
		o.addProperty("held", pl.held.cardinality());
		o.addProperty("capStacks", spec(i).has("capStacks") ? spec(i).get("capStacks").getAsInt() : 0);
		JsonArray runs = new JsonArray();
		int maxStacks = 0;
		for (int k = 0; k < pl.ends.length; k++) {
			Map<String, Integer> bill = new TreeMap<>();
			for (int q = pl.start(k); q < pl.ends[k]; q++) {
				for (SurvivalItems.Cost c : r.cost.get(q)) {
					bill.merge(c.item(), c.count(), Integer::sum);
				}
			}
			int s = stacks(bill, Stockpiles::maxStack);
			maxStacks = Math.max(maxStacks, s);
			JsonObject x = new JsonObject();
			x.addProperty("from", pl.start(k));
			x.addProperty("to", pl.ends[k]);
			x.addProperty("stacks", s);
			x.addProperty("started", started(r, pl, k));
			runs.add(x);
		}
		o.addProperty("runs", pl.ends.length);
		o.addProperty("maxRunStacks", maxStacks);
		o.addProperty("currentRun", currentRun(r, pl));
		JsonObject res = new JsonObject();
		reservation(srv, i, r).forEach(res::addProperty);
		o.add("reserving", res);
		// the target's whole bill (its paid cells: what it put on the stockpile at put-down) and its wait (C25)
		JsonObject bom = new JsonObject();
		new TreeMap<>(r.bom).forEach((k, v) -> {
			if (v != 0) {
				bom.addProperty(k, v);
			}
		});
		o.add("bom", bom);
		o.add("wait", SiteWaits.json(SiteWaits.view(srv, id), Sites.levelOf(srv, i.dimension())));
		o.addProperty("paused", i.construction() != null && i.construction().paused());
		if (runs.size() <= 64) {
			o.add("runList", runs);
		}
		return o;
	}

	/**
	 * Dev (the gate's items 4 and 6): a target's queued cells as {@code [x, y, z, flags]} (1 held, 2 built now, 4 its target air: a cut),
	 * read from the world now (loaded chunks).
	 */
	public static @Nullable JsonObject cellsJson(MinecraftServer srv, String id) {
		Infra i = Infras.get(id);
		if (!is(i)) {
			return null;
		}
		Builder.Run r = RoadBuilder.run(srv, i);
		Plan pl = r == null ? null : planOf(srv, i);
		ServerLevel level = Sites.levelOf(srv, i.dimension());
		JsonObject o = new JsonObject();
		o.addProperty("target", id);
		o.addProperty("part", partOf(i));
		if (r == null || pl == null || level == null) {
			return o;
		}
		r.rescan(level, false, true);
		JsonArray a = new JsonArray();
		for (int q = 0; q < r.size(); q++) {
			BlockPos p = r.pos(q);
			JsonArray c = new JsonArray();
			c.add(p.getX());
			c.add(p.getY());
			c.add(p.getZ());
			c.add((pl.held.get(q) ? 1 : 0) | (r.built.get(q) ? 2 : 0) | (r.target[q].isAir() ? 4 : 0));
			a.add(c);
		}
		o.add("cells", a);
		return o;
	}

	// ------------------------------------------------------------------ the builder step (the stockpile's feed loop)

	/**
	 * One feed turn of a target: the current run starts only with its whole bill available, then builds bottom up, a cut after its
	 * paid neighbours, each cell written as the tile writes it. Only blockers stop a started run (a player or a mob in a cell, an
	 * unloaded chunk, a support not built yet), never materials: they are reserved.
	 */
	static void stepFed(MinecraftServer srv, ServerLevel level, Infra t, Builder.Run r, Builder.Purse purse, long ticks) {
		Plan pl = planOf(srv, t);
		if (pl == null) {
			return;
		}
		if (ticks % 20 == 0) {
			r.rescan(level, false, true);
		}
		Construction c = t.construction();
		if (r.built.cardinality() == r.size()) {
			RoadBuilder.complete(srv, level, t, r, null);
			return;
		}
		if (c.paused()) {
			SiteWaits.observe(srv, level, t.id(), WaitCalc.Outcome.ENDED);
			return;
		}
		int run = currentRun(r, pl);
		if (run < 0) {
			return;
		}
		// (§4.3, the half-built safety) a target with no paid cell (its part's cut or fill in a tile of its own) waits until every other
		// target of its part that has paid cells is BUILT: the part's walls, linings and shells stand before its free cells are written
		if (r.bom.isEmpty() && pl.started < 0 && r.built.isEmpty() && paidSiblingBuilding(t)) {
			SiteWaits.observe(srv, level, t.id(), WaitCalc.Outcome.IDLE);
			return;
		}
		if (!started(r, pl, run)) {
			Map<String, Integer> bill = runBill(r, pl, run);
			for (var e : bill.entrySet()) {
				if (purse.stock(e.getKey()) < e.getValue()) {
					SiteWaits.observe(srv, level, t.id(), WaitCalc.Outcome.STARVED); // C25: the run waits for its whole bill
					return;
				}
			}
			pl.started = run;
		}
		Cells before = null;
		int budget = SurvivalWorld.blocksPerTick();
		int placed = 0;
		boolean starved = false;
		for (int q = pl.start(run); q < pl.ends[run] && budget > 0 && (placed == 0 || Placement.remainingNanos() > 0); q++) {
			if (r.built.get(q)) {
				continue;
			}
			BlockPos p = r.pos(q);
			BlockState now = Builder.stateIfLoaded(level, p);
			if (now == null) {
				continue;
			}
			if (r.matches(now, q)) {
				r.markBuilt(q, true);
				continue;
			}
			int below = r.queuePos(p.below());
			if (below >= 0 && !r.built.get(below) || r.support[q] >= 0 && !r.built.get(r.support[q])) {
				continue;
			}
			int[] d = pl.deps == null ? null : pl.deps[q];
			if (d != null) {
				boolean ok = true;
				for (int j : d) {
					if (!r.built.get(j)) {
						ok = false;
						break;
					}
				}
				if (!ok) {
					continue;
				}
			}
			if (!r.affordable(q, purse::stock)) {
				starved = true;
				continue;
			}
			// the builder replaces what the tile planned to replace (its before), or air, a fluid, a plant
			if (before == null) {
				before = beforeOf(t, pl);
			}
			int k = r.queue[q];
			boolean planned = before != null && k >= 0 && k < before.size() && now.is(before.states[k].getBlock());
			if (!planned && !Builder.free(level, p, now, r.target[q])) {
				r.blockedSince.putIfAbsent(q, Builder.ticksNow());
				continue;
			}
			r.blockedSince.remove(q);
			purse.pay(r.cost.get(q));
			write(level, r, q, p);
			budget--;
			placed++;
		}
		if (placed > 0) {
			purse.changed();
		}
		SiteWaits.observe(srv, level, t.id(), placed > 0 ? WaitCalc.Outcome.PLACED : starved ? WaitCalc.Outcome.STARVED : WaitCalc.Outcome.IDLE);
		if (r.built.cardinality() == r.size()) {
			Infra now = Infras.get(t.id());
			if (now != null) {
				RoadBuilder.complete(srv, level, now, r, null);
			}
		}
	}

	/** The target entry's before over its box (read once per plan). */
	static @Nullable Cells beforeOf(Infra t, Plan pl) {
		if (pl.before == null) {
			var main = SiteJournal.main(t.id());
			pl.before = main == null ? null : SiteJournal.beforeOf(main.id(), t.box());
		}
		return pl.before;
	}

	/** Whether another target of the same region part, one with paid cells, is still building. */
	static boolean paidSiblingBuilding(Infra t) {
		String part = partOf(t), group = t.group();
		for (Infra o : Infras.all()) {
			if (o == t || !is(o) || !java.util.Objects.equals(group, o.group()) || !java.util.Objects.equals(part, partOf(o)) || !o.building()) {
				continue;
			}
			JsonObject rs = spec(o);
			int held = rs.has("heldCells") ? rs.get("heldCells").getAsInt() : 0;
			if (o.construction() != null && o.construction().size() > held) {
				return true;
			}
		}
		return false;
	}

	/** Writes queue cell {@code q} as the tile writes its cells: CELL_FLAGS (no neighbour updates, no onPlace), the entry's NBT. */
	static void write(ServerLevel level, Builder.Run r, int q, BlockPos p) {
		dev.larattalabs.architect.placed.Placed.set(level, p, r.target[q], Sites.CELL_FLAGS);
		CompoundTag tag = r.nbt[q];
		if (tag != null) {
			BlockEntity be = level.getBlockEntity(p);
			if (be != null) {
				be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), tag));
				be.setChanged();
			}
		}
		r.markBuilt(q, true);
	}

	/** {@code /architect site finish} and the dev hook for a target: the remaining cells, free (the dev and gate path only). */
	static int finish(MinecraftServer srv, ServerLevel level, Infra i, Builder.Run r) {
		int n = 0;
		for (int q = r.built.nextClearBit(0); q < r.size(); q = r.built.nextClearBit(q + 1)) {
			write(level, r, q, r.pos(q));
			n++;
		}
		RoadBuilder.complete(srv, level, i, r, null);
		return n;
	}

	// ------------------------------------------------------------------ crash: the free pass rescanned from the world (§10)

	/** Free-pass tile entries to rescan this session (filled at the world's start), and how many cells the rescans wrote again. */
	private static final java.util.ArrayDeque<String> RESCAN = new java.util.ArrayDeque<>();
	public static final java.util.concurrent.atomic.AtomicLong REWRITTEN = new java.util.concurrent.atomic.AtomicLong();
	public static final java.util.concurrent.atomic.AtomicLong RESCANNED = new java.util.concurrent.atomic.AtomicLong();

	static void init() {
		// queued a second after the start, once every record (sites, regions) has loaded
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTED.register(srv -> queueIn = 20);
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(RegionTargets::rescanTick);
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(srv -> {
			RESCAN.clear();
			PLANS.clear();
		});
	}

	/**
	 * (§10) At the world's start every free-pass tile entry of a survival region is queued for a rescan: a halt without a save may have
	 * lost chunks the region wrote (their entries ACTIVE, the world at its before); a free cell back at its before is written again (it is
	 * free). A target's cells need none of this: what is built is derived from the world, so a lost cell is simply unbuilt again.
	 */
	static void queueRescans(MinecraftServer srv) {
		RESCAN.clear();
		for (Infra i : Infras.all()) {
			if (is(i) || i.road() || i.group() == null || !i.spec().has("tile")) {
				continue;
			}
			SiteGroupRec g = Sites.group(i.group());
			String region = g == null || !g.ext().has(RegionItems.EXT_REGION) ? null : g.ext().get(RegionItems.EXT_REGION).getAsString();
			var l = region == null ? null : dev.larattalabs.architect.region.RegionsImpl.live(region);
			if (l != null && l.rec().survival() && l.rec().state != dev.larattalabs.architect.api.RegionState.REMOVING) {
				RESCAN.add(i.id());
			}
		}
		if (!RESCAN.isEmpty()) {
			Architect.LOGGER.info("Survival regions: {} free-pass tile entr{} to rescan against the world", RESCAN.size(), RESCAN.size() == 1 ? "y" : "ies");
		}
	}

	private static int queueIn = -1;

	private static void rescanTick(MinecraftServer srv) {
		if (queueIn > 0 && --queueIn == 0) {
			queueIn = -1;
			queueRescans(srv);
		}
		long end = System.nanoTime() + 2_000_000L;
		while (!RESCAN.isEmpty() && System.nanoTime() < end) {
			String id = RESCAN.poll();
			Infra i = Infras.get(id);
			ServerLevel level = i == null ? null : Sites.levelOf(srv, i.dimension());
			if (level == null || i.placing()) {
				continue;
			}
			int n = rescanFree(level, i);
			RESCANNED.incrementAndGet();
			if (n > 0) {
				Architect.LOGGER.warn("Survival region tile {}: {} free cell(s) were not in the world (a halt without a save): written again", id, n);
			}
		}
	}

	/** Writes again every free-pass cell of a tile entry that the world holds at its before (not its after). Returns how many. */
	static int rescanFree(ServerLevel level, Infra i) {
		var s = WorldJournal.storeOrNull();
		var m = SiteJournal.main(i.id());
		if (s == null || m == null || !m.active()) {
			return 0;
		}
		int n = 0;
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		try {
			for (long k : m.sections()) {
				var sc = s.section(m.id(), k);
				if (sc == null) {
					continue;
				}
				for (int c = 0; c < sc.size(); c++) {
					Value after = sc.after(c);
					long p = sc.pos(c);
					if (after == null || WorldJournal.holds(level, p, after) || !WorldJournal.holds(level, p, sc.before(c))) {
						continue;
					}
					mp.set(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p));
					dev.larattalabs.architect.placed.Placed.set(level, mp, WorldJournal.state(after), Sites.CELL_FLAGS);
					if (after.nbt() != null && level.getBlockEntity(mp) instanceof BlockEntity be) {
						be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), after.nbt()));
						be.setChanged();
					}
					n++;
				}
			}
		} catch (java.io.IOException e) {
			Architect.LOGGER.warn("Survival region tile {}: its entry could not be read for the rescan: {}", i.id(), e.toString());
		}
		REWRITTEN.addAndGet(n);
		return n;
	}

	// ------------------------------------------------------------------ the region's view of its targets

	/** One target's counts for {@code RegionView.build}: cells (held + paid), built, paid cells and paid built, its state. */
	public record Counts(String id, String part, int cells, int built, int paid, int paidBuilt, boolean done, boolean startedAny, Map<String, Integer> outstanding) {
	}

	/** The counts of every target of a group (a region's), in feed order of creation. */
	public static List<Counts> counts(MinecraftServer srv, String groupId) {
		List<Counts> out = new ArrayList<>();
		for (Infra i : Infras.all()) {
			if (!is(i) || !groupId.equals(i.group())) {
				continue;
			}
			Construction c = i.construction();
			String part = partOf(i);
			JsonObject rs = spec(i);
			int held = rs.has("heldCells") ? rs.get("heldCells").getAsInt() : 0;
			int size = c == null ? 0 : c.size();
			if (c == null || !c.building()) {
				out.add(new Counts(i.id(), part, size, size, size - held, size - held, true, true, Map.of()));
				continue;
			}
			Builder.Run r = RoadBuilder.run(srv, i);
			if (r == null) {
				out.add(new Counts(i.id(), part, size, 0, size - held, 0, false, false, Map.of()));
				continue;
			}
			Plan pl = planOf(srv, i);
			int paidBuilt = 0;
			for (int q = r.built.nextSetBit(0); q >= 0; q = r.built.nextSetBit(q + 1)) {
				if (pl == null || !pl.held.get(q)) {
					paidBuilt++;
				}
			}
			Map<String, Integer> o = new TreeMap<>();
			r.unbuilt.forEach((k, v) -> {
				if (v > 0) {
					o.put(k, v);
				}
			});
			out.add(new Counts(i.id(), part, r.size(), r.built.cardinality(), r.size() - (pl == null ? held : pl.held.cardinality()), paidBuilt, false,
				r.built.cardinality() > 0 || pl != null && pl.started >= 0, o));
		}
		out.sort(java.util.Comparator.comparing(Counts::id, java.util.Comparator.comparingInt(RegionTargets::idNum)));
		return out;
	}

	static int idNum(String id) {
		try {
			return Integer.parseInt(id.substring(1));
		} catch (RuntimeException e) {
			return Integer.MAX_VALUE;
		}
	}

	/** Every building target of a group, by id. */
	public static List<String> building(String groupId) {
		List<String> out = new ArrayList<>();
		for (Infra i : Infras.all()) {
			if (is(i) && groupId.equals(i.group()) && i.building()) {
				out.add(i.id());
			}
		}
		return out;
	}

	/** (6c RS) A group's first lot (a construction site) or construction road still building, or null. */
	public static @Nullable String buildingMember(String groupId) {
		for (Site s : Sites.all()) {
			if (groupId.equals(s.group()) && s.building()) {
				return s.id();
			}
		}
		for (Infra i : Infras.all()) {
			if (groupId.equals(i.group()) && i.building() && !is(i)) {
				return i.id();
			}
		}
		return null;
	}

	/** Test and dev: whether a group still has building targets. */
	public static boolean anyBuilding(String groupId) {
		return !building(groupId).isEmpty();
	}

	// ------------------------------------------------------------------ the stage waits (§6.3)

	/** The ext key a region item waiting for an earlier target carries: {@code {target, part}} (ITEM_WAITING's ext, S-RS-1). */
	public static final String EXT_WAITS_FOR = "architect_mc:waitsFor";

	/**
	 * (§6.3) Whether a survival region's item must wait for an earlier target to be built (then it waits SITE_BUSY, naming the target and
	 * its part in its ext, and ITEM_WAITING fires). A tile waits for every earlier stage's target within one tile (a path tile also for
	 * its own stage's terrain targets: it layers over them), a lot or a road for those under its box + 8; a fluids-stage tile also for the
	 * region's lots (irrigation's sources after their lot is BUILT). Construction roads of earlier stages count as targets.
	 */
	static boolean stageWait(MinecraftServer srv, dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i) {
		String region = RegionItems.regionOf(b);
		var l = region == null ? null : dev.larattalabs.architect.region.RegionsImpl.live(region);
		if (l == null || !l.rec().survival()) {
			return false;
		}
		List<String> stages = new ArrayList<>(l.rec().stages.keySet());
		int si = stages.indexOf(i.stage);
		if (si < 0) {
			return false;
		}
		int[] roi = roi(l, i);
		if (roi == null) {
			return false;
		}
		boolean pathTile = "tile".equals(i.itemKind) && i.spec != null && "path".equals(i.spec.get("set").getAsString());
		boolean fluids = dev.larattalabs.architect.region.RegionFluids.STAGE.equals(i.stage);
		String group = l.rec().groupId;
		for (Infra t : Infras.all()) {
			if (!group.equals(t.group()) || !t.building() || t.placing() || !(is(t) || t.road())) {
				continue;
			}
			var tm = t.member();
			var ti = tm == null || tm.itemKey() == null ? null : b.item(tm.itemKey());
			int ts = ti == null ? -1 : stages.indexOf(ti.stage);
			boolean earlier = ts >= 0 && (ts < si || ts == si && pathTile && ti != null && "tile".equals(ti.itemKind) && ti.spec != null && "terrain".equals(ti.spec
				.get("set").getAsString()));
			if (!earlier || !meets(t.box(), roi)) {
				continue;
			}
			waitOn(b, i, t.id(), is(t) ? partOf(t) : "road " + t.id());
			return true;
		}
		if (fluids) {
			for (Site s : Sites.all()) {
				if (group.equals(s.group()) && s.building() && !s.placing() && meets(s.box(), roi)) {
					waitOn(b, i, s.id(), "lot " + s.id());
					return true;
				}
			}
		}
		if (i.ext.has(EXT_WAITS_FOR)) {
			i.ext.remove(EXT_WAITS_FOR);
		}
		return false;
	}

	private static void waitOn(dev.larattalabs.architect.batch.QBatch b, dev.larattalabs.architect.batch.QItem i, String target, @Nullable String part) {
		JsonObject w = new JsonObject();
		w.addProperty("target", target);
		if (part != null) {
			w.addProperty("part", part);
		}
		i.ext.add(EXT_WAITS_FOR, w);
		Batches.waitFor(b, i, dev.larattalabs.architect.api.Reason.SITE_BUSY, "waits for " + (part == null ? target : part + " (" + target + ")")
			+ " to be built: a survival region builds what stands on a part only once it is built");
	}

	/** An item's region of interest [x0, z0, x1, z1]: a tile's columns and one tile around; a lot's or a road's box + 8. */
	private static int @Nullable [] roi(dev.larattalabs.architect.region.RegionsImpl.Live l, dev.larattalabs.architect.batch.QItem i) {
		if ("tile".equals(i.itemKind) && i.spec != null) {
			int[] t = dev.larattalabs.architect.region.Ir.tile(i.spec.get("tile").getAsString());
			int T = dev.larattalabs.architect.region.Heights.TILE;
			return new int[] {T * t[0] - T, T * t[1] - T, T * t[0] + 2 * T - 1, T * t[1] + 2 * T - 1};
		}
		if (i.key.startsWith("lot:")) {
			for (var lot : l.ir().lots()) {
				if (i.key.equals("lot:" + lot.id())) {
					int[] bx = lot.box();
					return new int[] {bx[0] - 8, bx[2] - 8, bx[3] + 8, bx[5] + 8};
				}
			}
			return null;
		}
		if (i.key.startsWith("road:")) {
			for (var road : l.ir().roads()) {
				if (i.key.equals("road:" + road.id())) {
					int x0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
					for (int[] p : road.points()) {
						x0 = Math.min(x0, p[0]);
						z0 = Math.min(z0, p[2]);
						x1 = Math.max(x1, p[0]);
						z1 = Math.max(z1, p[2]);
					}
					return new int[] {x0 - 8 - road.width(), z0 - 8 - road.width(), x1 + 8 + road.width(), z1 + 8 + road.width()};
				}
			}
		}
		return null;
	}

	private static boolean meets(Anchors.Bounds b, int[] r) {
		return b.minX() <= r[2] && r[0] <= b.maxX() && b.minZ() <= r[3] && r[1] <= b.maxZ();
	}

	// ------------------------------------------------------------------ RegionView.build (§8, §12, S-RS-1, S-RS-3)

	/**
	 * A survival region's build: its tile targets, lots (construction sites) and 4e roads (construction roads) per plan part, the paid
	 * cells built over the paid cells, what they still need, built (every one BUILT and the batch's items all put down) and done (built and
	 * PLACED). Null for a creative region or before the server runs. Server thread.
	 */
	public static dev.larattalabs.architect.api.@Nullable RegionBuild build(dev.larattalabs.architect.region.RegionsImpl.Live l) {
		var rec = l.rec();
		MinecraftServer srv = Batches.serverOf();
		if (!rec.survival() || srv == null) {
			return null;
		}
		String group = rec.groupId;
		List<String> groupIds = dev.larattalabs.architect.region.RegionsImpl.survivalGroups(l);
		JsonObject irSv = l.ir().json().get("survival") instanceof JsonObject o ? o : new JsonObject();
		JsonObject partsMap = irSv.get("parts") instanceof JsonObject o ? o : new JsonObject();
		java.util.function.Function<String, String> planPartOf = (irPart) -> {
			if (irPart == null || !partsMap.has(irPart)) {
				return irPart == null ? "?" : irPart;
			}
			int g = partsMap.get(irPart).getAsInt();
			return g >= 0 && g < groupIds.size() ? groupIds.get(g) : irPart;
		};
		final class Acc {
			final List<String> targets = new ArrayList<>();
			long cells;
			long built;
			boolean anyBuilt;
			boolean allDone = true;
		}
		Map<String, Acc> parts = new LinkedHashMap<>();
		Map<String, Integer> outstanding = new TreeMap<>();
		long paid = 0, paidBuilt = 0;
		boolean anyBuilding = false;
		for (Counts c : counts(srv, group)) {
			Acc a = parts.computeIfAbsent(c.part() == null ? "?" : c.part(), k -> new Acc());
			a.targets.add(c.id());
			a.cells += c.cells();
			a.built += c.built();
			a.anyBuilt |= c.built() > 0 || c.startedAny();
			a.allDone &= c.done();
			paid += c.paid();
			paidBuilt += c.paidBuilt();
			anyBuilding |= !c.done();
			c.outstanding().forEach((k, v) -> outstanding.merge(k, v, Integer::sum));
		}
		// the lots (construction sites) and the 4e roads (construction roads), under their pad's and road's part
		Map<String, String> lotPart = new java.util.HashMap<>();
		for (var lot : l.ir().lots()) {
			lotPart.put(lot.id(), planPartOf.apply(lot.part()));
		}
		for (Site s : Sites.all()) {
			if (!group.equals(s.group()) || s.construction() == null) {
				continue;
			}
			String lotId = s.ext().has("architect_mc:lot") ? s.ext().get("architect_mc:lot").getAsString() : null;
			Acc a = parts.computeIfAbsent(lotId == null ? "lots" : lotPart.getOrDefault(lotId, "lots"), k -> new Acc());
			int[] pr = Builder.progress(srv, s);
			a.targets.add(s.id());
			a.cells += pr[1];
			a.built += pr[0];
			a.anyBuilt |= pr[0] > 0;
			boolean done = !s.building();
			a.allDone &= done;
			paid += pr[1];
			paidBuilt += pr[0];
			anyBuilding |= !done;
			if (!done) {
				Builder.Run r = Builder.run(srv, s);
				if (r != null) {
					r.unbuilt.forEach((k, v) -> {
						if (v > 0) {
							outstanding.merge(k, v, Integer::sum);
						}
					});
				}
			}
		}
		for (Infra i : Infras.all()) {
			if (!group.equals(i.group()) || !i.road() || i.construction() == null) {
				continue;
			}
			String roadPart = null;
			for (var road : l.ir().roads()) {
				if (i.member() != null && ("road:" + road.id()).equals(i.member().itemKey())) {
					roadPart = road.id();
				}
			}
			Acc a = parts.computeIfAbsent(roadPart == null ? "roads" : roadPart, k -> new Acc());
			int[] pr = RoadBuilder.progress(srv, i);
			a.targets.add(i.id());
			a.cells += pr[1];
			a.built += pr[0];
			a.anyBuilt |= pr[0] > 0;
			boolean done = !i.building();
			a.allDone &= done;
			paid += pr[1];
			paidBuilt += pr[0];
			anyBuilding |= !done;
			if (!done) {
				Builder.Run r = RoadBuilder.run(srv, i);
				if (r != null) {
					r.unbuilt.forEach((k, v) -> {
						if (v > 0) {
							outstanding.merge(k, v, Integer::sum);
						}
					});
				}
			}
		}
		JsonObject freeCells = rec.survival.get("freeCells") instanceof JsonObject o ? o : new JsonObject();
		List<dev.larattalabs.architect.api.PartBuild> out = new ArrayList<>();
		parts.forEach((part, a) -> out.add(new dev.larattalabs.architect.api.PartBuild(part, a.allDone ? "built" : a.anyBuilt ? "building" : "waiting", a.targets,
			a.cells, a.built, freeCells.has(part) ? freeCells.get(part).getAsLong() : 0L)));
		// parts with only free cells (nothing to build) are not listed; their free cells are in the record
		var b = Batches.get(rec.batchId);
		boolean itemsDown = b == null || b.items.stream().allMatch(x -> x.status.terminal());
		boolean built = !anyBuilding && itemsDown;
		boolean done = built && rec.state == dev.larattalabs.architect.api.RegionState.PLACED;
		double percent = paid == 0 ? 100.0 : Math.floor(paidBuilt * 1000.0 / paid) / 10.0;
		Map<net.minecraft.world.item.Item, Integer> items = new LinkedHashMap<>();
		outstanding.forEach((k, v) -> {
			var it = Cells.item(k);
			if (it != null) {
				items.merge(it, v, Integer::sum);
			}
		});
		return new dev.larattalabs.architect.api.RegionBuild(built, done, percent, items, out);
	}

	/** The DevBridge's and the gate's view of a survival region's build (RegionBuild, by item id). */
	public static @Nullable JsonObject buildJson(dev.larattalabs.architect.region.RegionsImpl.Live l) {
		var bld = build(l);
		if (bld == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		o.addProperty("built", bld.built());
		o.addProperty("done", bld.done());
		o.addProperty("percent", bld.percent());
		JsonObject out = new JsonObject();
		bld.outstanding().forEach((k, v) -> out.addProperty(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(k).toString(), v));
		o.add("outstanding", out);
		JsonArray parts = new JsonArray();
		for (var p : bld.parts()) {
			JsonObject x = new JsonObject();
			x.addProperty("part", p.part());
			x.addProperty("state", p.state());
			JsonArray t = new JsonArray();
			p.targets().forEach(t::add);
			x.add("targets", t);
			x.addProperty("cells", p.cells());
			x.addProperty("built", p.built());
			x.addProperty("freeCells", p.freeCells());
			parts.add(x);
		}
		o.add("parts", parts);
		return o;
	}

	/** The member keys a region's targets were put down by (their tile items): for the stage waits. */
	static Map<String, List<Infra>> byItem(String groupId) {
		Map<String, List<Infra>> out = new LinkedHashMap<>();
		for (Infra i : Infras.all()) {
			if (is(i) && groupId.equals(i.group()) && i.member() != null && i.member().itemKey() != null) {
				out.computeIfAbsent(i.member().itemKey(), k -> new ArrayList<>()).add(i);
			}
		}
		return out;
	}
}
