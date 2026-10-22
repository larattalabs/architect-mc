package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The survival ledger lint (docs/FAST-CHECKS.md "5. Survival ledger lint", gate step {@code ledger-lint}): {@link LedgerSim} drives the
 * real ledger classes through simulated interleavings of place, feed, mine, weather, delta, adopt, pause, unload, removal (with its wait),
 * stage removal, restart, withdraw, crate gone and dissolve events across several targets and one stockpile, and checks at every
 * checkpoint: the identity and conservation, credit once, refund == the paid blocks standing (deconstruct, delta, revert, undo), the
 * reservation (C29's release, S-Y-1's unloaded exception, a paused target), a delta paying its added cells only, adoption costing 0,
 * weathering charging nothing, capacity and overflow. Targeted tests replay the Steward repros (S-Y-1, dissolve, C29) and CU's
 * refund by the standing block; bill == BOM (C26) and the free-conversion set are checked against their production rules and vanilla.
 * Findings (a world change no rule covers yet, tagged L-...) are counted, not failed, unless {@code -Dledger.strict=true}.
 */
class LedgerLintTest {
	static final String PLANKS = "minecraft:oak_planks";
	static final String COBBLE = "minecraft:cobblestone";

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static void clean(LedgerSim s) {
		assertTrue(s.violations.isEmpty(), String.join("\n", s.violations) + "\nlog:\n" + String.join("\n", s.log));
	}

	/** Inserts every unbuilt item the targets miss (exact, no equivalents needed). */
	static void fill(LedgerSim s) {
		for (var e : new TreeMap<>(s.unbuiltAll()).entrySet()) {
			s.insert(e.getKey(), e.getValue());
		}
	}

	static void feedUntilQuiet(LedgerSim s, int max) {
		for (int i = 0; i < max; i++) {
			s.feed();
			s.checkpoint("feed " + i);
		}
	}

	// ------------------------------------------------------------------ the fuzz

	/** The CI seed set: every interleaving clean (findings counted, not failed). */
	@Test
	void fuzzCiSeeds() {
		int n = Integer.getInteger("ledger.seeds", 400);
		int from = Integer.getInteger("ledger.from", 1);
		boolean strict = Boolean.getBoolean("ledger.strict");
		Map<String, Integer> findings = new TreeMap<>();
		Map<String, Integer> fired = new TreeMap<>();
		Map<String, Integer> ops = new TreeMap<>();
		List<String> bad = new ArrayList<>();
		long t0 = System.nanoTime();
		for (int seed = from; seed < from + n; seed++) {
			LedgerSim s = new LedgerSim();
			List<String> log = run(s, seed, ops);
			s.findings.forEach((k, v) -> findings.merge(k, v, Integer::sum));
			s.fired.forEach((k, v) -> fired.merge(k, v, Integer::sum));
			if (!s.violations.isEmpty()) {
				bad.add("seed " + seed + ": " + s.violations.get(0) + (s.violations.size() > 1 ? " (+" + (s.violations.size() - 1) + ")" : "") + "\n  events: "
					+ String.join("; ", log));
			}
		}
		System.out.printf("ledger-lint: %d scenarios in %.1f s, %d violating; findings %s; vanilla rows fired %s; events %s%n", n, (System.nanoTime() - t0) / 1e9,
			bad.size(), findings, fired, ops);
		assertTrue(bad.isEmpty(), bad.size() + " scenario(s) broke a ledger rule:\n" + String.join("\n", bad.subList(0, Math.min(5, bad.size()))));
		if (strict) {
			assertTrue(findings.isEmpty(), "findings: " + findings);
		}
		for (String id : List.of("V6", "V7", "V10")) {
			assertTrue(fired.getOrDefault(id, 0) > 0, "vanilla row " + id + " never fired: a generator gap");
		}
	}

