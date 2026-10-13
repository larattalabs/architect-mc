package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.material.Fluids;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 6c PT §2: what a player's use records. A block item records every cell within 2 of the click going from air, a fluid or a
 * replaceable block to a block (a slab made double, a candle more, at the click); a bucket its placed source; a hoe, shovel or axe
 * the converted cell within 1; anything else nothing (bone meal, fire, spawn eggs). §3: air and fluids are never tracked.
 */
class RecordRulesTest {
	@BeforeAll
	static void boot() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
	}

	static PlacedRules.Use use(PlacedRules.Kind k, BlockPos click) {
		return new PlacedRules.Use(null, PlacedChunk.NIL, k, click, Direction.UP);
	}


	@Test
	void blockItems() {
		BlockState AIR = Blocks.AIR.defaultBlockState();
		BlockState STONE = Blocks.STONE.defaultBlockState();
		BlockPos c = new BlockPos(10, 64, 10);
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, AIR, STONE));
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c.above(), AIR, Blocks.OAK_DOOR.defaultBlockState()), "a door's upper half");
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, Blocks.SHORT_GRASS.defaultBlockState(), STONE), "over a replaceable plant");
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, Blocks.WATER.defaultBlockState(), Blocks.LILY_PAD.defaultBlockState()), "from a fluid");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c.offset(3, 0, 0), AIR, STONE), "farther than 2 from the click");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, STONE, Blocks.GRANITE.defaultBlockState()), "a block replaced in place (not replaceable)");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, AIR, AIR), "air is never tracked");
		BlockState slab = Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.TYPE, SlabType.BOTTOM);
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c, slab, slab.setValue(SlabBlock.TYPE, SlabType.DOUBLE)), "a slab made double at the click");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c.offset(1, 0, 0), slab, slab.setValue(SlabBlock.TYPE, SlabType.DOUBLE)),
			"not beside the click (a neighbour's shape update)");
		BlockState fence = Blocks.OAK_FENCE.defaultBlockState();
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BLOCK, c), c.offset(1, 0, 0), fence, fence.setValue(net.minecraft.world.level.block.FenceBlock.WEST,
			true)), "a neighbour's shape update records nothing");
	}

	@Test
	void bucketsAndTools() {
		BlockState AIR = Blocks.AIR.defaultBlockState();
		BlockPos c = new BlockPos(0, 64, 0);
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.BUCKET, c), c.above(), AIR, Blocks.WATER.defaultBlockState()), "the placed source");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.BUCKET, c), c.above(), AIR, Fluids.FLOWING_WATER.getFlowing(3, false).createLegacyBlock()),
			"flowing fluid never");
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.TOOL, c), c, Blocks.DIRT.defaultBlockState(), Blocks.FARMLAND.defaultBlockState()), "hoe: farmland");
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.TOOL, c), c, Blocks.GRASS_BLOCK.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()), "shovel");
		assertTrue(PlacedRules.records(use(PlacedRules.Kind.TOOL, c), c, Blocks.OAK_LOG.defaultBlockState(), Blocks.STRIPPED_OAK_LOG.defaultBlockState()), "axe");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.TOOL, c), c.offset(2, 0, 0), Blocks.DIRT.defaultBlockState(), Blocks.FARMLAND.defaultBlockState()),
			"a tool within 1 only");
		assertFalse(PlacedRules.records(use(PlacedRules.Kind.NONE, c), c.above(), AIR, Blocks.FIRE.defaultBlockState()), "fire, bone meal: nothing");
	}

	@Test
	void emptyCells() {
		BlockState AIR = Blocks.AIR.defaultBlockState();
		assertTrue(PlacedRules.empty(AIR));
		assertTrue(PlacedRules.empty(Blocks.WATER.defaultBlockState()));
		assertTrue(PlacedRules.empty(Blocks.LAVA.defaultBlockState()));
		assertFalse(PlacedRules.empty(Blocks.OAK_LOG.defaultBlockState()));
		assertFalse(PlacedRules.empty(Blocks.OAK_SLAB.defaultBlockState().setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.WATERLOGGED,
			true)), "a waterlogged block is a block (waterlogging keeps its record)");
	}
}
