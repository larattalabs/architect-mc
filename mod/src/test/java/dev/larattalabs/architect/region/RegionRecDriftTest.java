package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

/**
 * The per-stage drift outcome survives a save and load of the region record (a relog across a stage gate): a held stage stays
 * held (the view keeps waiting DRIFTED and no check runs again), a continued one stays continued, and the stage timings survive.
 */
class RegionRecDriftTest {
	@Test
	void driftOutcomesAndStageTimesSurviveSaveAndLoad() {
		RegionRec r = new RegionRec("rg3", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {-96, -9, -96, 95, 136, 95}, 1L);
		for (String st : new String[] {"ground", "ways", "lots-1"}) {
			r.stages.put(st, new RegionRec.Stage());
		}
		r.stages.get("ground").startedAt = 1000;
		r.stages.get("ground").lastDoneAt = 5000;
		r.stages.get("ground").activeTicks = 42;
		r.drift.put("ways", "continued: 10 of 3072 sampled columns within 2 (0.3%), 0 over 8 in lots");
		r.drift.put("lots-1", "held: 0 of 291 sampled columns within 2 (0.0%), 291 over 8 in lots");
		// written as region.json is (text), read back as at a server start
		RegionRec back = RegionRec.fromJson(JsonParser.parseString(r.toJson().toString()).getAsJsonObject());
		assertEquals(r.drift, back.drift);
		assertEquals("held: 0 of 291 sampled columns within 2 (0.0%), 291 over 8 in lots", back.drift.get("lots-1"));
		assertEquals(java.util.List.of("ways", "lots-1"), java.util.List.copyOf(back.drift.keySet()));
		assertEquals(1000, back.stages.get("ground").startedAt);
		assertEquals(5000, back.stages.get("ground").lastDoneAt);
		assertEquals(42, back.stages.get("ground").activeTicks);
		assertEquals(0, back.stages.get("ways").startedAt, "a stage that never started stays unstarted (the first-stage rule reads it)");
		// a record written before the per-stage check (no drift, no timings) loads with none
		JsonObject old = r.toJson();
		old.remove("drift");
		old.getAsJsonObject("stages").getAsJsonObject("ground").remove("startedAt");
		RegionRec legacy = RegionRec.fromJson(old);
		assertEquals(0, legacy.drift.size());
		assertEquals(0, legacy.stages.get("ground").startedAt);
	}
}
