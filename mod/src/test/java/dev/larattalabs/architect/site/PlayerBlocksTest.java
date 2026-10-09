package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.region.volume.VoxelTable;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** PLAYER_BLOCKS' scope and cell classification (CONTRACT phase 6b §7.3 case (a)), without a world. */
class PlayerBlocksTest {
	@Test
	void onlyLotsOnRegionPads() {
		assertTrue(PlayerBlocks.scoped(true, false, List.of("architect:terrain")));
		assertTrue(PlayerBlocks.scoped(true, false, List.of("road", "architect:path")));
		assertFalse(PlayerBlocks.scoped(false, false, List.of("architect:terrain")), "REFUSE callers: unchanged");
		assertFalse(PlayerBlocks.scoped(true, true, List.of("architect:terrain")), "force overrides it (as BLOCK_ENTITIES)");
		assertFalse(PlayerBlocks.scoped(true, false, List.of()), "a LAYER placement over nothing: unchanged");
		assertFalse(PlayerBlocks.scoped(true, false, List.of("site", "road", "cells")), "LAYER over sites, roads, cell sites: unchanged");
	}

	@Test
	void cellClassification() {
		VoxelTable t = VoxelTable.get();
		assertTrue(PlayerBlocks.playerBlock(t.of("minecraft:oak_planks"), false, false));
		assertTrue(PlayerBlocks.playerBlock(t.of("minecraft:glass"), false, false));
		assertFalse(PlayerBlocks.playerBlock(t.of("minecraft:oak_planks"), false, true), "owned by an entry: ours");
		assertFalse(PlayerBlocks.playerBlock(t.of("minecraft:chest"), true, false), "a block entity refuses BLOCK_ENTITIES instead");
		for (String natural : new String[] {"minecraft:stone", "minecraft:dirt", "minecraft:grass_block", "minecraft:oak_log", "minecraft:water",
			"minecraft:sand", "minecraft:short_grass"}) {
			assertFalse(PlayerBlocks.playerBlock(t.of(natural), false, false), natural);
		}
		assertEquals(VoxelClass.PLAYER, t.of("minecraft:cobblestone"), "cobblestone is not natural in the 26.3 table");
	}

	@Test
	void namesUpToFour() {
		List<BlockPos> five = List.of(new BlockPos(1, 2, 3), new BlockPos(1, 3, 3), new BlockPos(1, 4, 3), new BlockPos(1, 5, 3));
		String m = PlayerBlocks.message(five, 9);
		assertTrue(m.startsWith("The player's own blocks inside a lot: 9 blocks (1, 2, 3; 1, 3, 3; 1, 4, 3; 1, 5, 3; ...)"), m);
		assertTrue(PlayerBlocks.message(List.of(new BlockPos(0, 64, 0)), 1).contains("1 block (0, 64, 0)"));
	}
}
