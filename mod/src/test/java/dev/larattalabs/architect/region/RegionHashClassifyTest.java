package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** (6b) E-normal's classifier: a plant a sheep ate during a scenario's 2-minute stand is the world's doing. */
class RegionHashClassifyTest {
	@Test
	void grazed() {
		assertTrue(LiveBlocks.grazed("minecraft:short_grass", "minecraft:air"));
		assertTrue(LiveBlocks.grazed("minecraft:tall_grass[half=lower]", "minecraft:air"));
		assertFalse(LiveBlocks.grazed("minecraft:short_grass", "minecraft:stone"));
		assertFalse(LiveBlocks.grazed("minecraft:oak_planks", "minecraft:air"));
	}
}
