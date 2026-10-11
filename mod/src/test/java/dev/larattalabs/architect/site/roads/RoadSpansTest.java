package dev.larattalabs.architect.site.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 6c slice 0c §3 and gate item 2 (unit): failing centre columns mapped to waypoint segments, merged spans, partial roads planned
 * around them, NOT_LOADED still a whole-road refusal, protected columns as span-local refusals (C17).
 */
class RoadSpansTest {
	/** Five waypoints along x at z 0: four segments of 10 cells (segment k covers x 10k+1..10k+10; point 0's cell is segment 0's). */
	private static final int[] XS = {0, 10, 20, 30, 40};
	private static final int[] YS = {64, 64, 64, 64, 64};
	private static final int[] ZS = {0, 0, 0, 0, 0};

	private static final RoadPlan.Owned NONE = (x, y, z) -> null;

	/** Flat dirt with its top at y 63, plus the test's features. */
	private interface Feature {
		Integer at(int x, int y, int z);
	}

	private static RoadPlan.World world(Feature f) {
		return (x, y, z) -> {
			Integer k = f.at(x, y, z);
			if (k != null) {
				return k;
			}
			return y <= 63 ? RoadPlan.DIRT : RoadPlan.AIR;
		};
	}

	/**
	 * A trench 4 cells wide (x 24..27) and 14 deep across segment 2: no ground within 8 of the hint (TOO_STEEP). A step or wall
	 * can't fail TOO_STEEP: the ground search stops 8 above the hint, and the smoothed profile then needs at most 4 of cut or
	 * fill (the contract's "6-high step" needs 3).
	 */
	private static Integer wall(int x, int y, int z) {
		return x >= 24 && x <= 27 && z >= -3 && z <= 3 && y >= 50 && y <= 63 ? Integer.valueOf(RoadPlan.AIR) : null;
	}

	private static boolean anyOpIn(RoadPlan.Plan p, int x0, int x1) {
		return p.ops().stream().anyMatch(o -> o.x() >= x0 && o.x() <= x1);
	}

	@Test
	void flatRoadHasNoSpansAndMatchesThe4ePlan() {
		RoadPlan.World w = world((x, y, z) -> null);
		RoadPlan.Plan a = RoadPlan.plan(XS, YS, ZS, 3, true, false, w, NONE);
		RoadPlan.Plan b = RoadPlan.plan(XS, YS, ZS, 3, true, false, w, NONE, null, true);
		assertFalse(a.refused());
		assertTrue(a.spans().isEmpty());
		assertEquals(a.ops(), b.ops());
		assertEquals(a.cells(), b.cells());
	}

