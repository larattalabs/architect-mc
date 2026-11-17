package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.StockLedger;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (ADP) adoptCrates and a crate it could not read. Before ADP every crate of the owner had its cell restored and its journal kind released,
 * and every target lost its crate reference, whether or not the crate's block entity was read and its stock credited: an unreadable crate
 * (its block entity missing, another owner's, read off the server thread) lost its stock. Now a crate is taken only when it reads as its
 * owner's, after its credit was saved (JOIN, FINISH); a reference is cleared only when its crate's key is credited and no crate block stands
 * there; what is over capacity drops last ({@code overCapacity}).
 */
class StockpileAdoptADPTest {
	static final String AT = "@" + new BlockPos(10, 64, -5).asLong();

	@Test
	void onlyAReadCrateIsTaken() {
		assertEquals(Stockpiles.CrateFate.JOIN, Stockpiles.crateFate(true, false, true), "read, not credited: credited and saved, then taken");
		assertEquals(Stockpiles.CrateFate.FINISH, Stockpiles.crateFate(true, true, true), "read, credited (stopped after its credit's save): taken");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, false, true), "another owner's crate (base: restored, its stock lost)");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, false, false), "nothing credited, no crate: nothing to take or clear");
		assertEquals(Stockpiles.CrateFate.JOINED, Stockpiles.crateFate(false, true, false), "credited and gone: only the references");
		assertEquals(Stockpiles.CrateFate.DEFER, Stockpiles.crateFate(false, true, true), "credited, but another owner's crate stands there: kept");
	}

	@Test
	void theOverflowDropsLastAndOnlyWhatDoesNotFit() {
		java.util.function.ToIntFunction<String> max = k -> 64;
		StockLedger l = new StockLedger();
		// 3 stacks of stone and 10 dirt credited uncapped (the adoption's first step): over a 2-stack capacity
		l.adopt("adopt:s1@1", Map.of("minecraft:stone", 192, "minecraft:dirt", 10), Map.of(), Integer.MAX_VALUE, max);
		assertTrue(l.dropped().isEmpty(), "the credit drops nothing");
		Map<String, Integer> out = Stockpiles.overCapacity(l, Map.of("minecraft:stone", 192, "minecraft:dirt", 10), 2, max);
		assertEquals(Map.of("minecraft:dirt", 10, "minecraft:stone", 64), out, "the partial stack first, then whole stacks, until it fits");
		assertEquals(out, l.dropped(), "booked as dropped, exactly what is returned to drop as items");
		assertTrue(l.usedStacks(max) <= 2);
		assertEquals(Map.of(), Stockpiles.overCapacity(l, Map.of("minecraft:stone", 128), 2, max), "within capacity: nothing more");
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
