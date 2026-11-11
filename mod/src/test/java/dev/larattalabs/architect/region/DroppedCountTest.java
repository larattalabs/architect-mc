package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.larattalabs.architect.placement.GhostModel;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (PX) A mask's dropped count is the entry's non-air blocks on masked cells: the template's air cells there are not blocks the realise
 * drops. The irrigation count used to include them (RegionsImpl.dropped), which inflated {@code irrigationDropped} and the provisional
 * cost range's subtraction.
 */
class DroppedCountTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	@Test
	void airOnTheMaskIsNotCounted() {
		BlockState stone = Blocks.STONE.defaultBlockState();
		BlockState air = Blocks.AIR.defaultBlockState();
		// a 2x2x1 template (x 0..1, y 0, z 0..1): stone, air, stone, air in cell order
		int[] xyz = {0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1};
		BlockState[] st = {stone, air, stone, air};
		GhostModel g = GhostModel.of(new GhostModel.Cells(2, 1, 2, 1, xyz, new int[] {0xFFFFFFFF, 0, 0xFFFFFFFF, 0}), 0);
		// the whole footprint masked, at origin (10, 64, 20): 2 stone blocks drop, the 2 air cells are not counted
		assertEquals(2, RegionsImpl.droppedBlocks(g, st, 10, 64, 20, p -> true));
		// only the air cells masked: nothing drops
		long a1 = BlockPos.asLong(11, 64, 20), a2 = BlockPos.asLong(11, 64, 21);
		assertEquals(0, RegionsImpl.droppedBlocks(g, st, 10, 64, 20, p -> p == a1 || p == a2));
		assertEquals(0, RegionsImpl.droppedBlocks(g, st, 10, 64, 20, null));
	}
}
