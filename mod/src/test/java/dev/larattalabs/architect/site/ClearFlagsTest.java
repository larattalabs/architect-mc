package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import net.minecraft.world.level.block.Block;
import org.junit.jupiter.api.Test;

/**
 * Clearing a construction site's queued cells pops nothing off: {@code Level.setBlock} runs neighbour shape updates unless
 * UPDATE_KNOWN_SHAPE is set, and runs them with UPDATE_SUPPRESS_DROPS stripped, so a door's lower half, a bed's other half or a
 * hanging lantern would drop its item while the builder places the block again (a free item).
 */
class ClearFlagsTest {
	@Test
	void clearSkipsShapeUpdatesAndDrops() {
		assertEquals(Block.UPDATE_KNOWN_SHAPE, Builder.CLEAR_FLAGS & Block.UPDATE_KNOWN_SHAPE, "no neighbour shape updates (they drop items)");
		assertEquals(Block.UPDATE_SUPPRESS_DROPS, Builder.CLEAR_FLAGS & Block.UPDATE_SUPPRESS_DROPS, "no drops of the cleared cells");
		assertEquals(0, Builder.CLEAR_FLAGS & Block.UPDATE_NEIGHBORS, "no neighbour updates");
		assertEquals(Sites.FLAGS, Builder.CLEAR_FLAGS & ~Block.UPDATE_KNOWN_SHAPE, "otherwise the placement's flags");
	}
}
