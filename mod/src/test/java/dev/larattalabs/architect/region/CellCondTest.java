package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The write conditions on real block states (CONTRACT §1 "Evaluation and conflicts"). Block tags are not bound in a unit test
 * (no datapack), so the tag-based natural-terrain cases are covered in game (gate item 6); these are the structural ones.
 */
class CellCondTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@Test
	void conditions() {
		var stone = Blocks.STONE.defaultBlockState();
		var air = Blocks.AIR.defaultBlockState();
		var water = Blocks.WATER.defaultBlockState();
		var bricks = Blocks.STONE_BRICKS.defaultBlockState();
		var chest = Blocks.CHEST.defaultBlockState();
		var log = Blocks.OAK_LOG.defaultBlockState();
		var grass = Blocks.SHORT_GRASS.defaultBlockState();
		var kelpWaterlogged = Blocks.OAK_STAIRS.defaultBlockState().setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED,
			true);
		assertTrue(CellCond.passes(Packed.IF_NATURAL, air, false));
		assertTrue(CellCond.passes(Packed.IF_NATURAL, water, false));
		assertFalse(CellCond.passes(Packed.IF_NATURAL, bricks, false));
		assertFalse(CellCond.passes(Packed.IF_NATURAL, chest, true), "never a block entity");
		assertFalse(CellCond.passes(Packed.IF_SOLID_NATURAL, air, false));
		assertFalse(CellCond.passes(Packed.IF_SOLID_NATURAL, water, false));
		assertFalse(CellCond.passes(Packed.IF_SOLID_NATURAL, grass, false));
		assertTrue(CellCond.passes(Packed.IF_AIR_OR_FLUID, air, false));
		assertTrue(CellCond.passes(Packed.IF_AIR_OR_FLUID, water, false));
		assertFalse(CellCond.passes(Packed.IF_AIR_OR_FLUID, stone, false));
		assertFalse(CellCond.passes(Packed.IF_AIR_OR_FLUID, kelpWaterlogged, false), "not a waterlogged block");
		assertTrue(CellCond.passes(Packed.ALWAYS_OURS, bricks, true));
		assertFalse(CellCond.passes(Packed.ALWAYS_OURS, bricks, false));
		assertFalse(CellCond.passes(Packed.ALWAYS_OURS, chest, true));
	}
}
