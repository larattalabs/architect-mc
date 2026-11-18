package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.SiteWait;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8b review P2-6) A capped target's status read comes from the cap's retained data (its over-cap items, its start, its scope), never from
 * the materials walk ({@code view}, which needs the server and the target's run): here there is no server and no target at all. And its
 * cost over 200 capped targets (timing flags, never fails).
 */
class CapStatusViewTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		SiteWaits.txnHeld = r -> false; // no txn layer without a server
	}

	@AfterEach
	void clear() {
		SiteWaits.testClear();
	}

	@Test
	void aCapIsReadFromItsRetainedData() {
		SiteWaits.testCap("t1", Map.of("minecraft:iron_ingot", 4), 900L, "lot:a,region");
		SiteWait w = SiteWaits.statusView(null, "t1");
		assertNotNull(w, "answered without the server or the target's run");
		assertEquals(SiteWait.BILL_CAP, w.blocked());
		assertEquals(900L, w.waitingSince());
		assertEquals("lot:a,region", w.capScope());
		assertEquals(4, w.nextNeeded().get(0).count());
	}

	@Test
	void twoHundredCappedTargets() {
		for (int i = 0; i < 200; i++) {
			SiteWaits.testCap("t" + i, Map.of("minecraft:iron_ingot", 1 + i % 5, "minecraft:stone", 3), 900L + i, "region");
		}
		long best = Long.MAX_VALUE;
		for (int round = 0; round < 50; round++) {
			long t0 = System.nanoTime();
			for (int i = 0; i < 200; i++) {
				assertNotNull(SiteWaits.statusView(null, "t" + i));
			}
			best = Math.min(best, System.nanoTime() - t0);
		}
		System.out.println("[8b review P2-6] statusView over 200 capped targets: " + best / 1000 + " us");
		assertTrue(best < 50_000_000L);
	}
}
