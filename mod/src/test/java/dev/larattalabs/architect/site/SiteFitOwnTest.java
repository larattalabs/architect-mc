package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.VoxelClass;
import java.util.HashSet;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7b SL-b) A region's site lot never drifts on its own region's writes (docs/CONTRACT.md "Slice SL-b as built"): the drift check
 * leaves out the cells the lot's region already wrote (a neighbour lot's house in this site's margin); anyone else's change still
 * drifts. The region group is scoped to the site lot's checks only.
 */
class SiteFitOwnTest {
	@Test
	void theRegionGroupIsScopedToASiteLotsChecks() throws Exception {
		assertNull(SiteFit.regionGroupNow());
		dev.larattalabs.architect.api.SiteSpec none = null;
		assertNull(SiteFit.with(none, "g7", SiteFit::regionGroupNow), "a plain placement carries no region group");
		assertNull(SiteFit.with(none, SiteFit::regionGroupNow));
		assertNull(SiteFit.regionGroupNow(), "popped after");
		assertTrue(SiteFit.ownCells(null, "minecraft:overworld", new BoundingBox(0, 0, 0, 3, 3, 3)).isEmpty(), "no group: nothing left out");
		assertTrue(SiteFit.ownCells("g7", null, new BoundingBox(0, 0, 0, 3, 3, 3)).isEmpty(), "no dimension: nothing left out");
	}

	@Test
	void theOwnCellsAreLeftOutOfTheDriftOnly() {
		BoundingBox vol = new BoundingBox(0, 0, 0, 3, 3, 3);
		int air = VoxelClass.AIR.ordinal(), rock = VoxelClass.ROCK.ordinal();
		SiteFit.Classes frozen = (x, y, z) -> air;
		// a neighbour's house wrote two cells (rock now), a stranger one more
		Set<Long> neighbour = Set.of(BlockPos.asLong(1, 1, 1), BlockPos.asLong(2, 1, 1));
		long stranger = BlockPos.asLong(3, 3, 3);
		SiteFit.Classes live = (x, y, z) -> neighbour.contains(BlockPos.asLong(x, y, z)) || BlockPos.asLong(x, y, z) == stranger ? rock : air;
		assertEquals(3, SiteFit.drift(vol, frozen, live, Set.of()).drifted(), "every change drifts without the region's own cells");
		Set<Long> skip = new HashSet<>(neighbour);
		SiteFit.Drift d = SiteFit.drift(vol, frozen, live, skip);
		assertEquals(1, d.drifted(), "the region's own writes left out; the stranger's change still drifts");
		assertEquals(64 - 2, d.compared());
	}
}
