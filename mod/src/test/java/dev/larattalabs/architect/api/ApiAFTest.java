package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.apiimpl.SiteAnalysis;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * Since NEXT (slice AF; docs/CONTRACT.md "Phase 7b" §2 and §3 row 4): the feature siteSurvey (the helper's site.analyse), the
 * site.analyse message, and the mod reading the kit's affordances (kit/test/fixtures/af/*.json, the kit CLI's goldens) into
 * {@link Affordance} and {@link SiteSample}.
 */
class ApiAFTest {
	private static final Path GOLDEN = Path.of("../kit/test/fixtures/af");

	@Test
	void siteSurveyFeature() {
		assertTrue(ApiRules.features(2, List.of("site.analyse")).contains("siteSurvey"));
		assertFalse(ApiRules.features(1, List.of("site.analyse")).contains("siteSurvey"), "protocol 1 has no helper features");
		assertFalse(ApiRules.features(2, List.of("region.plan")).contains("siteSurvey"), "a helper without the analysis");
	}

	private static Volume volume(String sha) {
		return new Volume(sha, new BoundingBox(0, 0, 0, 1, 1, 1), "b123", Map.of(), 0, new Volume.Stats(0, 0, 0, 0, 0, 0));
	}

	private static JsonObject golden(String id) throws Exception {
		return JsonParser.parseString(Files.readString(GOLDEN.resolve(id + ".json")).trim()).getAsJsonObject();
	}

	@Test
	void theKitsAffordancesRead() throws Exception {
		for (String id : List.of("cliff_face", "overhang", "rift_site", "trunk")) {
			JsonObject g = golden(id);
			JsonArray wire = g.getAsJsonArray("affordances");
			List<Affordance> list = SiteAnalysis.affordances(wire);
			assertEquals(wire.size(), list.size(), id);
			for (int i = 0; i < list.size(); i++) {
				JsonObject w = wire.get(i).getAsJsonObject();
				Affordance a = list.get(i);
				assertEquals(w.get("id").getAsString(), a.id());
				assertEquals(w.get("kind").getAsString(), a.kind().wire());
				assertEquals(SiteSpec.boxOf(w.getAsJsonObject("box")), a.box());
				assertEquals(w.getAsJsonArray("anchors").size(), a.anchors().size());
				assertEquals(w.get("normal").isJsonNull() ? null : w.get("normal").getAsString(), a.normal() == null ? null : a.normal().getName());
				assertEquals(w.getAsJsonObject("metrics"), a.metrics());
				assertEquals(w.get("score").getAsDouble(), a.score());
			}
			// the whole answer as Survey.site reads it: the volume's sha checked, the proposed frame
			JsonObject ack = new JsonObject();
			ack.addProperty("ok", true);
			ack.add("result", g);
			SiteSample s = SiteAnalysis.sample(volume(g.get("sha").getAsString()), ack);
			assertEquals(list, s.affordances());
			JsonObject site = JsonParser.parseString(Files.readString(Path.of("../kit/test/fixtures/site", id, "site.json"))).getAsJsonObject();
			assertEquals(SiteFrame.fromWire(site.getAsJsonObject("spec").getAsJsonObject("frame")), s.proposed().orElseThrow(), id + ": the fixture's frame");
		}
		Affordance oh = SiteAnalysis.affordances(golden("overhang").getAsJsonArray("affordances")).stream().filter(a -> a.kind() == Affordance.Kind.OVERHANG)
			.findFirst().orElseThrow();
		assertEquals(Direction.SOUTH, oh.normal());
		assertTrue(oh.anchors().stream().allMatch(p -> p.getY() == 134), "the hang points under the ceiling");
		Affordance gap = SiteAnalysis.affordances(golden("rift_site").getAsJsonArray("affordances")).stream().filter(a -> a.kind() == Affordance.Kind.GAP)
			.findFirst().orElseThrow();
		assertNull(gap.normal());
		assertEquals(9, gap.metrics().get("span").getAsInt());
	}

	@Test
	void refusalsAndOtherVolumes() throws Exception {
		JsonObject g = golden("cliff_face");
		JsonObject ack = new JsonObject();
		ack.addProperty("ok", true);
		ack.add("result", g);
		assertThrows(RegionRefused.class, () -> SiteAnalysis.sample(volume("0".repeat(64)), ack), "an answer about another volume");
		JsonObject no = new JsonObject();
		no.addProperty("ok", false);
		no.addProperty("error", "the kit has no tools/affordances.mjs");
		RegionRefused r = assertThrows(RegionRefused.class, () -> SiteAnalysis.sample(volume(g.get("sha").getAsString()), no));
		assertEquals(Reason.OTHER, r.reason());
		// no proposal: an empty Optional; no affordances: an empty list
		JsonObject bare = new JsonObject();
		bare.addProperty("sha", g.get("sha").getAsString());
		bare.add("proposed", com.google.gson.JsonNull.INSTANCE);
		SiteSample s = SiteAnalysis.sample(volume(g.get("sha").getAsString()), bare);
		assertTrue(s.affordances().isEmpty());
		assertTrue(s.proposed().isEmpty());
		assertTrue(SiteAnalysis.affordances(null).isEmpty());
		JsonObject bad = g.getAsJsonArray("affordances").get(0).getAsJsonObject().deepCopy();
		bad.addProperty("kind", "volcano");
		JsonArray ba = new JsonArray();
		ba.add(bad);
		assertThrows(IllegalArgumentException.class, () -> SiteAnalysis.affordances(ba));
	}

	@Test
	void theMessage() {
		JsonObject m = SiteAnalysis.message(volume("ab".repeat(32)), new BoundingBox(1, 2, 3, 4, 5, 6), FitMode.ATTACH_TO_CLIFF);
		assertEquals("site.analyse", m.get("type").getAsString());
		assertEquals("b123", m.get("volumeBlobId").getAsString());
		assertEquals("ab".repeat(32), m.get("sha").getAsString());
		assertEquals("attach_to_cliff", m.get("fit").getAsString());
		assertEquals(new BoundingBox(1, 2, 3, 4, 5, 6), SiteSpec.boxOf(m.getAsJsonObject("lot")));
		assertEquals(8, SiteAnalysis.MARGIN);
	}
}
