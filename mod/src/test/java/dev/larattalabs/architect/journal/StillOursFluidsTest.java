package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6c H §4.3) "Still ours" for fluids: a cell an entry wrote as a water source or an ice cap holds in any water state, as ice or frosted
 * ice, or as air; a lava source in any lava state or as air; nothing else changes (a player's block in a pond is not the entry's).
 */
class StillOursFluidsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void fluids() {
		BlockState water = Blocks.WATER.defaultBlockState(), lava = Blocks.LAVA.defaultBlockState();
		BlockState flowing = water.setValue(LiquidBlock.LEVEL, 3), falling = water.setValue(LiquidBlock.LEVEL, 8);
		for (BlockState now : new BlockState[] {water, flowing, falling, Blocks.ICE.defaultBlockState(), Blocks.FROSTED_ICE.defaultBlockState(), Blocks.AIR
			.defaultBlockState()}) {
			assertTrue(StillOurs.holds(now, null, water, null), "water source after, now " + now);
			assertTrue(StillOurs.holds(now, null, Blocks.ICE.defaultBlockState(), null), "ice cap after, now " + now);
		}
		assertFalse(StillOurs.holds(Blocks.COBBLESTONE.defaultBlockState(), null, water, null), "a player's block in a pond is kept");
		assertFalse(StillOurs.holds(lava, null, water, null));
		assertTrue(StillOurs.holds(lava.setValue(LiquidBlock.LEVEL, 2), null, lava, null));
		assertTrue(StillOurs.holds(Blocks.AIR.defaultBlockState(), null, lava, null));
		assertFalse(StillOurs.holds(Blocks.OBSIDIAN.defaultBlockState(), null, lava, null));
		// nothing else changes: a flowing state written (never by H) is no source; stone stays stone
		assertFalse(StillOurs.fluidHolds(Blocks.AIR.defaultBlockState(), flowing));
		assertFalse(StillOurs.fluidHolds(Blocks.WATER.defaultBlockState(), Blocks.STONE.defaultBlockState()));
	}
}
