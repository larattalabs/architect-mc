package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Copper;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.BuildOrder;
import dev.larattalabs.architect.survival.Equivalents;
import dev.larattalabs.architect.survival.Ledger;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.item.HoneycombItem;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.WallTorchBlock;
import net.minecraft.world.level.block.WeatheringCopper;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.DoubleBlockHalf;
import org.jspecify.annotations.Nullable;

/**
 * The survival ledger lint's simulator (docs/FAST-CHECKS.md "5. Survival ledger lint"; test code). One stockpile and several construction
 * targets over an in-memory world, driven by a list of events: inserts, feed passes, a player mining, placing their own block or standing
 * in a target, vanilla weathering (the vanilla-updates table shared with UMT, {@link UmtVanilla}), deltas and reverts, adoption, pausing,
 * unloading, removals that wait (C29) and stage removals, restarts, retried credits, withdrawals, a crate gone and a dissolve.
 *
 * <p><b>Real (production code, as the mod calls it):</b> {@link StockLedger} (accept, consume, credit once, giveBack, withdraw, drop,
 * the identity, capacity in stacks, toJson/fromJson), {@link Builder.Run} (the queue's costs through {@code Cells.cost}, {@code matches}
 * with the copper chain, {@code refundCost}, {@code affordable}, supports and pairs, {@code unbuilt}), {@link BuildOrder#order},
 * {@link Stockpiles#feedPass} (the feed pass's order of decisions: C29's leaving, the reservation, S-Y-1 through
 * {@link FeedOrder#reserves}), {@link FeedOrder#setFront}, {@link Builder#tallyCell} (a deconstruct's per-cell decision:
 * {@link Refunds#classify}, the CU standing-block refund, PT2's adopted rule), {@link Builder#refundRemoved} (a delta's removed cell),
 * {@link RoadBuilder#freeOff} (the free-conversion set off a road's bill), {@link Stockpiles#excess} (a crate gone),
 * {@link Stockpiles#dissolveLedger}.
 *
 * <p><b>Modelled (each calibrated by the release-tier ledger probe, gate step {@code p3-probe-ledger}):</b> the builder step's placement
 * loop (Builder.step: scan order, affordable, supports, pairs, a free cell, a blocker), the removal's sequencing (leave the feed, wait for
 * the player, restore, credit at the restore once), the delta's queue (a changed cell is removed and re-added; swaps are not modelled:
 * DeltaPropertyTest and 5b-chains own them), adoption's records.
 *
 * <p><b>Independent expectations (never read from the production result they judge):</b> per item, every unit delivered is in stock,
 * standing in a paid cell (at the block standing: weathering converts it, recorded), with the player (withdrawn, mined), on the ground
 * (dropped, overflow, the player's own blocks) or standing as the player's block; a refund is the items of the paid blocks standing; a
 * delta pays the added cells only and refunds the paid removed cells only; the reservation after a pass is the unbuilt cost of the
 * targets that reserve; a leaving target consumes nothing; weathering re-queues and charges nothing; the credited keys are exactly the
 * removals that ended.
 */
final class LedgerSim {
	static final int FLOOR = 64;
	static final String OWNER = "lint:owner";
	static final Equivalents EQ = Equivalents.bundled();
	static final BlockState AIR = Blocks.AIR.defaultBlockState();

	// ------------------------------------------------------------------ the world

	final Map<Long, BlockState> world = new HashMap<>();

	BlockState at(long p) {
		BlockState s = world.get(p);
		if (s != null) {
			return s;
		}
		int y = BlockPos.getY(p);
		return y >= FLOOR ? AIR : y == FLOOR - 1 ? Blocks.GRASS_BLOCK.defaultBlockState() : Blocks.DIRT.defaultBlockState();
	}

	BlockState at(BlockPos p) {
		return at(p.asLong());
	}

	// ------------------------------------------------------------------ the stockpile

	StockLedger ledger = new StockLedger();
	int crates = 2;
	boolean dissolved;
	/** Toggle: the stockpile's capacity may be exceeded only right after a crate went and before its excess dropped (none here). */
	int cap() {
		return crates * StockLedger.STACKS_PER_CRATE;
	}

	/**
	 * Max stack sizes (modelled: {@code Stockpiles.maxStack} reads an ItemStack, whose components are bound only in a running server):
	 * vanilla's 16 for buckets, signs, eggs, snowballs, banners and ender pearls, 1 for a filled bucket, else 64 (every item the designs
	 * use). StockpileTest's MAX is the same kind of table.
	 */
	static int maxStack(String item) {
		if (item.endsWith("_bucket") && !item.equals("minecraft:bucket")) {
			return 1;
		}
		return item.equals("minecraft:bucket") || item.endsWith("_sign") || item.endsWith("_banner") || item.endsWith("egg") || item.equals("minecraft:snowball")
			|| item.equals("minecraft:ender_pearl") ? 16 : 64;
	}

	// ------------------------------------------------------------------ the targets

