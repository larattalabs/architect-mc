package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.SurvivalItems.Cost;
import dev.larattalabs.architect.survival.WaitCalc.Edge;
import dev.larattalabs.architect.survival.WaitCalc.Latch;
import dev.larattalabs.architect.survival.WaitCalc.Needs;
import dev.larattalabs.architect.survival.WaitCalc.Outcome;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;

/** C25 (docs/CONTRACT.md phase 6c slice Y, gate item 1): the nextNeeded walk and the waiting latch. */
class SiteWaitTest {
	private static List<Cost> c(String item, int n) {
		return List.of(new Cost(item, n));
	}

	@Test
	void anItemEntersAtItsFirstShortfallInBuildOrder() {
		// cells in build order: 2 stone, 1 glass, 3 stone, 1 oak; stock 3 stone, 0 glass, 5 oak
		List<List<Cost>> cells = List.of(c("stone", 2), c("glass", 1), c("stone", 3), c("oak", 1));
		Map<String, Integer> have = Map.of("stone", 3, "oak", 5);
		Needs n = WaitCalc.walk(cells, k -> have.getOrDefault(k, 0));
		// glass runs short at cell 2, stone at cell 3: glass first, with its whole shortfall; stone's shortfall is 5 - 3 = 2
		assertEquals(List.of(new WaitCalc.Need("glass", 1), new WaitCalc.Need("stone", 2)), n.list());
		assertEquals(0, n.moreUnits());
		assertEquals(3, n.totalShortfall());
	}

	@Test
	void nothingShortMeansNothingNeeded() {
		Needs n = WaitCalc.walk(List.of(c("stone", 2)), k -> 2);
		assertTrue(n.list().isEmpty());
		assertEquals(0, n.moreUnits());
	}

	@Test
	void aPairedCostCountsEveryItemOfTheCell() {
		List<Cost> bed = List.of(new Cost("planks", 3), new Cost("wool", 3));
		Needs n = WaitCalc.walk(List.<List<Cost>>of(bed), k -> k.equals("planks") ? 3 : 1);
		assertEquals(List.of(new WaitCalc.Need("wool", 2)), n.list());
	}

	@Test
	void capsAtEightEntriesAndTotalsTheRest() {
		List<List<Cost>> cells = new ArrayList<>();
		for (int i = 0; i < 12; i++) {
			cells.add(c("item" + i, i + 1)); // item i misses i + 1 units, none in stock
		}
		Needs n = WaitCalc.walk(cells, k -> 0);
		assertEquals(8, n.list().size());
		assertEquals("item0", n.list().get(0).item());
		assertEquals("item7", n.list().get(7).item());
		int rest = 9 + 10 + 11 + 12;
		assertEquals(rest, n.moreUnits());
		assertEquals(78, n.list().stream().mapToInt(WaitCalc.Need::count).sum() + n.moreUnits());
	}

	@Test
	void countsPlusMoreEqualOutstandingMinusAvailable() {
		Random rnd = new Random(25);
		for (int round = 0; round < 300; round++) {
			int items = 1 + rnd.nextInt(14);
			List<List<Cost>> cells = new ArrayList<>();
			Map<String, Integer> outstanding = new HashMap<>();
			for (int i = 0, n = 1 + rnd.nextInt(60); i < n; i++) {
				List<Cost> cell = new ArrayList<>();
				for (int k = 0, m = 1 + rnd.nextInt(3); k < m; k++) {
					String item = "i" + rnd.nextInt(items);
					int count = 1 + rnd.nextInt(4);
					cell.add(new Cost(item, count));
					outstanding.merge(item, count, Integer::sum);
				}
				cells.add(cell);
			}
			Map<String, Integer> have = new HashMap<>();
			for (int i = 0; i < items; i++) {
				have.put("i" + i, rnd.nextInt(40));
			}
			Needs n = WaitCalc.walk(cells, k -> have.getOrDefault(k, 0));
			int expected = outstanding.entrySet().stream().mapToInt(e -> Math.max(0, e.getValue() - have.getOrDefault(e.getKey(), 0))).sum();
			assertEquals(expected, n.list().stream().mapToInt(WaitCalc.Need::count).sum() + n.moreUnits(), "round " + round);
			assertEquals(expected, n.totalShortfall());
			assertTrue(n.list().size() <= WaitCalc.MAX_NEEDED);
		}
	}

	// ---------------------------------------------------------------- the latch

