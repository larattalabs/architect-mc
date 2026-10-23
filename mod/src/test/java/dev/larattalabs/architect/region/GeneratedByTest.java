package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import net.minecraft.world.level.ChunkPos;
import org.junit.jupiter.api.Test;

/**
 * fix/survival-off-storm: a chunk generated while a region realises is charged to the region only when it is the region's (its
 * dimension, and its claim + 2 chunks or its batch's tickets). Steward's RC saw a player's view after a {@code /spreadplayers} (about
 * 190 chunks from the claim, no ticket) charged to a survival region still placing, as "1000 chunks generated outside the claim + 2".
 */
class GeneratedByTest {
	private static final String OW = "minecraft:overworld";
	// rg10's claim in Steward's RC (x 10690..10850, z 38900..39060): chunks 668..678 x 2431..2441
	private static final int[] CLAIM = {10690, -64, 38900, 10850, 320, 39060};

	private static long chunk(int cx, int cz) {
		return ChunkPos.pack(cx, cz);
	}

	@Test
	void theRegionsOwnChunks() {
		assertTrue(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(670, 2435), null), "in the claim");
		assertTrue(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(668 - 2, 2431 - 2), null), "the claim + 2's corner");
		assertTrue(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(678 + 2, 2441 + 2), null), "the far corner");
		assertTrue(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(900, 900), "b16/t:lots|a|1,2"), "outside, but its batch's ticket holds it");
	}

	@Test
	void theWorldsChunks() {
		// the RC's chunks: round the teleport's target (731, 2625), a player 2..16 chunks away, no ticket
		assertFalse(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(729, 2622), null), "a player's view far from the claim");
		assertFalse(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(668 - 3, 2435), null), "one chunk past claim + 2");
		assertFalse(RegionsImpl.generatedBy(OW, CLAIM, "b16", OW, chunk(900, 900), "b17/t:lots|a|1,2"), "another batch's ticket");
		assertFalse(RegionsImpl.generatedBy(OW, CLAIM, "b1", OW, chunk(900, 900), "b16/t:x"), "a batch id that is only a prefix");
		assertFalse(RegionsImpl.generatedBy(OW, CLAIM, "b16", "minecraft:the_nether", chunk(670, 2435), null), "another dimension");
	}
}
