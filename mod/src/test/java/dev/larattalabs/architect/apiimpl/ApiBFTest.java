package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * (7c BF) The big forms on the mod side: the feature name {@code bigForms} comes with the helper's {@code plan.bigForms} (never without
 * it), and the jar's plan.json holds the three catalogue entries supported with their defs and limits.
 */
class ApiBFTest {
	@Test
	void bigFormsFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "plan.bigForms")).contains("bigForms"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "region.link", "design.program")).contains("bigForms"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("bigForms"));
	}

	@Test
	void theThreeFormsAreSupported() throws Exception {
		JsonObject plan;
		try (var in = ApiBFTest.class.getClassLoader().getResourceAsStream("plan.json")) {
			plan = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		}
		JsonArray entries = plan.getAsJsonObject("x-catalogue").getAsJsonArray("entries");
		for (String id : Set.of("form.hollow_mountain", "form.crater", "form.floating_island")) {
			JsonObject e = null;
			for (var x : entries) {
				if (x.getAsJsonObject().get("id").getAsString().equals(id)) {
					e = x.getAsJsonObject();
				}
			}
			assertTrue(e != null, id);
			assertEquals("supported", e.get("state").getAsString(), id);
			assertEquals("#/$defs/" + id, e.get("def").getAsString(), id);
			assertFalse(e.has("until"), id);
			assertTrue(e.getAsJsonObject("limits").has("size"), id);
		}
	}
}
