package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.RemovalStop;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/** (slice DR-S) RegionView.removalStop: NOT_STARTED apart from PARTIAL, saved with the region record; the older constructor says NONE. */
class RemovalStopDRSTest {
	@Test
	void stopIsRecordedSavedAndDefaultsToNone() {
		RegionRec r = new RegionRec("rg1", "p1", "sha", "o", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 80, 15}, 1L);
		assertEquals(RemovalStop.NONE, r.removalStop);
		assertEquals(RemovalStop.NONE, RegionRec.fromJson(r.toJson()).removalStop, "NONE is not written (additive)");
		RegionsImpl.stopOf(r, true, "the removal of group g1 was not started: Stockpiles: the ledger was not saved: chunk writes not durable [x]");
		RegionRec back = RegionRec.fromJson(r.toJson());
		assertEquals(RemovalStop.NOT_STARTED, back.removalStop);
		assertEquals(r.removalStopReason, back.removalStopReason);
		RegionsImpl.stopOf(r, false, "");
		RegionRec p = RegionRec.fromJson(r.toJson());
		assertEquals(RemovalStop.PARTIAL, p.removalStop, "stopped after it began taking the region down");
		assertNull(p.removalStopReason, "a blank reason is none");
		RegionView v = new RegionView("rg1", "p1", "sha", "o", new JsonObject(), "g1", new BoundingBox(0, 60, 0, 15, 80, 15), RegionState.PLACED, List.of(),
			List.of(), 0L, Map.of(), null, null, List.of(), 0L, null, List.of(), null, null, 0, null, List.of());
		assertEquals(RemovalStop.NONE, v.removalStop(), "the 1.43.0 constructor: NONE, no reason");
		assertNull(v.removalStopReason());
	}
}