	static final class Tgt {
		final String id;
		final String design;
		final long placedAt;
		final Anchors.Bounds box;
		Map<Long, BlockState> target;
		final Map<Long, BlockState> before = new HashMap<>();
		BitSet free = new BitSet();
		Builder.@Nullable Run run;
		boolean paused;
		boolean leaving;
		boolean unloaded;
		boolean blocked;
		boolean road;
		boolean adopted;
		boolean removed;
		int deltas;
		/** Model: the cells whose block the stockpile paid for and that stand (cleared when mined or removed). */
		final Set<Long> paid = new HashSet<>();
		/** Model: a delta's bill (the cost of the cells it queued) and what was consumed for the target since. */
		@Nullable Map<String, Integer> deltaBill;
		final Map<String, Integer> consumedSince = new TreeMap<>();
		/** Model: everything consumed for this target. */
		final Map<String, Integer> consumed = new TreeMap<>();
		/** Cells the target's deltas wrote (an adopted target's removal writes only those, PT2). */
		final Set<Long> deltaCells = new HashSet<>();
		/** The adopted state of a delta cell (what an adopted target's removal writes back). */
		final Map<Long, BlockState> adoptedState = new HashMap<>();

		Tgt(String id, String design, long placedAt, Anchors.Bounds box) {
			this.id = id;
			this.design = design;
			this.placedAt = placedAt;
			this.box = box;
		}

		String key() {
			return "site:" + id + "@" + placedAt;
		}
	}

	final Map<String, Tgt> targets = new LinkedHashMap<>();
	List<String> order = new ArrayList<>();
	long clock = 1000;

	// ------------------------------------------------------------------ the model's accounts (independent of the production result)

	/** Units that came in (delivered: the item the ledger counts). */
	final Map<String, Integer> in = new TreeMap<>();
	/** Units with a player: withdrawn, mined, a dissolve into the inventory. */
	final Map<String, Integer> player = new TreeMap<>();
	/** Units on the ground: dropped, refund overflow, a bucket's overflow, the player's own blocks dropped at a deconstruct. */
	final Map<String, Integer> ground = new TreeMap<>();
	/** Weathering's conversions of standing paid blocks: + the item now, - the item before. */
	final Map<String, Integer> conv = new TreeMap<>();
	/** The player's own blocks standing in a target's cells (their items came in as the player's). */
	final Map<Long, BlockState> foreign = new HashMap<>();
	/** The credit keys the model expects booked. */
	final Set<String> keys = new LinkedHashSet<>();

	final List<String> violations = new ArrayList<>();
	final Map<String, Integer> findings = new TreeMap<>();
	final List<String> log = new ArrayList<>();
	/** The vanilla-table rows this simulator applied (counted per id). */
	final Map<String, Integer> fired = new TreeMap<>();
	/** The last feed pass's reservation (production's feedPass result). */
	Map<String, Integer> lastReserved = Map.of();

	static void add(Map<String, Integer> m, String k, int n) {
		if (n == 0) {
			return;
		}
		int v = m.getOrDefault(k, 0) + n;
		if (v == 0) {
			m.remove(k);
		} else {
			m.put(k, v);
		}
	}

	static void addAll(Map<String, Integer> m, Map<String, Integer> items, int sign) {
		items.forEach((k, v) -> add(m, k, sign * v));
	}

	static Map<String, Integer> costs(BlockState s) {
		Map<String, Integer> out = new TreeMap<>();
		for (SurvivalItems.Cost c : Cells.cost(s)) {
			add(out, c.item(), c.count());
		}
		return out;
	}

	void violation(String rule, String msg) {
		violations.add("[" + rule + "] " + msg);
	}

	void finding(String id, String msg) {
		findings.merge(id, 1, Integer::sum);
		log.add("finding " + id + ": " + msg);
	}

	// ------------------------------------------------------------------ designs

	/** A design's states at their offsets in its box (dx 5, dy 5, dz 5 for the buildings; a road is one row). */
	static Map<int[], BlockState> design(String name) {
		Map<int[], BlockState> d = new LinkedHashMap<>();
		BlockState planks = Blocks.OAK_PLANKS.defaultBlockState();
		BlockState cobble = Blocks.COBBLESTONE.defaultBlockState();
		switch (name) {
			case "hut", "hut2" -> {
				for (int x = 0; x < 5; x++) {
					for (int z = 0; z < 5; z++) {
						d.put(new int[] {x, 0, z}, planks);
						boolean wall = x == 0 || z == 0 || x == 4 || z == 4;
						for (int y = 1; y <= 2 && wall; y++) {
							d.put(new int[] {x, y, z}, cobble);
						}
						d.put(new int[] {x, 3, z}, "hut2".equals(name) && (x + z) % 2 == 0 ? Blocks.COPPER_BLOCK.asList().get(0).defaultBlockState() : Blocks.CUT_COPPER.asList().get(0).defaultBlockState());
					}
				}
				// a door in the south wall (a pair: its upper half costs nothing) and a wall torch on the north wall's inside
				BlockState door = Blocks.OAK_DOOR.defaultBlockState().setValue(DoorBlock.FACING, Direction.SOUTH);
				d.put(new int[] {2, 1, 4}, door.setValue(DoorBlock.HALF, DoubleBlockHalf.LOWER));
				d.put(new int[] {2, 2, 4}, door.setValue(DoorBlock.HALF, DoubleBlockHalf.UPPER));
				d.put(new int[] {2, 2, 1}, Blocks.WALL_TORCH.defaultBlockState().setValue(WallTorchBlock.FACING, Direction.SOUTH));
				if ("hut2".equals(name)) {
					d.put(new int[] {2, 4, 2}, Blocks.LIGHTNING_ROD.asList().get(0).defaultBlockState());
				}
			}
			case "storey" -> {
				// the hut with a storey added (a delta of hut: its roof stays, walls and a roof over it)
				d.putAll(design("hut"));
				for (int x = 0; x < 5; x++) {
					for (int z = 0; z < 5; z++) {
						if (x == 0 || z == 0 || x == 4 || z == 4) {
							d.put(new int[] {x, 4, z}, planks);
						}
					}
				}
			}
			case "hatch" -> {
				// the hut with its roof's middle cell removed (a hatch) and a ladder: a delta that removes a paid (or adopted) block
				for (var e : design("hut").entrySet()) {
					int[] o = e.getKey();
					if (!(o[0] == 2 && o[1] == 3 && o[2] == 2)) {
						d.put(o, e.getValue());
					}
				}
			}
			case "shed" -> {
				for (int x = 0; x < 5; x++) {
					for (int z = 0; z < 5; z++) {
						d.put(new int[] {x, 0, z}, Blocks.COPPER_BLOCK.asList().get(0).defaultBlockState());
						if (x == 0 || z == 0 || x == 4 || z == 4) {
							d.put(new int[] {x, 1, z}, Blocks.CUT_COPPER.asList().get(0).defaultBlockState());
						}
						d.put(new int[] {x, 2, z}, Blocks.CUT_COPPER_STAIRS.asList().get(0).defaultBlockState());
					}
				}
			}
			case "farm" -> {
				for (int x = 0; x < 5; x++) {
					for (int z = 0; z < 3; z++) {
						d.put(new int[] {x, 0, z}, x == 2 && z == 1 ? cobble : Blocks.FARMLAND.defaultBlockState());
					}
				}
			}
			default -> throw new IllegalArgumentException("design " + name);
		}
		return d;
	}

