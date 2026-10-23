package dev.larattalabs.architect.site.roads;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c close-out B; RS item 14, gate-runs-coB/20261023-050602-slice: road:street_e failed "the road changes no cell" over the town's own
 * targets on S3's natural claim) {@link Roads#heldByOwn}: a road with nothing to write is a no-op of its region only when every column it
 * would write is its own group's; one foreign column, a skipped span or a blocked column keeps it a failure.
 */
class RoadsHeldTest {
	@BeforeAll
	static void boot() {
		// (Roads' class init reads vanilla's registries: bootstrap first, or every later test in the JVM finds them broken)
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

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

	/** A flat road 0..20 at y 64 over dirt (top 63) whose every column holds built blocks at y 64-65 (the town's target wrote them). */
	static RoadPlan.Plan overBuilt(RoadPlan.Owned owned, int oreAtX) {
		RoadPlan.World w = (x, y, z) -> {
			if (y <= 63) {
				return RoadPlan.DIRT;
			}
			if (x == oreAtX && y == 65) {
				return RoadPlan.ORE;
			}
			return y <= 65 ? RoadPlan.BUILT : RoadPlan.AIR;
		};
		return RoadPlan.plan(new int[] {0, 20}, new int[] {64, 64}, new int[] {0, 0}, 3, false, false, w, owned);
	}

	@Test
	void columnsStoppedByItsOwnRegionsBlocksAreHeld() {
		// every built cell the town target c5's (gate-runs/20261023-061736-slice: owned {}, skipped {kept=4, blocked=8})
		RoadPlan.Plan own = overBuilt((x, y, z) -> y >= 64 && y <= 65 ? "c5" : null, Integer.MIN_VALUE);
		assertEquals(0, own.ops().size());
		assertEquals(Map.of("c5", own.blockedBy().get("c5")), Roads.heldByOwn(own, "g1", GROUPS::get));
		// a player's block (no site) in one column: a failure
		RoadPlan.Plan player = overBuilt((x, y, z) -> y >= 64 && y <= 65 && x != 7 ? "c5" : null, Integer.MIN_VALUE);
		assertNull(Roads.heldByOwn(player, "g1", GROUPS::get));
		// another region's block in one column: a failure
		RoadPlan.Plan foreign = overBuilt((x, y, z) -> y >= 64 && y <= 65 ? (x == 7 ? "c9" : "c5") : null, Integer.MIN_VALUE);
		assertNull(Roads.heldByOwn(foreign, "g1", GROUPS::get));
		// an exposed ore in one column (no site's, never cleared): a failure
		RoadPlan.Plan log = overBuilt((x, y, z) -> y >= 64 && y <= 65 ? "c5" : null, 7);
		assertNull(Roads.heldByOwn(log, "g1", GROUPS::get));
	}
}