	/** One scenario: a few targets of the designs (a road among them, sometimes an adopted house), then a random event list. */
	static List<String> run(LedgerSim s, long seed, Map<String, Integer> ops) {
		Random rnd = new Random(seed * 0x9E3779B97F4A7C15L);
		List<String> log = new ArrayList<>();
		s.crates = 1 + rnd.nextInt(3);
		String[] designs = {"hut", "hut2", "shed", "farm"};
		int nt = 2 + rnd.nextInt(3);
		for (int i = 0; i < nt; i++) {
			String d = designs[rnd.nextInt(designs.length)];
			s.place("t" + i, d);
			log.add("place t" + i + " " + d);
		}
		if (rnd.nextInt(3) == 0) {
			s.placeRoad("road", 7 + rnd.nextInt(8));
			log.add("road");
		}
		if (rnd.nextInt(3) == 0) {
			s.adopt("a", "hut");
			log.add("adopt a hut");
		}
		s.checkpoint("setup");
		int events = 30 + rnd.nextInt(40);
		for (int e = 0; e < events && s.violations.isEmpty(); e++) {
			List<LedgerSim.Tgt> live = s.targets.values().stream().filter(t -> !t.removed).toList();
			LedgerSim.Tgt t = live.isEmpty() ? null : live.get(rnd.nextInt(live.size()));
			int op = rnd.nextInt(100);
			// nothing happens in an unloaded chunk (no player, no random tick, no delta: NOT_LOADED); only loading it again
			if (t != null && t.unloaded && op >= 47 && !(op >= 67 && op < 70)) {
				continue;
			}
			String what;
			if (op < 22) {
				Map<String, Integer> need = s.unbuiltAll();
				if (need.isEmpty()) {
					continue;
				}
				List<String> items = new ArrayList<>(new TreeSet<>(need.keySet()));
				String item = items.get(rnd.nextInt(items.size()));
				int n = 1 + rnd.nextInt(need.get(item) + 8);
				what = "insert " + item + " " + n + " -> " + s.insert(item, n);
			} else if (op < 47) {
				int k = 1 + rnd.nextInt(4);
				for (int i = 0; i < k; i++) {
					s.feed();
				}
				what = "feed " + k;
			} else if (op < 50 && t != null) {
				what = "mine " + t.id + " " + s.mine(t, rnd.nextInt(64));
			} else if (op < 52 && t != null) {
				what = "foreign " + t.id + " " + s.foreignBlock(t, rnd.nextInt(64));
			} else if (op < 60 && t != null) {
				what = "weather " + t.id + " " + s.weather(t, rnd.nextInt(64), rnd.nextInt(3));
			} else if (op < 62 && t != null) {
				what = "dry " + t.id + " " + s.dry(t, rnd.nextInt(64));
			} else if (op < 64 && t != null) {
				what = "use-door " + t.id + " " + s.useDoor(t);
			} else if (op < 67 && t != null && !t.leaving) {
				t.paused = !t.paused;
				what = "pause " + t.id + " " + t.paused;
			} else if (op < 70 && t != null) {
				t.unloaded = !t.unloaded;
				what = "unload " + t.id + " " + t.unloaded;
			} else if (op < 73 && t != null) {
				t.blocked = !t.blocked;
				what = "player-in " + t.id + " " + t.blocked;
			} else if (op < 75 && s.order.size() > 1) {
				List<String> front = List.of(s.order.get(rnd.nextInt(s.order.size())));
				s.order = FeedOrder.setFront(s.order, front);
				what = "order " + front;
			} else if (op < 79 && t != null && !t.leaving && !t.road && !t.design.equals("shed") && !t.design.equals("farm")) {
				String[] to = {"storey", "hatch", "hut"};
				String d = to[rnd.nextInt(to.length)];
				s.delta(t, d);
				what = "delta " + t.id + " -> " + d;
			} else if (op < 83 && t != null && !t.leaving) {
				s.removeStart(t);
				what = "remove-start " + t.id;
			} else if (op < 88) {
				List<LedgerSim.Tgt> leaving = live.stream().filter(x -> x.leaving).toList();
				if (leaving.isEmpty()) {
					continue;
				}
				// a stage removal: every leaving target ends together once no player is in any (C29)
				boolean all = rnd.nextBoolean();
				StringBuilder b = new StringBuilder("remove-end");
				for (LedgerSim.Tgt x : all ? leaving : List.of(leaving.get(0))) {
					if (x.blocked) {
						continue;
					}
					s.removeEnd(x, rnd.nextInt(4) == 0);
					b.append(' ').append(x.id);
				}
				what = b.toString();
			} else if (op < 92) {
				s.restart();
				what = "restart";
			} else if (op < 95) {
				Map<String, Integer> st = s.ledger.stock();
				if (st.isEmpty()) {
					continue;
				}
				List<String> items = new ArrayList<>(new TreeSet<>(st.keySet()));
				String item = items.get(rnd.nextInt(items.size()));
				what = "withdraw " + item + " " + s.withdraw(item, 1 + rnd.nextInt(16));
			} else if (op < 97) {
				what = "crate-gone " + s.crateGone();
			} else if (op < 98 && e > events / 2) {
				s.dissolve();
				what = "dissolve";
			} else {
				continue;
			}
			ops.merge(what.split(" ")[0], 1, Integer::sum);
			log.add(what);
			s.checkpoint(what);
		}
		return log;
	}

