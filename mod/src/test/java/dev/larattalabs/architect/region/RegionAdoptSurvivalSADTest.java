package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

/**
 * (SAD §2-§3) Survival adoption's rules: a construction site adopts in a survival world only, never while a crate feeds it, and a building
 * one needs its owner's stockpile; a joined shared-crate group adopts; the region record is survival exactly when the world is, and its
 * survival member survives region.json's round trip.
 */
class RegionAdoptSurvivalSADTest {
	private static final String OW = "minecraft:overworld";

	@Test
	void aConstructionSiteAdoptsInASurvivalWorldOnly() {
		String why = RegionAdopt.constructionRefusal("s1", "steward", OW, false, false, false, true, null);
		assertNotNull(why);
		assertTrue(why.contains("not in survival"), why);
		assertNull(RegionAdopt.constructionRefusal("s1", "steward", OW, true, false, false, true, null));
	}

	@Test
	void aLiveCrateRefusesNamingAdoptCrates() {
		String why = RegionAdopt.constructionRefusal("s2", "steward", OW, true, true, true, true, null);
		assertNotNull(why);
		assertTrue(why.contains("adoptCrates"), why);
	}

	@Test
	void aBuildingSiteNeedsAStockpileABuiltOneDoesNot() {
		String why = RegionAdopt.constructionRefusal("s3", "steward", OW, true, false, true, false, null);
		assertNotNull(why);
		assertTrue(why.contains("no stockpile in " + OW), why);
		String dim = RegionAdopt.constructionRefusal("s3", "steward", OW, true, false, true, false, "steward's stockpile is in minecraft:the_nether");
		assertTrue(dim.contains("the_nether"), dim);
		assertNull(RegionAdopt.constructionRefusal("s3", "steward", OW, true, false, true, true, null));
		assertNull(RegionAdopt.constructionRefusal("s3", "steward", OW, true, false, false, false, null), "BUILT: nothing left to draw");
	}

	@Test
	void aJoinedSharedCrateGroupAdopts() {
		String why = RegionAdopt.groupCrateRefusal("s4", "g7", true);
		assertNotNull(why);
		assertTrue(why.contains("adoptCrates"), why);
		assertNull(RegionAdopt.groupCrateRefusal("s4", "g7", false));
	}

	@Test
	void theRegionIsSurvivalExactlyWhenTheWorldIs() {
		assertNull(RegionAdopt.survivalRecord(false));
		JsonObject sv = RegionAdopt.survivalRecord(true);
		assertNotNull(sv);
		assertTrue(sv.get("on").getAsBoolean());
		assertTrue(sv.get("adopted").getAsBoolean());
		RegionRec rec = new RegionRec("rg9", "p1", "sha", "steward", new JsonObject(), OW, new int[] {0, 60, 0, 31, 90, 31}, 1L);
		rec.survival = sv;
		RegionRec back = RegionRec.fromJson(rec.toJson());
		assertTrue(back.survival());
		assertEquals(sv, back.survival);
	}
}
