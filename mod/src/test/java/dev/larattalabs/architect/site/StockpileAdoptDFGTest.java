package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (DFG, ADP's DEFER guard) adoptCrates and a crate it could not read. Before DFG every crate of the owner had its cell restored and its
 * journal kind released, and every target lost its crate reference, whether or not the crate's block entity was read and its stock
 * credited: an unreadable crate (its block entity another owner's, missing, read off the server thread) lost its stock. Now a crate is
 * taken only when it reads as its owner's (JOIN); a read cell with no crate left has its references cleared (JOINED when credited, GONE
 * when not: nothing to take); a crate standing under another tag, or a cell not read, is deferred, untouched. The in-game half is gate step dfg-defer.
 */
class StockpileAdoptDFGTest {
	@Test
	void onlyAReadCrateIsTaken() {
		assertEquals(Stockpiles.CrateFate.JOIN, Stockpiles.crateFate(true, false, true, true), "read, not credited: adopted");
		assertEquals(Stockpiles.CrateFate.JOIN, Stockpiles.crateFate(true, true, true, true), "read, credited: main's path (the ledger's adopt is keyed: once)");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, false, true, true), "another owner's crate (base: restored, its stock lost)");
		assertEquals(Stockpiles.CrateFate.JOINED, Stockpiles.crateFate(false, true, false, true), "credited and gone: only the references");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, true, true, true), "credited, but another owner's crate stands there: kept");
	}

	@Test
	void aMissingUncreditedCrateFreesItsTargets() {
		// (DFG fix round, GPT P1) the cell read, no crate of any owner there, nothing credited: nothing to take, so main's path (the references
		// cleared, a building target fed from the stockpile). Deferring it kept a building target waiting for a crate that does not exist
		assertEquals(Stockpiles.CrateFate.GONE, Stockpiles.crateFate(false, false, false, true));
	}

	@Test
	void anUnknownCellIsDeferred() {
		// off the server thread, or its chunk not loaded: nothing is known, so nothing is restored, released or cleared, credited or not
		for (boolean credited : new boolean[] {false, true}) {
			for (boolean block : new boolean[] {false, true}) {
				assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, credited, block, false));
			}
		}
	}

	@Test
	void anUnreadCrateIsNeverTaken() {
		// every combination: a crate that is not read is never JOIN, and a crate block of any owner standing there is never released or cleared
		for (boolean credited : new boolean[] {false, true}) {
			for (boolean block : new boolean[] {false, true}) {
				for (boolean known : new boolean[] {false, true}) {
					assertNotEquals(Stockpiles.CrateFate.JOIN, Stockpiles.crateFate(false, credited, block, known));
					if (block) {
						assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, credited, true, known));
					}
				}
			}
		}
	}

	@Test
	void aDeferredCrateWasNeverCredited() {
		// the keys adoptCrates reads: a crate deferred now has no credited key, so the start's repair (namesJoined) never clears its targets
		Set<String> none = Set.of();
		assertFalse(Stockpiles.namesJoined(none::contains, "s3", "g2", 10, 64, -5));
		String at = "@" + new net.minecraft.core.BlockPos(10, 64, -5).asLong();
		assertTrue(Stockpiles.namesJoined(Set.of("adopt:group:g2" + at)::contains, "s3", "g2", 10, 64, -5));
	}
}
