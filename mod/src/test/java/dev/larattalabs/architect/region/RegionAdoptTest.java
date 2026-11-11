package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.site.Site;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * (6d AD) The adoption's records: the intent's members round trip (each site's kind, its region key, its membership and stage before), a
 * stage-list entry of a site (its id, its batch delta tokens; never another site's), the region record's {@code adopt} member round trip.
 */
class RegionAdoptTest {
	@Test
	void membersRoundTrip() {
		List<RegionAdopt.Member> ms = List.of(new RegionAdopt.Member("r7", true, "road:street_1", new Site.Member("g3", "b1", "street"), "street"),
			new RegionAdopt.Member("s9", false, "lot:house_1", new Site.Member("g3", "b1", "house_1"), "stage1"), new RegionAdopt.Member("s10", false, "lot:farm_2", null,
				null));
		List<RegionAdopt.Member> back = RegionAdopt.membersOf(RegionAdopt.membersJson(ms));
		assertEquals(ms, back);
	}

	@Test
	void stageEntriesOfASite() {
		assertTrue(RegionAdopt.ofSite("s9", "s9"));
		assertTrue(RegionAdopt.ofSite("delta:s9:e12", "s9"));
		assertFalse(RegionAdopt.ofSite("s91", "s9"));
		assertFalse(RegionAdopt.ofSite("delta:s91:e12", "s9"));
	}

	@Test
	void recordKeepsTheAdoption() {
		RegionRec r = new RegionRec("rg4", "p1", "sha", "steward", new com.google.gson.JsonObject(), "minecraft:overworld", new int[] {0, -64, 0, 9, 319, 9}, 5L);
		assertNull(RegionRec.fromJson(r.toJson()).adopt, "an ordinary region's record has no adopt member");
		com.google.gson.JsonObject ad = new com.google.gson.JsonObject();
		ad.addProperty("phase", RegionAdopt.PHASE_ADOPTING);
		r.adopt = ad;
		RegionRec b = RegionRec.fromJson(r.toJson());
		assertTrue(RegionAdopt.adopting(b));
		b.adopt.addProperty("phase", RegionAdopt.PHASE_PLACED);
		assertFalse(RegionAdopt.adopting(b));
	}
}