	// ------------------------------------------------------------------ the Steward repros and CU, targeted

	/** S-Y-1: a target whose whole remaining frontier is unloaded reserves nothing; the one behind it is fed from the stock it would hold. */
	@Test
	void sy1_aWhollyUnloadedTargetReservesNothing() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt a = s.place("A", "hut");
		LedgerSim.Tgt b = s.place("B", "hut");
		a.unloaded = true;
		// only one bill's worth: A is first in the order, but its frontier is unloaded
		for (var e : new TreeMap<>(b.run.bom).entrySet()) {
			s.insert(e.getKey(), e.getValue());
		}
		feedUntilQuiet(s, 40);
		clean(s);
		assertEquals(b.run.size(), b.run.built.cardinality(), "B built from the stock A did not reserve");
		assertEquals(0, a.run.built.cardinality());
		// A loads again: it reserves what it still needs
		a.unloaded = false;
		s.feed();
		s.checkpoint("A loaded");
		clean(s);
		assertTrue(s.lastReserved.entrySet().stream().allMatch(e -> e.getValue() == Math.max(0, a.run.unbuilt.getOrDefault(e.getKey(), 0))), s.lastReserved.toString());
	}

	/** Steward's dissolve: reserved stock and a building target: every unit out as withdrawn or dropped, the identity at 0, nothing fed after. */
	@Test
	void dissolve_reservedStockAndABuildingTarget() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt a = s.place("A", "hut");
		s.place("B", "shed");
		fill(s);
		for (int i = 0; i < 3; i++) {
			s.feed();
			s.checkpoint("feed");
		}
		assertTrue(a.run.built.cardinality() > 0 && a.run.built.cardinality() < a.run.size(), "A is half built");
		assertFalse(s.lastReserved.isEmpty(), "stock is reserved");
		s.dissolve();
		s.checkpoint("dissolve");
		int built = a.run.built.cardinality();
		feedUntilQuiet(s, 5);
		clean(s);
		assertEquals(built, a.run.built.cardinality(), "a target with no stockpile waits");
		assertTrue(s.ledger.stock().isEmpty());
		// a removal after the dissolve drops its refund (the stockpile is gone)
		s.removeStart(a);
		s.removeEnd(a, true);
		s.checkpoint("removed after the dissolve");
		clean(s);
	}

	/**
	 * C29: a group removal waiting for a player in the site: the target leaves the feed at once (no reservation, nothing consumed for its
	 * remaining bill), the target behind it is fed from that stock; a restart mid-wait keeps it out; the refund is the paid blocks standing,
	 * credited once at the restore, never again.
	 */
	@Test
	void c29_aRemovalWaitingForAPlayerLeavesTheFeed() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt a = s.place("A", "hut");
		LedgerSim.Tgt c = s.place("C", "hut");
		for (var e : new TreeMap<>(a.run.bom).entrySet()) {
			s.insert(e.getKey(), e.getValue() / 2);
		}
		feedUntilQuiet(s, 10);
		int paidA = a.paid.size();
		assertTrue(paidA > 0);
		a.blocked = true;
		s.removeStart(a);
		// A's remaining bill comes in: none of it goes to A; C gets it
		fill(s);
		feedUntilQuiet(s, 40);
		s.restart();
		s.checkpoint("restart mid-wait");
		feedUntilQuiet(s, 10);
		clean(s);
		assertEquals(paidA, a.paid.size(), "A placed nothing while leaving");
		assertTrue(c.run.built.cardinality() > 0, "C was fed past A");
		a.blocked = false;
		s.removeEnd(a, true);
		s.checkpoint("restored");
		clean(s);
		assertTrue(s.ledger.credited(a.key()));
	}

	/** C29 item 4: undoStage of two targets (one waits for a player), a road removal: each credited once, refund = paid standing. */
	@Test
	void c29_stageRemovalAndARoad() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt h1 = s.place("h1", "hut");
		LedgerSim.Tgt h2 = s.place("h2", "hut2");
		LedgerSim.Tgt r = s.placeRoad("r1", 14);
		fill(s);
		feedUntilQuiet(s, 60);
		h2.blocked = true;
		s.removeStart(h1);
		s.removeStart(h2);
		s.removeStart(r);
		feedUntilQuiet(s, 5);
		s.removeEnd(h1, false);
		s.removeEnd(r, true);
		s.checkpoint("h1 and the road");
		h2.blocked = false;
		s.removeEnd(h2, true);
		s.checkpoint("h2");
		clean(s);
		assertTrue(s.ledger.credited(h1.key()) && s.ledger.credited(h2.key()) && s.ledger.credited(r.key()));
	}

	/**
	 * CU (S-CU-2), cu-survival items 7, 8a-8c: weathering, waxing and scraping while the build waits charge nothing and re-queue nothing; a
	 * delta over weathered cells refunds their standing blocks; the deconstruct refunds the standing blocks' items, not the planned ones.
	 */
	@Test
	void copper_refundByTheStandingBlock() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt t = s.place("shed", "shed");
		LedgerSim.Tgt h = s.place("hut2", "hut2");
		Map<String, Integer> bill = new TreeMap<>(t.run.bom);
		// all but the last cells' items: the build waits while its copper weathers
		fill(s);
		feedUntilQuiet(s, 12);
		for (int i = 0; i < 200; i++) {
			s.weather(t, i, i % 7 == 0 ? 1 : 0);
			s.weather(h, i, i % 5 == 0 ? 2 : 0);
			s.checkpoint("weather " + i);
		}
		feedUntilQuiet(s, 60);
		clean(s);
		assertEquals(t.run.size(), t.run.built.cardinality());
		assertEquals(bill, new TreeMap<>(t.consumed), "the bill was charged once, whatever weathered");
		s.delta(h, "hatch");
		s.checkpoint("delta over weathered copper");
		s.removeStart(t);
		s.removeEnd(t, false);
		s.checkpoint("deconstruct");
		clean(s);
		assertTrue(s.ledger.returned().keySet().stream().anyMatch(k -> k.contains("oxidized") || k.contains("weathered") || k.contains("exposed") || k.contains("waxed")),
			"the refund names standing copper stages: " + s.ledger.returned());
	}

	/**
	 * (6c close-out B, L-V7) A farm built from the stockpile, then three of its farmland cells dry to dirt, then a restart: the restart's run
	 * reads the dried cells as built (Builder.driedFarmland from the befores), nothing is outstanding or charged again, and the deconstruct
	 * refunds the bill exactly (dirt for each dried cell, as farmland costs). The same over a half-built farm finished after the restart.
	 */
	@Test
	void lv7_driedFarmlandAfterARestartIsWrittenOnceAndPaidOnce() {
		for (boolean half : new boolean[] {false, true}) {
			LedgerSim s = new LedgerSim();
			LedgerSim.Tgt f = s.place("farm", "farm");
			Map<String, Integer> bill = new TreeMap<>(f.run.bom);
			if (half) {
				for (var e : bill.entrySet()) {
					s.insert(e.getKey(), e.getValue() / 2);
				}
			} else {
				fill(s);
			}
			feedUntilQuiet(s, 40);
			assertTrue(f.run.built.cardinality() > 3, "farmland written");
			for (int i = 0; i < 3; i++) {
				assertTrue(s.dry(f, i * 5));
				s.checkpoint("dry " + i);
			}
			s.restart();
			s.checkpoint("restart");
			fill(s);
			feedUntilQuiet(s, 40);
			clean(s);
			assertEquals(Map.of(), s.findings, "no L-V7 (half " + half + ")");
			assertEquals(f.run.size(), f.run.built.cardinality(), "built, the dried cells among it");
			assertEquals(bill, new TreeMap<>(f.consumed), "the bill charged once (half " + half + ")");
			s.removeStart(f);
			s.removeEnd(f, false);
			s.checkpoint("deconstruct");
			clean(s);
			assertEquals(bill, new TreeMap<>(s.ledger.returned()), "the refund is the bill (half " + half + ")");
		}
	}

	/** (6c close-out B, L-V7) driedFarmland marks farmland over no soil (air, stone) or over farmland; never over the ground's own soil. */
	@Test
	void lv7_driedFarmlandMarksOnlyCellsWhoseBeforeWasNoSoil() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt f = s.place("farm", "farm");
		net.minecraft.world.level.block.state.BlockState[] befores = {LedgerSim.AIR, net.minecraft.world.level.block.Blocks.STONE.defaultBlockState(),
			net.minecraft.world.level.block.Blocks.FARMLAND.defaultBlockState(), net.minecraft.world.level.block.Blocks.DIRT.defaultBlockState(),
			net.minecraft.world.level.block.Blocks.GRASS_BLOCK.defaultBlockState(), net.minecraft.world.level.block.Blocks.PODZOL.defaultBlockState()};
		boolean[] want = {true, true, true, false, false, false};
		for (int b = 0; b < befores.length; b++) {
			for (long p : f.target.keySet()) {
				f.before.put(p, befores[b]);
			}
			Builder.Run r = s.runOf(f);
			for (int q = 0; q < r.size(); q++) {
				boolean farmland = r.target[q].is(net.minecraft.world.level.block.Blocks.FARMLAND);
				assertEquals(farmland && want[b], r.tilled.get(q), "before " + befores[b] + " at " + r.pos(q));
			}
		}
	}

	/**
	 * PT2 item 6 (pt2-survival) and the shape of Steward's C35 flow (versionOf of an adopted hut): adoption costs 0; an update pays only its
	 * added cells; a delta removing an adopted block refunds nothing; the revert is a paid forward delta; the un-adopt refunds only paid
	 * blocks it takes away.
	 */
	@Test
	void pt2_adoptCostsNothingAndAnUpdatePaysOnlyItsCells() {
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt a = s.adopt("a", "hut");
		s.checkpoint("adopt");
		s.delta(a, "storey");
		Map<String, Integer> bill = new TreeMap<>(a.deltaBill);
		fill(s);
		feedUntilQuiet(s, 40);
		clean(s);
		assertEquals(bill, new TreeMap<>(a.consumed), "the storey's cells only");
		Map<String, Integer> returned = new TreeMap<>(s.ledger.returned());
		s.delta(a, "hatch"); // removes the storey (paid: refunded) and the adopted roof cell (not paid: no refund)
		s.checkpoint("hatch");
		fill(s);
		feedUntilQuiet(s, 20);
		s.delta(a, "hut"); // the revert: a forward delta
		fill(s);
		feedUntilQuiet(s, 20);
		s.removeStart(a);
		s.removeEnd(a, true);
		s.checkpoint("un-adopt");
		clean(s);
		assertTrue(returned.isEmpty());
	}

	/**
	 * Y1 overflow and gone: a refund into a full stockpile overflows to the ground (refundOverflow, outside the identity), never past capacity;
	 * a crate gone drops the least whole stacks that bring the stock within the new capacity.
	 */
	@Test
	void capacityOverflowAndACrateGone() {
		LedgerSim s = new LedgerSim();
		s.crates = 1;
		LedgerSim.Tgt t = s.place("t", "hut");
		fill(s);
		feedUntilQuiet(s, 40);
		assertEquals(t.run.size(), t.run.built.cardinality());
		// paused targets still need their bills: the stock fills to capacity with what they need
		for (int i = 0; i < 24; i++) {
			s.place("u" + i, i % 2 == 0 ? "hut" : "shed").paused = true;
		}
		fill(s);
		s.checkpoint("filled");
		assertEquals(s.cap(), s.ledger.usedStacks(LedgerSim::maxStack), "the stockpile is full");
		s.removeStart(t);
		s.removeEnd(t, false);
		s.checkpoint("a refund into a full stockpile");
		assertFalse(s.ledger.refundOverflow().isEmpty(), "the refund overflowed");
		s.crates = 3;
		fill(s);
		s.checkpoint("three crates");
		s.crateGone();
		s.checkpoint("crate gone");
		clean(s);
	}

	// ------------------------------------------------------------------ bill == BOM, the free set, the vanilla table

	/** C26 (y2-bom): the placed site's bill (the run's bom) equals FullBom over the same template, for every design. */
	@Test
	void billEqualsTheFullBom() {
		for (String d : List.of("hut", "hut2", "shed", "farm", "storey", "hatch")) {
			LedgerSim s = new LedgerSim();
			LedgerSim.Tgt t = s.place("t", d);
			int n = t.target.size();
			int[] xyz = new int[n * 3];
			BlockState[] st = new BlockState[n];
			int i = 0;
			for (var e : new TreeMap<>(t.target).entrySet()) {
				BlockPos p = BlockPos.of(e.getKey());
				xyz[3 * i] = p.getX();
				xyz[3 * i + 1] = p.getY();
				xyz[3 * i + 2] = p.getZ();
				st[i++] = e.getValue();
			}
			int[] none = new int[0];
			FullBom.Result r = FullBom.compute(new FullBom.Inputs(net.minecraft.world.level.block.Rotation.NONE, xyz, st, (p, b) -> false, none, none, none, none, none,
				none, Blocks.STONE_BRICKS.defaultBlockState(), Blocks.COBBLESTONE.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState(), Blocks.OAK_SLAB
					.defaultBlockState()), p -> s.at(p));
			assertEquals(new TreeMap<>(t.run.bom), new TreeMap<>(r.items()), d + ": bill == BOM");
			assertTrue(r.exact(), d + ": " + r.inexactBecause());
		}
	}

	/**
	 * The free-conversion set (survroad, v-ingame #12): a road's dirt path is free on exactly the blocks a shovel paths, vanilla's own
	 * tag {@code minecraft:turns_into_dirt_path} (the shovel's block transformer, data/minecraft/block_transformer/shovel.json).
	 */
	@Test
	void theFreeConversionSetIsTheShovelsOwn() throws Exception {
		Set<String> shovel = new TreeSet<>();
		try (var in = LedgerLintTest.class.getResourceAsStream("/data/minecraft/tags/block/turns_into_dirt_path.json")) {
			assertTrue(in != null, "vanilla's tag on the test classpath");
			com.google.gson.JsonParser.parseReader(new java.io.InputStreamReader(in, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonArray("values")
				.forEach(v -> shovel.add(v.getAsString()));
		}
		Set<String> free = new TreeSet<>();
		for (Block b : BuiltInRegistries.BLOCK) {
			if (RoadBuilder.freeCell(b.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState())) {
				free.add(BuiltInRegistries.BLOCK.getKey(b).toString());
			}
		}
		assertEquals(shovel, free, "RoadBuilder.freeCell's set against vanilla's turns_into_dirt_path");
		// and a road built over them: its free cells cost nothing, the sand cells their gravel
		LedgerSim s = new LedgerSim();
		LedgerSim.Tgt r = s.placeRoad("r", 14);
		assertEquals(Map.of("minecraft:gravel", 2), new TreeMap<>(r.run.bom));
	}

	/** The vanilla-updates table shared with UMT (docs/UMT.md): every row has a ledger decision; a row added without one fails here. */
	static final Map<String, String> DECISIONS = Map.ofEntries(Map.entry("V1", "none: a shape update changes no block's identity (V2-V5 are the rows that do)"),
		Map.entry("V2", "not modelled: a fallen gravity block un-builds its cell (re-queued, charged again; the fallen block is the world's); "
			+ "tile-gravity and UMT's sand rule own it"),
		Map.entry("V3", "free: a road's dirt path turned to dirt is re-laid free (RoadBuilder.freeCell on dirt); a site's path cell re-queues"),
		Map.entry("V4", "no charge: Run.matches is by block, a connection change stays built"),
		Map.entry("V5", "not modelled: a broken plant drops its item (the world's) and its cell re-queues"),
		Map.entry("V6", "no charge, no re-queue; refund and delta refund by the block standing (LedgerSim.weather)"),
		Map.entry("V7", "no charge, no re-queue: dried farmland stays built in session (the built bit) and after a restart (Builder.driedFarmland from the befores); "
			+ "L-V7 is reported if either breaks (LedgerSim.dry, LedgerSim.restart)"),
		Map.entry("V8", "not modelled: construction sites build dry (waterlogged off); regions are INSTANT"),
		Map.entry("V9", "none: a restore's fluid tick has no ledger effect"),
		Map.entry("V10", "no charge: a door opened stays built (LedgerSim.useDoor)"),
		Map.entry("N1", "none: decor no plan wrote is never in a ledger"),
		Map.entry("N2", "a removal waits (C29: the target leaves the feed meanwhile)"));

	@Test
	void everyVanillaRowHasALedgerDecision() {
		Set<String> table = new TreeSet<>();
		UmtVanilla.TABLE.forEach(r -> table.add(r.id()));
		assertEquals(table, new TreeSet<>(DECISIONS.keySet()), "rows of UmtVanilla.TABLE without a ledger decision (or decisions for rows that went)");
	}

	/** The world model the targets stand on (a guard for the designs). */
	@Test
	void designsFitTheirBoxes() {
		LedgerSim s = new LedgerSim();
		for (String d : List.of("hut", "hut2", "shed", "farm", "storey", "hatch")) {
			LedgerSim.Tgt t = s.place("t-" + d, d);
			Anchors.Bounds b = t.box;
			for (long p : t.target.keySet()) {
				assertTrue(b.contains(BlockPos.getX(p), BlockPos.getY(p), BlockPos.getZ(p)), d);
			}
			assertEquals(new HashMap<>(t.run.unbuilt).values().stream().mapToInt(Integer::intValue).sum(), t.run.bom.values().stream().mapToInt(Integer::intValue).sum());
		}
	}
}
