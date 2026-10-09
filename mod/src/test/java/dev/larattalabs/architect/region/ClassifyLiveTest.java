package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;

/**
 * E-normal's {@code live} class (phase 6a): a same-block block-entity mismatch counts as the world's own doing only on blocks the
 * world itself changes; on any other block it is unexplained ({@code none}), so {@code live} can't mask a real block-entity error.
 */
class ClassifyLiveTest {
	@Test
	void liveOnlyOnBlocksTheWorldChanges() {
		assertEquals("live", LiveBlocks.sameBlockChange("minecraft:bee_nest[facing=north,honey_level=0]{Bees:[]}",
			"minecraft:bee_nest[facing=north,honey_level=1]{Bees:[{TicksInHive:20}]}"));
		assertEquals("live", LiveBlocks.sameBlockChange("minecraft:furnace[facing=east,lit=false]{BurnTime:0s}",
			"minecraft:furnace[facing=east,lit=true]{BurnTime:120s}"));
		assertEquals("live", LiveBlocks.sameBlockChange("minecraft:hopper[enabled=true,facing=down]{TransferCooldown:0}",
			"minecraft:hopper[enabled=true,facing=down]{TransferCooldown:8}"));
		assertEquals("none", LiveBlocks.sameBlockChange("minecraft:chest[facing=north,type=single,waterlogged=false]{LootTable:\"minecraft:chests/village\"}",
			"minecraft:chest[facing=north,type=single,waterlogged=false]{Items:[]}"), "a chest whose loot resolved is not the world's doing");
		assertEquals("none", LiveBlocks.sameBlockChange("minecraft:oak_sign[rotation=0,waterlogged=false]{front_text:{}}",
			"minecraft:oak_sign[rotation=0,waterlogged=false]"), "a sign that lost its text");
		assertNull(LiveBlocks.sameBlockChange("minecraft:stone", "minecraft:dirt"), "another block: not this class");
		assertNull(LiveBlocks.sameBlockChange("minecraft:grass_block[snowy=false]", "minecraft:grass_block[snowy=true]"), "no block entity");
		assertEquals("minecraft:bee_nest", LiveBlocks.block("minecraft:bee_nest{Bees:[]}"));
	}
}
