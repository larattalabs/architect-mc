package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** C16's free road cells (0c §7, extended in 6c V): a dirt path on any block a shovel paths costs nothing; other cells cost. */
class RoadFreeCellTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void aDirtPathOnShovelPathableGroundIsFree() {
		for (Block b : new Block[] {Blocks.GRASS_BLOCK, Blocks.DIRT, Blocks.COARSE_DIRT, Blocks.PODZOL, Blocks.MYCELIUM, Blocks.ROOTED_DIRT}) {
			assertTrue(RoadBuilder.freeCell(b.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()), b.toString());
		}
	}

	@Test
	void everythingElseCosts() {
		assertFalse(RoadBuilder.freeCell(Blocks.SAND.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()));
		assertFalse(RoadBuilder.freeCell(Blocks.STONE.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()));
		assertFalse(RoadBuilder.freeCell(Blocks.MUD.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()));
		assertFalse(RoadBuilder.freeCell(Blocks.GRASS_BLOCK.defaultBlockState(), Blocks.GRAVEL.defaultBlockState()), "only the path itself is free");
		assertFalse(RoadBuilder.freeCell(Blocks.DIRT.defaultBlockState(), Blocks.PACKED_MUD.defaultBlockState()));
		assertFalse(RoadBuilder.freeCell(Blocks.AIR.defaultBlockState(), Blocks.DIRT_PATH.defaultBlockState()), "a filled cell costs its dirt");
	}
}