	private static Edge run(Latch l, long from, int ticks, Outcome o) {
		Edge last = Edge.NONE;
		for (int i = 0; i < ticks; i++) {
			l.tick(from + i, o);
			Edge e = l.poll(from + i);
			if (e != Edge.NONE) {
				last = e;
			}
		}
		return last;
	}

	@Test
	void startsAfterOneHundredStarvedTicksAndNotBefore() {
		Latch l = new Latch();
		assertEquals(Edge.NONE, run(l, 1000, 99, Outcome.STARVED));
		assertFalse(l.waiting());
		l.tick(1099, Outcome.STARVED);
		assertTrue(l.waiting());
		assertEquals(1099L, l.since());
		assertEquals(Edge.START, l.poll(1099));
		assertEquals(Edge.NONE, l.poll(1100), "never twice for the same edge");
	}

	@Test
	void aTickThatIsNotStarvedRestartsTheCount() {
		Latch l = new Latch();
		run(l, 0, 99, Outcome.STARVED);
		l.tick(99, Outcome.IDLE); // a player stepped into a cell
		run(l, 100, 99, Outcome.STARVED);
		assertFalse(l.waiting());
		l.tick(199, Outcome.STARVED);
		assertTrue(l.waiting());
	}

	@Test
	void playersChunksAndMissingSupportNeverStartAWait() {
		Latch l = new Latch();
		assertEquals(Edge.NONE, run(l, 0, 5000, Outcome.IDLE));
		assertFalse(l.waiting());
		assertEquals(0L, l.since());
	}

	@Test
	void onceOnItHoldsThroughIdleTicksUntilACellIsPlaced() {
		Latch l = new Latch();
		run(l, 0, 100, Outcome.STARVED);
		assertEquals(Edge.NONE, run(l, 100, 400, Outcome.IDLE), "an unloaded chunk or a reload does not end it");
		assertTrue(l.waiting());
		l.tick(500, Outcome.PLACED);
		assertFalse(l.waiting());
		assertEquals(Edge.STOP, l.poll(500));
		assertEquals(0L, l.since());
	}

	@Test
	void pauseBuiltAndRemovedEndAWait() {
		Latch l = new Latch();
		run(l, 0, 100, Outcome.STARVED);
		l.tick(200, Outcome.ENDED);
		assertFalse(l.waiting());
	}

	@Test
	void aRestoredLatchKeepsItsTimeAndFiresNoNewStart() {
		Latch l = Latch.restored(12_345);
		assertTrue(l.waiting());
		assertEquals(12_345L, l.since());
		assertEquals(Edge.NONE, run(l, 20_000, 300, Outcome.IDLE));
		assertEquals(Edge.NONE, run(l, 20_300, 300, Outcome.STARVED));
		assertEquals(12_345L, l.since());
	}

	@Test
	void anEdgeThatComesTooSoonIsDeferredNotDropped() {
		Latch l = new Latch();
		assertEquals(Edge.START, run(l, 0, 100, Outcome.STARVED));
		l.tick(105, Outcome.PLACED); // the stop edge, 6 ticks after the start
		assertEquals(Edge.NONE, l.poll(105));
		assertEquals(Edge.NONE, l.poll(118));
		assertEquals(Edge.STOP, l.poll(119), "20 ticks after the start edge");
	}

	@Test
	void aStartAndStopInsideTheWindowAreBothDeferredAndCancelEachOther() {
		Latch l = new Latch();
		assertEquals(Edge.START, run(l, 0, 100, Outcome.STARVED));
		l.tick(100, Outcome.PLACED);
		assertEquals(Edge.NONE, run(l, 101, 100, Outcome.STARVED), "waiting again; the last edge reported was START, so nothing new to say");
		assertTrue(l.waiting());
	}

	@Test
	void finishFiresTheStopNowOnlyForAReportedStart() {
		Latch l = new Latch();
		run(l, 0, 100, Outcome.STARVED);
		assertEquals(Edge.STOP, l.finish(101));
		Latch k = new Latch();
		run(k, 0, 50, Outcome.STARVED);
		assertEquals(Edge.NONE, k.finish(60));
		Latch n = new Latch();
		n.tick(0, Outcome.STARVED);
		for (int i = 1; i < 100; i++) {
			n.tick(i, Outcome.STARVED);
		}
		assertTrue(n.waiting());
		assertEquals(Edge.NONE, n.finish(100), "its start was never reported");
	}
}