	@Test
	void aTrenchOnSegment2IsSpan2to3TooSteep() {
		RoadPlan.World w = world(RoadSpansTest::wall);
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, false);
		assertTrue(p.refused(), "without partial the trench refuses the road");
		assertEquals("TOO_STEEP", p.reason());
		assertEquals(List.of(2), p.spans().stream().map(RoadPlan.Span::fromPoint).toList());
		assertEquals(3, p.spans().get(0).toPoint());
		assertEquals("TOO_STEEP", p.spans().get(0).reason());
		assertEquals(p.refusal(), p.spans().get(0).message(), "the first span is the refusal");
		// partial: two runs, one plan with a gap over segment 2
		RoadPlan.Plan q = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, true);
		assertFalse(q.refused());
		assertEquals(1, q.spans().size());
		assertFalse(anyOpIn(q, 21, 30), "nothing written on segment 2");
		assertTrue(anyOpIn(q, 0, 20) && anyOpIn(q, 31, 40), "both runs written");
		assertTrue(q.notes().stream().anyMatch(n -> n.startsWith("skipped segment [2,3] (TOO_STEEP)")), q.notes().toString());
		// the runs match a plain road over their own waypoints, cell for cell
		RoadPlan.Plan left = RoadPlan.plan(new int[] {0, 10, 20}, new int[] {64, 64, 64}, new int[] {0, 0, 0}, 3, false, false, w, NONE);
		assertTrue(q.ops().containsAll(left.ops()));
	}

	@Test
	void deepWaterAndLavaAreSpansToo() {
		RoadPlan.World w = world((x, y, z) -> {
			if (x >= 14 && x <= 16 && y >= 61 && y <= 63) {
				return RoadPlan.WATER; // 3 deep on segment 1
			}
			if (x == 34 && y == 63 && z == 0) {
				return RoadPlan.LAVA; // segment 3
			}
			return null;
		});
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, false);
		assertTrue(p.refused());
		assertEquals("DEEP_WATER", p.reason(), "the first span is the refusal");
		assertEquals(2, p.spans().size());
		assertEquals(new RoadPlan.Span(1, 2, "DEEP_WATER", p.spans().get(0).message(), 14, 63, 0), p.spans().get(0));
		assertEquals(3, p.spans().get(1).fromPoint());
		assertEquals(4, p.spans().get(1).toPoint());
		assertEquals("LAVA", p.spans().get(1).reason());
		RoadPlan.Plan q = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, true);
		assertFalse(q.refused());
		assertFalse(anyOpIn(q, 11, 20));
		assertFalse(anyOpIn(q, 31, 40));
		assertTrue(anyOpIn(q, 0, 10) && anyOpIn(q, 21, 30));
	}

	@Test
	void neighbouringFailingSegmentsMerge() {
		RoadPlan.World w = world((x, y, z) -> {
			if ((x == 15 || x == 25) && y >= 61 && y <= 63) {
				return RoadPlan.WATER;
			}
			return null;
		});
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, false);
		assertEquals(1, p.spans().size());
		assertEquals(1, p.spans().get(0).fromPoint());
		assertEquals(3, p.spans().get(0).toPoint());
	}

	@Test
	void notLoadedRefusesTheWholeRoad() {
		RoadPlan.World w = world((x, y, z) -> x == 35 ? Integer.valueOf(RoadPlan.UNLOADED) : wall(x, y, z));
		for (boolean partial : new boolean[] {false, true}) {
			RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, partial);
			assertTrue(p.refused());
			assertEquals("NOT_LOADED", p.reason());
			assertTrue(p.spans().isEmpty());
		}
	}

	@Test
	void nothingLeftRefusesWithTheFirstSpan() {
		RoadPlan.World w = world((x, y, z) -> y >= 61 && y <= 63 ? RoadPlan.WATER : null);
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, true);
		assertTrue(p.refused());
		assertEquals("DEEP_WATER", p.reason());
		assertEquals(1, p.spans().size());
		assertEquals(0, p.spans().get(0).fromPoint());
		assertEquals(4, p.spans().get(0).toPoint());
	}

	@Test
	void protectedColumnsAreSpans() {
		RoadPlan.World w = world((x, y, z) -> null);
		// an area over x 12..14 on the centre line (segment 1) and one under the right-hand side cell only at x 36 (segment 3)
		RoadPlan.Protect protect = (x, z) -> x >= 12 && x <= 14 || x == 36 && z == 1 ? "area A" : null;
		RoadPlan.Plan p = RoadPlan.plan(XS, YS, ZS, 3, true, false, w, NONE, protect, false);
		assertTrue(p.refused());
		assertEquals("PROTECTED", p.reason());
		assertEquals(2, p.spans().size());
		assertEquals(1, p.spans().get(0).fromPoint());
		assertEquals(3, p.spans().get(1).fromPoint());
		RoadPlan.Plan q = RoadPlan.plan(XS, YS, ZS, 3, true, false, w, NONE, protect, true);
		assertFalse(q.refused());
		for (RoadPlan.Op o : q.ops()) {
			assertNull(protect.at(o.x(), o.z()), "no op in a protected column: " + o);
		}
		assertTrue(anyOpIn(q, 0, 10) && anyOpIn(q, 21, 30));
		assertNotNull(q.spans());
	}

	@Test
	void aRunShorterThanTwoIsLeftOut() {
		// segments 0 and 2 fail; segment 1's run is 10 cells (kept). Points 0 and 1 only: segment 0 fails, the lone cell of point 0 stays out
		RoadPlan.World w = world((x, y, z) -> x >= 3 && x <= 5 && y >= 61 && y <= 63 ? RoadPlan.WATER : null);
		RoadPlan.Plan q = RoadPlan.plan(XS, YS, ZS, 3, false, false, w, NONE, null, true);
		assertFalse(q.refused());
		assertFalse(anyOpIn(q, 0, 10));
		RoadPlan.Plan two = RoadPlan.plan(new int[] {0, 1, 10}, new int[] {64, 64, 64}, new int[] {0, 0, 0}, 1, false, false, world((x, y, z) -> x >= 3
			&& x <= 5 && y >= 61 && y <= 63 ? RoadPlan.WATER : null), NONE, null, true);
		// segment 0 (x 1) is fine, segment 1 fails: the run x 0..1 is 2 cells and stays
		assertFalse(two.refused());
		assertTrue(anyOpIn(two, 0, 1));
	}
}
