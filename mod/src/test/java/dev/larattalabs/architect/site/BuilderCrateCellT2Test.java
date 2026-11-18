package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * (slice T2b, DFG's item) A completed site restores its crate's cell only when the crate there is its own and unheld. A crate it can't read
 * as its own (another owner's tag, an adoption deferred it) or one a txn holds keeps its cell, so its stock is never lost with it. Failing
 * first: main restored the cell whenever it was loaded.
 */
class BuilderCrateCellT2Test {
	@Test
	void aForeignOrHeldCrateKeepsItsCell() {
		assertFalse(Builder.restoresCrateCell(true, false, true, false, true), "a foreign crate (not read as its own, its cell loaded)");
		assertFalse(Builder.restoresCrateCell(true, false, true, true, true), "a held crate");
	}

	@Test
	void anOwnCrateIsRestoredAsBefore() {
		assertTrue(Builder.restoresCrateCell(true, false, false, true, true));
		assertTrue(Builder.restoresCrateCell(true, false, false, false, true), "no block entity there any more, the cell loaded");
		assertFalse(Builder.restoresCrateCell(true, true, false, true, true), "kept for a sibling");
		assertFalse(Builder.restoresCrateCell(false, false, false, true, true), "no crate");
		assertFalse(Builder.restoresCrateCell(true, false, false, false, false), "not read, not loaded");
	}
}
