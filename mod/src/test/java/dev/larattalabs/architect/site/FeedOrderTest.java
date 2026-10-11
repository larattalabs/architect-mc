package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 6c Y1 (C24 §3, Steward's S-Y-1) gate item 1: the feed order and its reservations. Batch items join in batch item order whatever
 * order they are placed in; later targets in placement order; setFeedOrder moves listed ids to the front and refuses unknown or
 * finished ones; a target may use only {@code stock - reserved}; a paused target and one whose whole frontier is unloaded don't
 * reserve, a blocked one does.
 */
class FeedOrderTest {
	static final String COBBLE = "minecraft:cobblestone";
	static final String DOOR = "minecraft:oak_door";

	@Test
	void batchItemsJoinInBatchItemOrder() {
		Map<String, FeedOrder.Origin> origin = new HashMap<>();
		origin.put("s3", new FeedOrder.Origin("b1", 2));
		origin.put("s1", new FeedOrder.Origin("b1", 0));
		origin.put("r1", new FeedOrder.Origin("b1", 3));
		origin.put("s2", new FeedOrder.Origin("b1", 1));
		origin.put("s9", FeedOrder.Origin.NONE);
		List<String> order = new ArrayList<>();
		// placed nearest first: s3, s1, r1, then a standalone site, then s2
		for (String id : List.of("s3", "s1", "r1", "s9", "s2")) {
			FeedOrder.insert(order, id, origin.get(id), origin::get);
		}
		assertEquals(List.of("s1", "s2", "s3", "r1", "s9"), order);
		FeedOrder.insert(order, "s1", origin.get("s1"), origin::get);
		assertEquals(5, order.size(), "joining twice changes nothing");
	}

	@Test
	void setFrontMovesListedIdsAndKeepsTheRest() {
		List<String> order = List.of("s1", "s2", "s3", "r1", "d4");
		assertEquals(List.of("s3", "s1", "s2", "r1", "d4"), FeedOrder.setFront(order, List.of("s3")));
		assertEquals(List.of("d4", "s2", "s1", "s3", "r1"), FeedOrder.setFront(order, List.of("d4", "s2")));
		assertEquals(order, FeedOrder.setFront(order, List.of()));
		IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> FeedOrder.setFront(order, List.of("s3", "s77", "s3")));
		assertTrue(e.getMessage().contains("s77") && e.getMessage().contains("s3"), e.getMessage());
	}

	@Test
	void aLowerTargetBuildsOnlyFromSurplus() {
		Map<String, Integer> stock = Map.of(COBBLE, 50, DOOR, 1);
		FeedOrder.Reserve r = new FeedOrder.Reserve();
		// first: house 3 needs 40 cobblestone and a door, building and loaded
		assertEquals(50, r.available(COBBLE, k -> stock.getOrDefault(k, 0)));
		r.add(Map.of(COBBLE, 40, DOOR, 1), FeedOrder.reserves(true, false, true, true));
		// second sees only the surplus
		assertEquals(10, r.available(COBBLE, k -> stock.getOrDefault(k, 0)));
		assertEquals(0, r.available(DOOR, k -> stock.getOrDefault(k, 0)));
		r.add(Map.of(COBBLE, 30), true);
		assertEquals(0, r.available(COBBLE, k -> stock.getOrDefault(k, 0)), "never below 0");
		assertEquals(70, r.reserved(COBBLE));
	}

	@Test
	void pausedAndUnloadedTargetsDoNotReserveBlockedOnesDo() {
		assertFalse(FeedOrder.reserves(true, true, true, true), "paused");
		assertFalse(FeedOrder.reserves(true, false, true, false), "whole frontier in unloaded chunks (S-Y-1 exception)");
		assertTrue(FeedOrder.reserves(true, false, true, true), "a player in a cell or a missing support: still reserves");
		assertFalse(FeedOrder.reserves(false, false, true, true), "not building");
		assertFalse(FeedOrder.reserves(true, false, false, true), "nothing left");
		FeedOrder.Reserve r = new FeedOrder.Reserve();
		r.add(Map.of(COBBLE, 40), false);
		assertEquals(30, r.available(COBBLE, k -> 30));
	}

	@Test
	void exactBomsFedInAnyOrderFinishInFeedOrder() {
		// three targets, each needing 10 cobblestone; the stock grows 1 per tick; each tick the loop visits in order
		int[] left = {10, 10, 10};
		int stock = 0;
		List<Integer> finished = new ArrayList<>();
		for (int tick = 0; tick < 40 && finished.size() < 3; tick++) {
			stock++;
			FeedOrder.Reserve r = new FeedOrder.Reserve();
			for (int k = 0; k < 3; k++) {
				final int s = stock;
				int can = Math.min(left[k], r.available(COBBLE, x -> s));
				left[k] -= can;
				stock -= can;
				if (left[k] == 0 && !finished.contains(k)) {
					finished.add(k);
				}
				r.add(Map.of(COBBLE, left[k]), left[k] > 0);
			}
		}
		assertEquals(List.of(0, 1, 2), finished);
	}

	@Test
	void excessDropsTheLeastWholeStacks() {
		dev.larattalabs.architect.survival.StockLedger l = new dev.larattalabs.architect.survival.StockLedger();
		l.giveBack(Map.of(COBBLE, 130, DOOR, 3), 27, k -> 64);
		// 3 + 1 stacks; a capacity of 2 stacks: drop the 2 partial cobblestone, then a whole stack
		Map<String, Integer> ex = Stockpiles.excess(l, 2, k -> 64);
		assertEquals(Map.of(COBBLE, 66), ex);
	}
}
