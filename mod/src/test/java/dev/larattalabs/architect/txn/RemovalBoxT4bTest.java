package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** (slice T4b, N3) A removal box resource: inclusive bounds, its own dimension only, never a malformed one. */
class RemovalBoxT4bTest {
	@Test
	void aRemovalBoxHoldsItsCellsOnly() {
		String r = RemovalTxn.box("minecraft:overworld", -5, 60, 10, 4, 70, 20);
		assertTrue(RemovalTxn.inBox(r, "minecraft:overworld", -5, 60, 10));
		assertTrue(RemovalTxn.inBox(r, "minecraft:overworld", 4, 70, 20));
		assertTrue(RemovalTxn.inBox(r, "minecraft:overworld", 0, 65, 15));
		assertFalse(RemovalTxn.inBox(r, "minecraft:overworld", 5, 65, 15));
		assertFalse(RemovalTxn.inBox(r, "minecraft:the_nether", 0, 65, 15));
		assertFalse(RemovalTxn.inBox("rbox:minecraft:overworld@1,2", "minecraft:overworld", 1, 2, 3));
	}
}
