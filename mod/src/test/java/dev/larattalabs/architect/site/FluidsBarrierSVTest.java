package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (8c SV) The target a survival region's fluids barrier names in its wait (RegionTargets.firstBuildingForFluids): a staged terrain target
 * still building first. c05 in survival (gate 8c-survival, run 20261118-095922): the header's paid shell target c1 (part fall) waits for
 * the island's staged target c3 (part isle) before it starts, and the wait said "waits for the isle's fall", untyped, while the island built.
 */
class FluidsBarrierSVTest {
	@Test
	void stagedTerrainTargetFirst() {
		var paid = new RegionTargets.Cand("c1", "fall", false, true);
		var grotto = new RegionTargets.Cand("c2", "grotto", true, false);
		var isle = new RegionTargets.Cand("c3", "isle", true, true);
		assertArrayEquals(new String[] {"c3", "isle"}, RegionTargets.stagedFirst(List.of(paid, grotto, isle)), "the building staged target, not the paid one before it");
		assertNull(RegionTargets.stagedFirst(List.of(paid, grotto)), "no staged target building: firstBuilding's choice");
		assertNull(RegionTargets.stagedFirst(List.of()), "no target");
	}
}
