package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.batch.WaitLimit;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (S8; 6a-staged's maxWait control, docs/FAST-CHECKS.md P1) A region's items wait without a time limit unless the caller set
 * {@code maxWaitSeconds}: the control (no maxWait) still waits NOT_LOADED after 102 s of re-checks with nothing failed, and with
 * maxWait 30 s the item times out once it has waited 30 s. Production's limit and count (WaitLimit, called by Batches.waitFor and
 * queueRegion); the loop and the failure message are Batches.waitFor's, copied. The in-game control runs at release
 * (6a-staged-full).
 */
class RegionWaitLimitTest {
	static QBatch region(int maxWaitSeconds) {
		JsonObject ext = new JsonObject();
		ext.addProperty(RegionItems.EXT_REGION, "rg1");
		return new QBatch("b1", null, ext, "g1", List.of(), List.of("ground"), WaitLimit.regionTicks(maxWaitSeconds), 16, false, false, true, false,
			null, 0L);
	}

	static QItem item() {
		return new QItem("t1", "ground", List.of(), "tile", "minecraft:overworld", 0, 64, 0, 0, false, new JsonObject(), null, false, false);
	}

	/** Re-checks every 20 ticks for {@code seconds}, as Batches.waitFor does for a waiting item (first wait, then repeats). */
	static void waitFor(QBatch b, QItem i, int seconds) {
		boolean first = true;
		for (int t = 0; t <= seconds * 20; t += 20) {
			if (WaitLimit.count(b, i, first, RegionItems.uncounted(b, Reason.NOT_LOADED), 20)) {
				i.fail(Reason.TIMED_OUT.name(), "waited " + i.waited / 20 + " s for: the claim is not loaded (walk closer)");
				return;
			}
			first = false;
			i.status = QItem.Status.WAITING;
			i.reason = Reason.NOT_LOADED.name();
		}
	}

	@Test
	void withoutMaxWaitARegionItemStillWaitsAfter102Seconds() {
		assertEquals(Long.MAX_VALUE, WaitLimit.regionTicks(0), "no maxWait: no limit");
		QBatch b = region(0);
		QItem i = item();
		waitFor(b, i, 102);
		assertNotEquals(QItem.Status.FAILED, i.status, "the control: not failed after 102 s (" + i.reason + ": " + i.message + ")");
		assertEquals(Reason.NOT_LOADED.name(), i.reason);
	}

	@Test
	void withMaxWait30TheItemFailsTimedOutWithItsWaitReason() {
		QBatch b = region(30);
		QItem i = item();
		waitFor(b, i, 40);
		assertEquals(QItem.Status.FAILED, i.status);
		assertEquals(Reason.TIMED_OUT.name(), i.reason);
		assertEquals(true, i.message.startsWith("waited 30 s for: the claim is not loaded"), i.message);
	}
}