	// ------------------------------------------------------------------ placing a target

	int nextX = 0;

	Anchors.Bounds nextBox(int dx, int dy, int dz, int y) {
		int x0 = nextX;
		nextX += dx + 3;
		return new Anchors.Bounds(x0, y, 0, x0 + dx - 1, y + dy - 1, dz - 1);
	}

	/** A building target of {@code design}: its box, its target, its run (nothing built yet). */
	Tgt place(String id, String design) {
		Anchors.Bounds box = nextBox(5, 5, 5, FLOOR);
		Tgt t = new Tgt(id, design, clock++, box);
		Map<Long, BlockState> target = new HashMap<>();
		for (var e : design(design).entrySet()) {
			int[] o = e.getKey();
			target.put(BlockPos.asLong(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]), e.getValue());
		}
		t.target = target;
		for (long p : boxCells(box)) {
			t.before.put(p, at(p));
		}
		targets.put(id, t);
		FeedOrder.insert(order, id, FeedOrder.Origin.NONE, x -> FeedOrder.Origin.NONE);
		t.run = runOf(t);
		rescan(t);
		return t;
	}

	/**
	 * A construction road: one row at the ground's level (y 63), its cells a dirt path where the ground is soil (free, RoadBuilder's
	 * rule) and gravel where it is sand; the sand cells are set first.
	 */
	Tgt placeRoad(String id, int len) {
		Anchors.Bounds box = nextBox(len, 1, 1, FLOOR - 1);
		BlockState[] soils = {Blocks.GRASS_BLOCK.defaultBlockState(), Blocks.DIRT.defaultBlockState(), Blocks.COARSE_DIRT.defaultBlockState(),
			Blocks.PODZOL.defaultBlockState(), Blocks.MYCELIUM.defaultBlockState(), Blocks.ROOTED_DIRT.defaultBlockState(), Blocks.SAND.defaultBlockState()};
		Map<Long, BlockState> target = new HashMap<>();
		for (int i = 0; i < len; i++) {
			long p = BlockPos.asLong(box.minX() + i, box.minY(), box.minZ());
			BlockState ground = soils[i % soils.length];
			world.put(p, ground);
			target.put(p, ground.is(Blocks.SAND) ? Blocks.GRAVEL.defaultBlockState() : Blocks.DIRT_PATH.defaultBlockState());
		}
		Tgt t = new Tgt(id, "road", clock++, box);
		t.road = true;
		t.target = target;
		for (long p : boxCells(box)) {
			t.before.put(p, at(p));
		}
		targets.put(id, t);
		FeedOrder.insert(order, id, FeedOrder.Origin.NONE, x -> FeedOrder.Origin.NONE);
		t.run = runOf(t);
		rescan(t);
		return t;
	}

	static List<Long> boxCells(Anchors.Bounds b) {
		List<Long> out = new ArrayList<>();
		for (int y = b.minY(); y <= b.maxY(); y++) {
			for (int z = b.minZ(); z <= b.maxZ(); z++) {
				for (int x = b.minX(); x <= b.maxX(); x++) {
					out.add(BlockPos.asLong(x, y, z));
				}
			}
		}
		return out;
	}

	static Cells cellsOf(Anchors.Bounds box, Map<Long, BlockState> states) {
		Map<Long, Journal.Value> vals = new HashMap<>();
		states.forEach((p, s) -> vals.put(p, WorldJournal.value(s)));
		return Cells.fromValues(box, vals);
	}

	/** The target's run, its queue in build order (BuildOrder.order over a probe run, as Builder's placement orders it). */
	Builder.Run runOf(Tgt t) {
		Anchors.Bounds box = t.box;
		int dx = box.maxX() - box.minX() + 1;
		int dz = box.maxZ() - box.minZ() + 1;
		Cells cells = cellsOf(box, t.target);
		List<Integer> idx = new ArrayList<>();
		for (int k = 0; k < cells.size(); k++) {
			if (!cells.states[k].isAir() && !(t.adopted && !t.deltaCells.contains(posOf(box, k, dx, dz)))) {
				idx.add(k);
			}
		}
		int[] boxIdx = idx.stream().mapToInt(Integer::intValue).toArray();
		Site probe = siteOf(t, boxIdx);
		Builder.Run pr = new Builder.Run(probe, cells);
		int n = boxIdx.length;
		int[] y = new int[n];
		int[] kind = new int[n];
		int[] pairOf = new int[n];
		for (int i = 0; i < n; i++) {
			y[i] = pr.pos(i).getY();
			kind[i] = Builder.kind(pr.target[i]);
			pairOf[i] = pr.isSecond[i] ? pr.pairFirst(i) : -1;
		}
		int[] ord = BuildOrder.order(y, kind, pr.support, pairOf);
		int[] queue = new int[n];
		for (int i = 0; i < n; i++) {
			queue[i] = boxIdx[ord[i]];
		}
		Builder.Run r = new Builder.Run(siteOf(t, queue), cells);
		if (t.road) {
			RoadBuilder.freeOff(r, cellsOf(box, t.before));
		}
		return r;
	}

	static long posOf(Anchors.Bounds box, int k, int dx, int dz) {
		int[] o = Construction.offsets(k, dx, dz);
		return BlockPos.asLong(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]);
	}

	Site siteOf(Tgt t, int[] queue) {
		return new Site(t.id, t.design, "none", t.box, t.box, Map.of(), t.placedAt, Site.OVERWORLD, t.box, Builder.JOURNAL_TARGET, null, null,
			new Construction(Construction.BUILDING, queue, Builder.JOURNAL_TARGET, null, t.free, t.paused, OWNER));
	}

	/** Builder.Run.rescan over the in-memory world: built = the world holds what the cell gets ({@code matches}, the copper chain). */
	void rescan(Tgt t) {
		Builder.Run r = t.run;
		if (r == null || t.unloaded) {
			return;
		}
		for (int i = 0; i < r.size(); i++) {
			r.markBuilt(i, r.matches(at(r.pos(i)), i));
		}
	}

	boolean building(Tgt t) {
		return !t.removed && t.run != null && t.run.built.cardinality() < t.run.size();
	}

	// ------------------------------------------------------------------ the feed

	static final int BUDGET = 4;

	/** One feed pass of the stockpile through production's {@link Stockpiles#feedPass}. */
	void feed() {
		if (dissolved) {
			return;
		}
		List<Tgt> ts = new ArrayList<>();
		for (String id : order) {
			Tgt t = targets.get(id);
			if (t != null && !t.removed && t.run != null && (!t.adopted || t.run.size() > 0)) {
				ts.add(t);
			}
		}
		Map<String, Map<String, Integer>> before = new HashMap<>();
		for (Tgt t : ts) {
			before.put(t.id, new TreeMap<>(t.consumed));
		}
		lastReserved = Stockpiles.feedPass(ts, new Stockpiles.FeedVisit<Tgt>() {
			@Override
			public boolean leaving(Tgt t) {
				return t.leaving;
			}

			@Override
			public void left(Tgt t) {
			}

			@Override
			public Builder.@Nullable Run run(Tgt t) {
				return t.run;
			}

			@Override
			public boolean paused(Tgt t) {
				return t.paused;
			}

			@Override
			public void step(Tgt t, Builder.Run r, FeedOrder.Reserve reserve) {
				LedgerSim.this.step(t, r, reserve);
			}

			@Override
			public boolean building(Tgt t) {
				return LedgerSim.this.building(t);
			}

			@Override
			public boolean frontierLoaded(Tgt t, Builder.Run r) {
				return !t.unloaded;
			}
		});
		// the reservation after the pass: the unbuilt cost of every target that reserves (S-Y-1: not one wholly unloaded; C29: not one
		// leaving; Y1: not a paused one), by the model's own reading
		Map<String, Integer> want = new TreeMap<>();
		for (Tgt t : ts) {
			if (t.leaving || t.run == null) {
				continue;
			}
			if (building(t) && !t.paused && !t.unloaded) {
				t.run.unbuilt.forEach((k, v) -> {
					if (v > 0) {
						add(want, k, v);
					}
				});
			}
		}
		if (!want.equals(lastReserved)) {
			violation("reserve", "the reservation after the pass is " + lastReserved + ", the targets that reserve need " + want);
		}
		for (Tgt t : ts) {
			if ((t.leaving || t.paused) && !t.consumed.equals(before.get(t.id))) {
				violation(t.leaving ? "leaving" : "paused", t.id + " consumed " + diff(before.get(t.id), t.consumed) + " while " + (t.leaving ? "being removed (C29: out of the feed)"
					: "paused"));
			}
		}
	}

	static Map<String, Integer> diff(Map<String, Integer> a, Map<String, Integer> b) {
		Map<String, Integer> out = new TreeMap<>(b);
		a.forEach((k, v) -> add(out, k, -v));
		return out;
	}

	/** Builder.step's placement loop, modelled: scan order, affordable at {@code stock - reserved}, supports, pairs, a free cell, a blocker. */
	void step(Tgt t, Builder.Run r, FeedOrder.Reserve reserve) {
		rescan(t);
		if (r.built.cardinality() == r.size() || t.paused || t.unloaded) {
			return;
		}
		int budget = BUDGET;
		for (int i = r.built.nextClearBit(0); i < r.size() && budget > 0; i = r.built.nextClearBit(i + 1)) {
			if (r.isSecond[i]) {
				continue;
			}
			BlockPos p = r.pos(i);
			BlockState now = at(p);
			if (r.matches(now, i)) {
				r.markBuilt(i, true);
				continue;
			}
			if (!r.affordable(i, item -> reserve.available(item, ledger::stock))) {
				continue;
			}
			if (r.support[i] >= 0 && !r.built.get(r.support[i])) {
				continue;
			}
			int j = r.second[i];
			if (t.blocked || !(now.isAir() || now.canBeReplaced()) || j >= 0 && !(at(r.pos(j)).isAir() || at(r.pos(j)).canBeReplaced())) {
				continue;
			}
			pay(t, r.cost.get(i));
			put(t, r, i);
			if (j >= 0) {
				pay(t, r.cost.get(j));
				put(t, r, j);
			}
			budget--;
		}
		if (t.deltaBill != null && r.built.cardinality() == r.size()) {
			// a delta built out: it paid the cells it queued, no more
			if (!t.consumedSince.equals(t.deltaBill)) {
				violation("update", t.id + " v" + t.deltas + " paid " + t.consumedSince + " for a delta whose added cells cost " + t.deltaBill);
			}
			t.deltaBill = null;
		}
	}

	void pay(Tgt t, List<SurvivalItems.Cost> costs) {
		Map<String, Integer> over = new TreeMap<>();
		for (SurvivalItems.Cost c : costs) {
			if (!ledger.consume(c.item(), c.count(), cap(), LedgerSim::maxStack, over)) {
				violation("consume", t.id + ": consume " + c + " refused after affordable said yes");
			}
			add(t.consumed, c.item(), c.count());
			add(t.consumedSince, c.item(), c.count());
		}
		addAll(ground, over, 1);
	}

	void put(Tgt t, Builder.Run r, int i) {
		long p = r.pos(i).asLong();
		world.put(p, r.target[i]);
		r.markBuilt(i, true);
		if (!r.cost.get(i).isEmpty() && !t.free.get(i)) {
			t.paid.add(p);
		}
	}

	/** {@code Stockpiles.unbuiltAll}: the unbuilt cost of every building target not being removed. */
	Map<String, Integer> unbuiltAll() {
		Map<String, Integer> out = new TreeMap<>();
		for (Tgt t : targets.values()) {
			if (t.removed || t.leaving || t.run == null) {
				continue;
			}
			t.run.unbuilt.forEach((k, v) -> {
				if (v > 0) {
					add(out, k, v);
				}
			});
		}
		return out;
	}

	// ------------------------------------------------------------------ events

	/** Inserts up to {@code n} of {@code item} at a crate (the insert rule: pooled need, room, equivalents). Returns how many went in. */
	int insert(String item, int n) {
		if (dissolved) {
			return 0;
		}
		int got = 0;
		for (int k = 0; k < n; k++) {
			Map<String, Integer> need = unbuiltAll();
			Ledger.Accepted a = ledger.accept(item, x -> need.getOrDefault(x, 0), EQ, cap(), LedgerSim::maxStack, true);
			if (a == null) {
				break;
			}
			add(in, a.item(), a.count());
			got++;
		}
		return got;
	}

	/** A player mines a paid, built cell (the item goes to the player; a door takes its other half). */
	boolean mine(Tgt t, int nth) {
		List<Long> ps = new ArrayList<>(new TreeSet<>(t.paid));
		if (ps.isEmpty()) {
			return false;
		}
		long p = ps.get(Math.floorMod(nth, ps.size()));
		BlockState s = at(p);
		addAll(player, costs(s), 1);
		world.put(p, AIR);
		t.paid.remove(p);
		t.deltaBill = null; // a re-queued cell: the delta's own bill no longer says what it pays
		if (s.hasProperty(BlockStateProperties.DOUBLE_BLOCK_HALF)) {
			long q = BlockPos.of(p).relative(s.getValue(BlockStateProperties.DOUBLE_BLOCK_HALF) == DoubleBlockHalf.LOWER ? Direction.UP : Direction.DOWN).asLong();
			world.put(q, AIR);
			t.paid.remove(q);
		}
		rescan(t);
		return true;
	}

	/** A player puts their own block (not the target's) into an unbuilt cell of a target. */
	boolean foreignBlock(Tgt t, int nth) {
		Builder.Run r = t.run;
		if (r == null) {
			return false;
		}
		List<Integer> open = new ArrayList<>();
		for (int i = r.built.nextClearBit(0); i < r.size(); i = r.built.nextClearBit(i + 1)) {
			if (!r.isSecond[i] && r.second[i] < 0 && at(r.pos(i)).isAir() && Builder.kind(r.target[i]) == BuildOrder.FULL) {
				open.add(i);
			}
		}
		if (open.isEmpty()) {
			return false;
		}
		int i = open.get(Math.floorMod(nth, open.size()));
		BlockState mine = Blocks.STONE_BRICKS.defaultBlockState();
		long p = r.pos(i).asLong();
		world.put(p, mine);
		foreign.put(p, mine);
		t.deltaBill = null;
		addAll(in, costs(mine), 1);
		return true;
	}

	/** V6: a copper block weathers a stage, is waxed or scraped, in place (UmtVanilla V6). Returns whether a cell changed. */
	boolean weather(Tgt t, int nth, int how) {
		List<Long> cs = new ArrayList<>();
		for (long p : new TreeSet<>(t.target.keySet())) {
			if (Copper.inChain(at(p).getBlock())) {
				cs.add(p);
			}
		}
		if (cs.isEmpty()) {
			return false;
		}
		long p = cs.get(Math.floorMod(nth, cs.size()));
		BlockState s = at(p);
		Block b = s.getBlock();
		Block to = switch (Math.floorMod(how, 3)) {
			case 0 -> WeatheringCopper.getNext(b).orElse(null);
			case 1 -> HoneycombItem.WAXABLES.get().get(b);
			default -> WeatheringCopper.getPrevious(b).orElse(null);
		};
		if (to == null) {
			return false;
		}
		BlockState n = to.withPropertiesOf(s);
		fired.merge("V6", 1, Integer::sum);
		return change(t, p, s, n);
	}

	/** V7: a farmland cell dries to dirt (UmtVanilla V7). */
	boolean dry(Tgt t, int nth) {
		List<Long> cs = new ArrayList<>();
		for (long p : new TreeSet<>(t.target.keySet())) {
			if (at(p).is(Blocks.FARMLAND)) {
				cs.add(p);
			}
		}
		if (cs.isEmpty()) {
			return false;
		}
		long p = cs.get(Math.floorMod(nth, cs.size()));
		fired.merge("V7", 1, Integer::sum);
		return change(t, p, at(p), Blocks.DIRT.defaultBlockState());
	}

	/** V10: a volatile property changes by use (a door opened). */
	boolean useDoor(Tgt t) {
		for (long p : new TreeSet<>(t.target.keySet())) {
			BlockState s = at(p);
			if (s.getBlock() instanceof DoorBlock && s.getValue(DoorBlock.HALF) == DoubleBlockHalf.LOWER) {
				fired.merge("V10", 1, Integer::sum);
				world.put(p, s.cycle(DoorBlock.OPEN));
				long q = BlockPos.of(p).above().asLong();
				world.put(q, at(q).cycle(DoorBlock.OPEN));
				return true;
			}
		}
		return false;
	}

	/** The world changes a cell by itself: a paid block's items convert (recorded); the target must not re-queue it or charge again. */
	boolean change(Tgt t, long p, BlockState from, BlockState to) {
		Builder.Run r = t.run;
		int qi = r == null ? -1 : r.queuePos(BlockPos.of(p));
		boolean was = qi >= 0 && r.matches(from, qi);
		boolean now = qi >= 0 && r.matches(to, qi);
		Map<String, Integer> unbuiltBefore = r == null ? Map.of() : new TreeMap<>(r.unbuilt);
		world.put(p, to);
		if (t.paid.contains(p)) {
			addAll(conv, costs(from), -1);
			addAll(conv, costs(to), 1);
		}
		rescan(t);
		if (was && !now) {
			if (Copper.inChain(from.getBlock())) {
				violation("weather", t.id + ": " + Cells.blockId(from) + " -> " + Cells.blockId(to) + " at " + BlockPos.of(p).toShortString() + " re-queued the cell (unbuilt "
					+ unbuiltBefore + " -> " + r.unbuilt + "): weathering must charge nothing and not re-queue (CU)");
			} else {
				t.deltaBill = null;
				// production: the cell is no longer the target's (matches is by block), so its paid block counts as not the site's: the
				// deconstruct drops it at the site as the player's (Refunds: not natural from the before's air), never refunds it
				if (t.paid.remove(p)) {
					foreign.put(p, to); // still standing (its conversion already booked): counted with the player's blocks
				}
				finding("L-V7", t.id + ": " + Cells.blockId(from) + " -> " + Cells.blockId(to) + " at " + BlockPos.of(p).toShortString()
					+ " un-builds a paid cell: its cost is outstanding again, the cell (not free) blocks completion, and at the deconstruct the paid"
					+ " block drops at the site as the player's instead of a refund");
			}
		}
		return true;
	}

	// ------------------------------------------------------------------ removal (C29: leave the feed, wait, restore, credit once)

	/** A removal starts on the target: it leaves the feed at once (C29), and waits while a player is in it. */
	void removeStart(Tgt t) {
		t.leaving = true;
	}

	/**
	 * The removal's restore is written: the deconstruct's tally over the box through production's per-cell decision, credited once under the
	 * target's key (or dropped when the stockpile is gone), the player's own blocks dropped, the box back to its before.
	 */
	void removeEnd(Tgt t, boolean creditTwice) {
		Builder.Run r = t.run;
		Refunds.Tally tally = new Refunds.Tally();
		Map<String, Integer> want = new TreeMap<>();
		Iterable<Long> cells = t.adopted ? new TreeSet<>(t.deltaCells) : boxCells(t.box);
		for (long p : cells) {
			BlockState now = at(p);
			BlockState was = t.adopted ? t.adoptedState.getOrDefault(p, t.before.getOrDefault(p, AIR)) : t.before.getOrDefault(p, AIR);
			int qi = r == null ? -1 : r.queuePos(BlockPos.of(p));
			Builder.tallyCell(r, qi, now, was, t.free, t.adopted, tally);
			if (t.paid.contains(p) && !(t.adopted && Copper.is(now, was.getBlock()))) {
				addAll(want, costs(now), 1);
			}
		}
		if (!tally.refund().equals(want)) {
			violation("refund", t.id + ": the deconstruct refunds " + new TreeMap<>(tally.refund()) + ", the paid blocks standing are " + want);
		}
		credit(t.key(), tally.refund());
		if (creditTwice) {
			credit(t.key(), tally.refund());
		}
		// the player's own blocks drop at the site; the box goes back to its before (an adopted target's: its deltas' cells, PT2)
		addAll(ground, tally.playerBlocks(), 1);
		for (long p : cells) {
			BlockState back = t.adopted ? t.adoptedState.getOrDefault(p, t.before.getOrDefault(p, AIR)) : t.before.getOrDefault(p, AIR);
			if (t.adopted && t.paid.contains(p) && Copper.is(at(p), back.getBlock())) {
				// PT2: the undo writes the same block back: it stays, now the player's again (no refund): its items leave the stockpile's books
				addAll(player, costs(at(p)), 1);
			}
			world.put(p, back);
			foreign.remove(p);
		}
		t.paid.clear();
		t.removed = true;
		t.leaving = false;
		order.remove(t.id);
	}

	/** Credits a refund under {@code key} once (production StockLedger); with the stockpile dissolved, it drops (a legacy site's way). */
	void credit(String key, Map<String, Integer> items) {
		if (dissolved) {
			if (keys.add(key)) {
				addAll(ground, items, 1);
			}
			return;
		}
		JsonObject before = ledger.toJson();
		StockLedger.Credit c = ledger.credit(key, items, cap(), LedgerSim::maxStack);
		if (keys.contains(key)) {
			if (!c.already() || !ledger.toJson().equals(before)) {
				violation("once", "the key " + key + " was credited again: " + c.returned() + " + overflow " + c.overflow());
			}
			return;
		}
		keys.add(key);
		Map<String, Integer> sum = new TreeMap<>(c.returned());
		addAll(sum, c.overflow(), 1);
		if (!sum.equals(new TreeMap<>(items))) {
			violation("credit", key + ": credited " + c.returned() + " + overflow " + c.overflow() + " of " + items);
		}
		addAll(ground, c.overflow(), 1);
	}

	// ------------------------------------------------------------------ deltas, adoption

	/**
	 * A construction delta to {@code design} (a version, or a revert): the removed and changed cells first (production's refund of the paid
	 * block standing, credited once under the delta's key), then the new target queued: what already stands as it is built, the rest billed.
	 */
	void delta(Tgt t, String design) {
		Map<Long, BlockState> next = new HashMap<>();
		for (var e : design(design).entrySet()) {
			int[] o = e.getKey();
			next.put(BlockPos.asLong(t.box.minX() + o[0], t.box.minY() + o[1], t.box.minZ() + o[2]), e.getValue());
		}
		Map<String, Integer> refunded = new TreeMap<>();
		Map<String, Integer> want = new TreeMap<>();
		for (long p : new TreeSet<>(t.target.keySet())) {
			BlockState nt = next.get(p);
			BlockState old = at(p);
			if (nt != null && Copper.is(old, nt.getBlock()) && nt.getBlock() == t.target.get(p).getBlock()) {
				continue; // kept
			}
			if (nt != null && nt.getBlock() == t.target.get(p).getBlock()) {
				continue; // the same planned block (not built yet): queued as before
			}
			boolean wasPaid = t.paid.contains(p);
			Builder.refundRemoved(wasPaid, old, refunded);
			if (wasPaid && !old.isAir()) {
				addAll(want, costs(old), 1);
			}
			if (t.adopted && !t.deltaCells.contains(p)) {
				t.adoptedState.put(p, old);
			}
			world.put(p, AIR);
			t.paid.remove(p);
			BlockState theirs = foreign.remove(p);
			if (theirs != null) {
				addAll(ground, costs(theirs), 1); // the player's block a delta writes over drops as items (phase 3's OVERWRITE rule)
			}
			t.deltaCells.add(p);
		}
		for (long p : next.keySet()) {
			BlockState cur = t.target.get(p);
			if (cur == null || cur.getBlock() != next.get(p).getBlock()) {
				if (t.adopted && !t.deltaCells.contains(p)) {
					t.adoptedState.put(p, at(p));
				}
				t.deltaCells.add(p);
			}
		}
		if (!refunded.equals(want)) {
			violation("update", t.id + " -> " + design + ": the delta refunds " + refunded + ", its paid removed blocks standing are " + want);
		}
		t.deltas++;
		credit("delta:e" + t.deltas + ":" + t.id, refunded);
		t.target = next;
		t.run = runOf(t);
		rescan(t);
		Map<String, Integer> bill = new TreeMap<>();
		for (int i = 0; i < t.run.size(); i++) {
			if (!t.run.built.get(i)) {
				t.run.cost.get(i).forEach(c -> add(bill, c.item(), c.count()));
			}
		}
		t.deltaBill = bill;
		t.consumedSince.clear();
		if (!order.contains(t.id)) {
			FeedOrder.insert(order, t.id, FeedOrder.Origin.NONE, x -> FeedOrder.Origin.NONE);
		}
	}

	/** A player's build of {@code design} (their own blocks) adopted as a site: nothing written, nothing charged (PT2). */
	Tgt adopt(String id, String design) {
		Anchors.Bounds box = nextBox(5, 5, 5, FLOOR);
		Tgt t = new Tgt(id, design, clock++, box);
		t.adopted = true;
		for (long p : boxCells(box)) {
			t.before.put(p, at(p));
		}
		Map<Long, BlockState> target = new HashMap<>();
		for (var e : design(design).entrySet()) {
			int[] o = e.getKey();
			long p = BlockPos.asLong(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]);
			target.put(p, e.getValue());
			world.put(p, e.getValue()); // the player's house as they built it (not the stockpile's)
		}
		JsonObject ledgerBefore = ledger.toJson();
		t.target = target;
		targets.put(id, t);
		t.run = runOf(t); // an adopted site queues nothing of its own: its cells are the player's
		rescan(t);
		if (!ledger.toJson().equals(ledgerBefore) || t.run.size() != 0) {
			violation("adopt", id + ": adoption changed the ledger or queued " + t.run.size() + " cell(s): adopt costs 0");
		}
		return t;
	}

	// ------------------------------------------------------------------ the stockpile's own events

	void restart() {
		ledger = StockLedger.fromJson(ledger.toJson());
		JsonObject saved = ledger.toJson();
		if (!StockLedger.fromJson(saved).toJson().equals(saved)) {
			violation("restart", "the ledger read back differs from the file the stop wrote: " + saved);
		}
		for (Tgt t : targets.values()) {
			if (!t.removed) {
				Map<String, Integer> billBefore = t.deltaBill;
				Builder.Run old = t.run;
				t.run = runOf(t);
				rescan(t);
				t.deltaBill = billBefore;
				// (batch v0.41.0, RS-b's S-CU-3 rule) a farmland cell the builder wrote and that dried stays built only while its run holds
				// the built bit (Builder.Run.matches); the restart's run rescans the world and reads the dried cell as not built: L-V7 again,
				// on the restart path only (production's rescan: its cost outstanding, the deconstruct drops it as the player's)
				if (old != null && t.run != null) {
					for (long p : new TreeSet<>(t.paid)) {
						int qo = old.queuePos(BlockPos.of(p)), qn = t.run.queuePos(BlockPos.of(p));
						BlockState now = at(p);
						if (qo >= 0 && qn >= 0 && old.built.get(qo) && !t.run.built.get(qn) && now.is(Blocks.DIRT) && old.target[qo].is(Blocks.FARMLAND)) {
							t.deltaBill = null;
							t.paid.remove(p);
							foreign.put(p, now);
							finding("L-V7", t.id + ": dried farmland at " + BlockPos.of(p).toShortString() + " read as not built after a restart (the rescan has no"
								+ " built bit): its cost is outstanding again and at the deconstruct the paid block drops at the site as the player's");
						}
					}
				}
			}
		}
	}

	int withdraw(String item, int n) {
		if (dissolved) {
			return 0;
		}
		int credit = ledger.stock(item) - unbuiltAll().getOrDefault(item, 0);
		int t = ledger.withdraw(item, Math.max(0, Math.min(n, credit)));
		add(player, item, t);
		return t;
	}

	/** A crate goes (forced): the least stock that brings the stock within the new capacity drops (Stockpiles.excess). */
	boolean crateGone() {
		if (dissolved || crates <= 1) {
			return false;
		}
		crates--;
		Map<String, Integer> excess = Stockpiles.excess(ledger, cap(), LedgerSim::maxStack);
		excess.forEach((k, v) -> add(ground, k, ledger.drop(k, v)));
		return true;
	}

	/** dissolveStockpile: every unit, reserved or not, to the player (half fits) and the rest to the ground; the targets keep waiting. */
	void dissolve() {
		if (dissolved) {
			return;
		}
		Map<String, Integer> toPlayer = new TreeMap<>();
		Map<String, Integer> toGround = new TreeMap<>();
		Stockpiles.dissolveLedger(ledger, (item, n) -> (n + 1) / 2, toPlayer, toGround);
		addAll(player, toPlayer, 1);
		addAll(ground, toGround, 1);
		if (!ledger.stock().isEmpty()) {
			violation("dissolve", "stock left after the dissolve: " + ledger.stock());
		}
		dissolved = true;
	}

	// ------------------------------------------------------------------ the checkpoint

	/** Every invariant that holds at every moment: the identity, conservation, capacity, the credited keys. */
	void checkpoint(String after) {
		if (!ledger.identityHolds()) {
			violation("identity", after + ": a stock below 0: " + ledger.toJson());
		}
		// conservation: every unit that came in is somewhere
		Map<String, Integer> lhs = new TreeMap<>(in);
		addAll(lhs, conv, 1);
		Map<String, Integer> rhs = new TreeMap<>(dissolved ? Map.of() : ledger.stock());
		for (Tgt t : targets.values()) {
			for (long p : t.paid) {
				addAll(rhs, costs(at(p)), 1);
			}
		}
		for (var e : foreign.entrySet()) {
			addAll(rhs, costs(e.getValue()), 1);
		}
		addAll(rhs, player, 1);
		addAll(rhs, ground, 1);
		lhs.values().removeIf(v -> v == 0);
		rhs.values().removeIf(v -> v == 0);
		if (!lhs.equals(rhs)) {
			violation("conserve", after + ": in + converted " + lhs + " != stock + standing paid + the player's + ground " + rhs + " (off by " + diff(lhs, rhs) + ")");
		}
		if (!dissolved && ledger.usedStacks(LedgerSim::maxStack) > cap()) {
			violation("capacity", after + ": " + ledger.usedStacks(LedgerSim::maxStack) + " stacks used of " + cap());
		}
		if (!dissolved && !ledger.creditedKeys().equals(keys)) {
			violation("once", after + ": credited keys " + new TreeSet<>(ledger.creditedKeys()) + ", removals and deltas that ended " + new TreeSet<>(keys));
		}
	}

	JsonObject summary() {
		JsonObject o = ledger.toJson();
		JsonArray v = new JsonArray();
		violations.forEach(v::add);
		o.add("violations", v);
		return o;
	}
}
