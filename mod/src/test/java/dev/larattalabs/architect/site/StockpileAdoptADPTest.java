package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (ADP) adoptCrates and a crate it could not read. Before ADP every crate of the owner had its cell restored and its journal kind released,
 * and every target lost its crate reference, whether or not the crate's block entity was read and its stock credited: an unreadable crate
 * (its block entity missing, another owner's, read off the server thread) lost its stock. Now a crate is restored and released only when
 * read and credited now ({@code JOIN}); a reference is cleared only when its crate's key is credited and no crate of that owner stands there.
 */
class StockpileAdoptADPTest {
	static final String AT = "@" + new BlockPos(10, 64, -5).asLong();

	@Test
	void onlyAReadUncreditedCrateIsTakenAndRestored() {
		assertEquals(Stockpiles.CrateFate.JOIN, Stockpiles.crateFate(true, false), "read, not credited: credited, taken, restored, released");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, false), "unread (base: restored and released, its stock lost): left intact");
		assertEquals(Stockpiles.CrateFate.JOINED, Stockpiles.crateFate(false, true), "joined before (SAC2): nothing to do with the block");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(true, true), "credited but standing: never taken (the ledger would not add it)");
	}

	@Test
	void aDeferredCrateKeepsItsTargetsReferences() {
		Set<String> none = Set.of();
		// a crate deferred now: its key never credited, so no reference to it is cleared (base cleared them all)
		boolean credited = Stockpiles.namesJoined(none::contains, "s3", "g2", 10, 64, -5);
		assertFalse(Stockpiles.clearsReference(credited, true), "an unreadable crate standing: kept");
		assertFalse(Stockpiles.clearsReference(credited, false), "an unreadable crate gone: kept (nothing credited)");
		// joined (now or before) and gone: cleared, its group's key or its own
		Set<String> joined = Set.of("adopt:group:g2" + AT);
		assertTrue(Stockpiles.clearsReference(Stockpiles.namesJoined(joined::contains, "s3", "g2", 10, 64, -5), false));
		assertTrue(Stockpiles.clearsReference(Stockpiles.namesJoined(Set.of("adopt:s3" + AT)::contains, "s3", null, 10, 64, -5), false));
		// credited but its crate still stands with its stock: kept (clearing it would orphan the stock)
		assertFalse(Stockpiles.clearsReference(Stockpiles.namesJoined(joined::contains, "s3", "g2", 10, 64, -5), true));
	}
}
