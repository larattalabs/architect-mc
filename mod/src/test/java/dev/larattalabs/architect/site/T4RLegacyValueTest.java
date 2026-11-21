package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SlabType;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-L, rows T4RL-P1-2 and T4RL-P1-3 of the T4R final check of 9913d902) What one journal cell of a pre-T4R credit is worth to its
 * converted refund ({@link CrateSettle#legacyItems}, the value {@code foundIn} records before the W's first write): what the W itself removes
 * there, valued by the survival cost of the block standing (SurvivalItems, the real items and counts). A cell the W does not remove pays
 * nothing, whether a player mined it or an old job restored it. The base (9913d902) counted "matches its before" as found (a block mined to
 * a before of air paid) and one item of the placed block per cell (a double slab paid one slab of two).
 */
class T4RLegacyValueTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@Test
	void aLegacyCellIsWorthWhatItsWRemoves() {
		System.out.println("ROW T4RL-P1-2/P1-3 (unit)");
		BlockState dbl = Blocks.STONE_SLAB.defaultBlockState().setValue(BlockStateProperties.SLAB_TYPE, SlabType.DOUBLE);
		BlockState half = Blocks.STONE_SLAB.defaultBlockState();
		Map<String, Integer> d = CrateSettle.legacyItems(dbl, "minecraft:stone_slab", "minecraft:air");
		Map<String, Integer> mined = CrateSettle.legacyItems(Blocks.AIR.defaultBlockState(), "minecraft:oak_planks", "minecraft:air");
		Map<String, Integer> restored = CrateSettle.legacyItems(Blocks.STONE.defaultBlockState(), "minecraft:gravel", "minecraft:stone");
		Map<String, Integer> standing = CrateSettle.legacyItems(Blocks.GRAVEL.defaultBlockState(), "minecraft:gravel", "minecraft:stone");
		Map<String, Integer> other = CrateSettle.legacyItems(Blocks.COBBLESTONE.defaultBlockState(), "minecraft:oak_planks", "minecraft:air");
		Map<String, Integer> halfLeft = CrateSettle.legacyItems(half, "minecraft:stone_slab", "minecraft:air");
		System.out.println("ROW T4RL-P1-3 double slab " + d + "; P1-2 mined to a before of air " + mined + "; restored before the upgrade " + restored
			+ "; standing " + standing + "; a player's other block " + other + "; a single slab where a double was placed " + halfLeft);
		assertEquals(Map.of("minecraft:stone_slab", 2), d, "T4RL-P1-3: a double slab the W removes is worth its real cost, two slabs");
		assertEquals(Map.of(), mined, "T4RL-P1-2: a cell mined to its before (air) is not the W's to remove: it pays nothing");
		assertEquals(Map.of(), restored, "T4RL: a cell standing as its before is not the W's to remove: it pays nothing (W-time accounting)");
		assertEquals(Map.of("minecraft:gravel", 1), standing, "T4RL: a paid block standing is the W's to remove: its cost");
		assertEquals(Map.of(), other, "T4RL: a block that is not the placement's pays nothing");
		assertEquals(Map.of("minecraft:stone_slab", 1), halfLeft, "T4RL: what stands is what the W removes: a single slab is one");
	}
}
