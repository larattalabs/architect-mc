package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ComposeRequest;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Optional;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7c CO) The standalone composer on the mod side: {@code compose} comes with the helper's {@code region.compose}; the
 * {@code region.compose} message; a settlement design reads as {@link Design.Kind#SETTLEMENT}; a round's check request (no caller
 * anchors, the record's Style and owner) and the check as it goes back (no catalogue, no light preview); the planning images asked for
 * and copied into the check's preview.
 */
class ApiCOTest {
	@Test
	void composeFollowsTheHelper() {
		assertEquals("region.compose", Composes.FEATURE);
		assertTrue(ApiRules.features(2, List.of("job.run", "region.design", Composes.FEATURE)).contains("compose"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.design", "region.templates")).contains("compose"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("compose"));
	}

	@Test
	void theComposeMessage() {
		JsonObject ext = new JsonObject();
		ext.addProperty("test:x", 1);
		ComposeRequest r = new ComposeRequest("a few homes", new BoundingBox(0, 0, 10, 159, 0, 169), "gothic", true, 0.5, "k.1", ext);
		JsonObject m = Composes.message(r, "k.1", -64, 319, "b1", "flat", null);
		assertEquals(JsonParser.parseString("{\"type\":\"region.compose\",\"brief\":\"a few homes\",\"claim\":{\"minX\":0,\"minZ\":10,\"maxX\":159,\"maxZ\":169,"
			+ "\"minY\":-64,\"maxY\":319},\"surveyBlobId\":\"b1\",\"style\":\"gothic\",\"images\":true,\"budgetUsd\":0.5,\"opKey\":\"k.1\",\"ext\":{\"test:x\":1}}"), m);
		JsonObject bare = Composes.message(new ComposeRequest("b", new BoundingBox(0, 0, 0, 9, 0, 9), null, false, null, "k", null), null, -64, 319, "b2", "", null);
		assertFalse(bare.has("style") || bare.has("budgetUsd") || bare.has("opKey") || bare.has("ext"));
		assertEquals(false, bare.get("images").getAsBoolean());
	}

	@Test
	void aSettlementDesignIsKindSettlement() {
		JsonObject req = new JsonObject();
		req.addProperty("kind", "settlement");
		Design d = new Design("d1", Design.Status.DONE, "", Optional.empty(), Cost.NONE, Optional.empty(), req, Optional.empty(), 0, 0);
		assertEquals(Design.Kind.SETTLEMENT, d.kind());
		assertEquals(Design.Kind.values().length - 1, Design.Kind.SETTLEMENT.ordinal(), "appended last");
		req.addProperty("kind", "region");
		assertEquals(Design.Kind.REGION, new Design("d2", Design.Status.DONE, "", Optional.empty(), Cost.NONE, Optional.empty(), req, Optional.empty(), 0, 0).kind());
	}

	@Test
	void aRoundIsCheckedWithNoAnchorsTheStyleAndTheOwner() {
		JsonObject st = JsonParser.parseString("{\"claim\":{\"minX\":0,\"minZ\":0,\"maxX\":9,\"maxZ\":9},\"style\":{\"id\":\"gothic\",\"version\":3},\"owner\":\"o\"}").getAsJsonObject();
		JsonObject plan = JsonParser.parseString("{\"schemaVersion\":\"plan/0\"}").getAsJsonObject();
		PlanRequest pr = Composes.checkRequest(plan, null, new BoundingBox(0, -64, 0, 9, 319, 9), st);
		assertTrue(pr.anchors().isEmpty());
		assertEquals("gothic", pr.bible());
		assertEquals(3, pr.bibleVersion());
		assertEquals("o", pr.owner());
		assertNull(pr.opKey());
		assertNull(pr.budget());
		assertEquals(plan, pr.plan());
		assertFalse(PlanChecks.planImagesAsked(pr));
		PlanRequest bare = Composes.checkRequest(plan, null, new BoundingBox(0, -64, 0, 9, 319, 9), JsonParser.parseString("{}").getAsJsonObject());
		assertNull(bare.bible());
		assertNull(bare.owner());
	}

	@Test
	void theCheckGoesBackWithoutItsCatalogueOrPreview() {
		JsonObject part = JsonParser.parseString("{\"part\":\"lane\",\"class\":\"malformed\",\"block\":\"connector.path\"}").getAsJsonObject();
		JsonObject preview = JsonParser.parseString("{\"siteplan\":{},\"malformed\":{\"code\":\"SCHEMA\"}}").getAsJsonObject();
		JsonObject cat = JsonParser.parseString("{\"entries\":[]}").getAsJsonObject();
		PlanCheck pc = new PlanCheck("c1", "ps", "ss", "k", "plan/0", PlanCheck.Overall.NEEDS_REPAIR, List.of(part), new JsonObject(), cat, preview, "a".repeat(64), List.of("n"));
		JsonObject w = Composes.checkWire(pc);
		assertFalse(w.has("catalogue"));
		assertFalse(w.has("preview"));
		assertEquals("NEEDS_REPAIR", w.get("overall").getAsString());
		assertEquals("a".repeat(64), w.get("artifactSha").getAsString());
		assertEquals("SCHEMA", w.getAsJsonObject("malformed").get("code").getAsString());
		assertEquals(1, w.getAsJsonArray("parts").size());
	}

	@Test
	void thePlanningImagesAreAskedAndCopiedIntoThePreview() {
		JsonObject ext = new JsonObject();
		ext.addProperty(PlanRequest.EXT_PLAN_IMAGES, true);
		PlanRequest r = new PlanRequest(new JsonObject(), null, new BoundingBox(0, 0, 0, 9, 0, 9), null, null, null, null, null, null, ext);
		assertTrue(PlanChecks.planImagesAsked(r));
		JsonObject no = new JsonObject();
		no.addProperty(PlanRequest.EXT_PLAN_IMAGES, "yes");
		assertFalse(PlanChecks.planImagesAsked(new PlanRequest(new JsonObject(), null, new BoundingBox(0, 0, 0, 9, 0, 9), null, null, null, null, null, null, no)));
		JsonObject planned = JsonParser.parseString("{\"planCheck\":{\"overall\":\"READY\",\"parts\":[],\"planImages\":{\"images\":[{\"name\":\"top\",\"blobId\":\"b\"}],"
			+ "\"labels\":[]}}}").getAsJsonObject();
		PlanCheck pc = PlanChecks.fromPlanned("p1", planned);
		JsonArray ims = pc.preview().getAsJsonObject("planImages").getAsJsonArray("images");
		assertEquals("top", ims.get(0).getAsJsonObject().get("name").getAsString());
		PlanCheck without = PlanChecks.fromPlanned("p2", JsonParser.parseString("{\"planCheck\":{\"overall\":\"READY\",\"parts\":[]}}").getAsJsonObject());
		assertFalse(without.preview().has("planImages"));
	}
}
