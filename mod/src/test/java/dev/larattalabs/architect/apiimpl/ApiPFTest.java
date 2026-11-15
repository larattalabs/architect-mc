package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.region.PlanCatalogue;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (7c PF) Promoted forms on the mod side: the feature name {@code shapePromotion} comes with the helper's {@code plan.shapePromotion}
 * (never without it), the jar's plan.json holds {@code form.arch_span} supported with its def and limits, and the catalogue serves it on
 * demand.
 */
class ApiPFTest {
	@Test
	void shapePromotionFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "plan.shapePromotion")).contains("shapePromotion"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "plan.aqueduct")).contains("shapePromotion"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("shapePromotion"));
	}

	@Test
	void theArchSpanIsSupported() throws Exception {
		JsonObject plan;
		try (var in = ApiPFTest.class.getResourceAsStream("/architect_mc/schemas/plan.json")) {
			assertNotNull(in, "the bundled plan.json");
			plan = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		}
		JsonArray entries = plan.getAsJsonObject("x-catalogue").getAsJsonArray("entries");
		JsonObject e = null;
		for (var x : entries) {
			if (x.getAsJsonObject().get("id").getAsString().equals("form.arch_span")) {
				e = x.getAsJsonObject();
			}
		}
		assertNotNull(e);
		assertEquals("supported", e.get("state").getAsString());
		assertEquals(1, e.get("schemaVersion").getAsInt());
		assertEquals("#/$defs/form.arch_span", e.get("def").getAsString());
		assertFalse(e.has("until"));
		assertEquals(JsonParser.parseString("[12, 128]"), e.getAsJsonObject("limits").get("length"));
		assertEquals(32, e.getAsJsonObject("limits").get("drop").getAsInt());
		JsonObject def = plan.getAsJsonObject("$defs").getAsJsonObject("form.arch_span");
		assertFalse(def.has("x-state"));
		assertFalse(def.get("additionalProperties").getAsBoolean());
		assertEquals("arch_span", def.getAsJsonObject("properties").getAsJsonObject("kind").get("const").getAsString());
		JsonObject k = PlanCatalogue.kinds(Set.of("form.arch_span"));
		assertEquals(1, k.getAsJsonArray("entries").size());
		assertTrue(k.getAsJsonArray("entries").get(0).getAsJsonObject().getAsJsonObject("def").has("properties"), "served on demand with its def");
	}
}
