package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (8c SV) The target a survival region's fluids barrier names in its wait (RegionTargets.firstBuildingForFluids): a staged terrain target
 * still building with the most cells left. c05 in survival (gate 8c-survival, run 20261118-095922): the header's paid shell target c1 (part fall) waits for
 * the island's staged target c3 (part isle) before it starts, and the wait said "waits for the isle's fall", untyped, while the island built;
 * then (run 20261118-101241) the first staged target, the grotto's one cell (c2), not the island.
 */
class FluidsBarrierSVTest {
	@Test
	void stagedTerrainTargetFirst() {
		var paid = new RegionTargets.Cand("c1", "fall", false, true, 0);
		var grotto = new RegionTargets.Cand("c2", "grotto", true, true, 1);
		var isle = new RegionTargets.Cand("c3", "isle", true, true, 7680);
		var built = new RegionTargets.Cand("c4", "isle", true, false, 0);
		assertArrayEquals(new String[] {"c3", "isle"}, RegionTargets.stagedFirst(List.of(paid, grotto, isle)), "the island (most cells left), not the paid shell before it nor the room's one cell");
		assertArrayEquals(new String[] {"c2", "grotto"}, RegionTargets.stagedFirst(List.of(paid, grotto, built)), "the one staged target still building");
		assertNull(RegionTargets.stagedFirst(List.of(paid, built)), "no staged target building: firstBuilding's choice");
		assertNull(RegionTargets.stagedFirst(List.of()), "no target");
	}
}
