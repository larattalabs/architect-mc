package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.RemovalStop;
import dev.larattalabs.architect.api.RemovalStopCause;
import org.junit.jupiter.api.Test;

/** (S-DRS-1) A region's stop cause is saved with its record; a record saved before it reads OTHER; no stop, no cause. */
class RegionRecStopCauseTest {
	private static RegionRec rec() {
		return new RegionRec("rg3", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 0, 0, 15, 15, 15}, 1L);
	}

	private static RegionRec back(RegionRec r) {
		return RegionRec.fromJson(JsonParser.parseString(r.toJson().toString()).getAsJsonObject());
	}

	@Test
	void eachCauseRoundTrips() {
		for (RemovalStopCause c : RemovalStopCause.values()) {
			RegionRec r = rec();
			RegionsImpl.stopOf(r, true, "the removal of group g was not started: x", c);
			RegionRec b = back(r);
			assertEquals(RemovalStop.NOT_STARTED, b.removalStop);
			assertEquals(c, b.removalStopCause, c.name());
			assertEquals("the removal of group g was not started: x", b.removalStopReason, "the text unchanged");
		}
	}

	@Test
	void legacyAndNone() {
		RegionRec r = rec();
		RegionsImpl.stopOf(r, false, "why", null);
		assertEquals(RemovalStopCause.OTHER, r.removalStopCause, "an untyped stop is OTHER");
		JsonObject old = r.toJson();
		old.remove("removalStopCause");
		assertEquals(RemovalStopCause.OTHER, RegionRec.fromJson(old).removalStopCause, "a record saved before the cause");
		assertNull(back(rec()).removalStopCause, "no stop, no cause");
	}
}
