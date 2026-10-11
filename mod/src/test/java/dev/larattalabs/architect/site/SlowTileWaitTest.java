package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (6c 0a, coordinator 2026-10-10) A TILE_SLOW wait counts toward a region item's wait limit: with no {@code maxWaitSeconds} (the
 * default) the limit is unbounded, so it waits without a limit; with one set, every wait counts and it ends TIMED_OUT.
 */
class SlowTileWaitTest {
	static QBatch region(long maxWaitTicks) {
		JsonObject ext = new JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, "rg1");
		return new QBatch("b1", null, ext, "g1", List.of(), List.of("ground"), maxWaitTicks, 16, false, false, true, false, null, 0L);
	}

	@Test
	void tileSlowCountsTowardTheCallersCap() {
		QBatch unbounded = region(Long.MAX_VALUE);
		QBatch capped = region(600 * 20L);
		assertFalse(RegionItems.uncounted(unbounded, Reason.TILE_SLOW), "counted, but the limit is unbounded (S8: no cap by default)");
		assertFalse(RegionItems.uncounted(capped, Reason.TILE_SLOW), "maxWaitSeconds set: it counts (TIMED_OUT)");
		// as before: the staged waits don't count without a cap, and do with one
		assertTrue(RegionItems.uncounted(unbounded, Reason.SIDECAR_UNAVAILABLE));
		assertFalse(RegionItems.uncounted(capped, Reason.SIDECAR_UNAVAILABLE));
	}
}
