package dev.larattalabs.architect.site.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (6c close-out B; RS item 14, gate-runs-coB/20261023-050602-slice: road:street_e failed "the road changes no cell" over the town's own
 * targets on S3's natural claim) {@link Roads#heldByOwn}: a road with nothing to write is a no-op of its region only when every column it
 * would write is its own group's; one foreign column, a skipped span or a blocked column keeps it a failure.
 */
class RoadsHeldTest {
	static final Map<String, String> GROUPS = Map.of("c5", "g1", "c6", "g1", "s1", "g1", "c9", "g2");

	static RoadPlan.Plan plan(Map<String, Integer> ownedBy, Map<String, Integer> skipped, List<RoadPlan.Span> spans) {
		return new RoadPlan.Plan(List.of(), List.of(), null, null, skipped, ownedBy, 10, new int[0], spans);
	}

	@Test
	void everyColumnHeldByItsOwnRegionIsANoOp() {
		assertEquals(Map.of("c5", 30, "s1", 4), Roads.heldByOwn(plan(Map.of("c5", 30, "s1", 4), Map.of(), List.of()), "g1", GROUPS::get));
		assertEquals(Map.of("c5", 30), Roads.heldByOwn(plan(Map.of("c5", 30), Map.of("lantern", 2), List.of()), "g1", GROUPS::get), "a lantern without room left out");
	}

	@Test
	void oneForeignColumnOrAnyOtherStopStaysAFailure() {
		assertNull(Roads.heldByOwn(plan(Map.of("c5", 30, "c9", 1), Map.of(), List.of()), "g1", GROUPS::get), "another region's column");
		assertNull(Roads.heldByOwn(plan(Map.of("c5", 30, "x7", 1), Map.of(), List.of()), "g1", GROUPS::get), "an unknown site (no group)");
		assertNull(Roads.heldByOwn(plan(Map.of("c5", 30), Map.of("blocked", 1), List.of()), "g1", GROUPS::get), "a blocked column");
		assertNull(Roads.heldByOwn(plan(Map.of("c5", 30), Map.of(), List.of(new RoadPlan.Span(0, 1, "PROTECTED", "a protected area", 1, 64, 1))), "g1",
			GROUPS::get), "a skipped span");
		assertNull(Roads.heldByOwn(plan(Map.of("c5", 30), Map.of(), List.of()), null, GROUPS::get), "no group (a lone road)");
		assertNull(Roads.heldByOwn(plan(Map.of(), Map.of(), List.of()), "g1", GROUPS::get), "nothing owned: no columns at all");
	}
}
