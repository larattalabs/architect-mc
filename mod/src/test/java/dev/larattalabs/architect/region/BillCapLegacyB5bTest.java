package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.BillCaps;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (fix b5b, the GPT review's P2 "legacy caps follow the mutable head") A 0.72.0 region-wide maxBill set by a revision is that revision's cap:
 * read once, when the record loads, by the head it was saved with. An undo (or a later revision) that moves the head never moves the cap.
 */
class BillCapLegacyB5bTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static RegionRec saved072(int head) {
		RegionRec rec = new RegionRec("rg7", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 31, 90, 31}, 1L);
		rec.survival = JsonParser.parseString("{\"on\":true,\"maxBill\":{\"minecraft:dirt\":5},\"billBase\":{\"minecraft:dirt\":40}}").getAsJsonObject();
		rec.nextRid = head + 1;
		rec.headRid = head;
		return rec;
	}

	@Test
	void anUndoAfterTheLoadLeavesTheLegacyCapWithItsRevision() {
		RegionRec live = RegionRec.fromJson(saved072(3).toJson()); // the world opened in this version: revision 3 set the cap
		assertNotNull(BillCaps.ofRegionRecord("rg7", "g", 3, live.survival, live.headRid), "revision 3 holds the 0.72.0 cap");
		live.headRid = 2; // an undo of revision 3 (the head back to 2)
		assertNull(BillCaps.ofRegionRecord("rg7", "g", 2, live.survival, live.headRid), "the undo does not hand revision 3's cap to revision 2");
		assertEquals(Map.of("minecraft:dirt", 5), BillCaps.ofRegionRecord("rg7", "g", 3, live.survival, live.headRid).max(), "it stays revision 3's");
		// and it is persisted: the next record save carries it per rid, the region-wide member gone
		RegionRec again = RegionRec.fromJson(live.toJson());
		assertFalse(again.survival.has("maxBill"));
		assertEquals("{\"3\":{\"maxBill\":{\"minecraft:dirt\":5}}}", again.survival.get("caps").toString());
		assertNotNull(BillCaps.ofRegionRecord("rg7", "g", 3, again.survival, again.headRid));
	}

	@Test
	void aFirstRealisesLegacyCapStaysRidZero() {
		RegionRec rec = saved072(4);
		rec.survival = JsonParser.parseString("{\"on\":true,\"maxBill\":{\"minecraft:dirt\":5},\"billBase\":{}}").getAsJsonObject();
		RegionRec live = RegionRec.fromJson(rec.toJson());
		live.headRid = 7;
		assertNotNull(BillCaps.ofRegionRecord("rg7", "g", 0, live.survival, live.headRid));
		assertNull(BillCaps.ofRegionRecord("rg7", "g", 7, live.survival, live.headRid));
	}
}
