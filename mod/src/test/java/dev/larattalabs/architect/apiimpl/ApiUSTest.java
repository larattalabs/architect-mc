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
import org.junit.jupiter.api.Test;

/**
 * (7c US) Inverted builds on the mod side: the feature name {@code suspendedBuilds} comes with the helper's {@code plan.suspendedBuilds}
 * (never without it), and the jar's plan.json holds {@code rule.suspended} supported with its def and limits.
 */
class ApiUSTest {
	@Test
	void suspendedBuildsFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "plan.suspendedBuilds")).contains("suspendedBuilds"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "plan.hiddenRooms")).contains("suspendedBuilds"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("suspendedBuilds"));
	}

	@Test
	void theSuspendedRuleIsSupported() throws Exception {
		JsonObject plan;
		try (var in = ApiUSTest.class.getResourceAsStream("/architect_mc/schemas/plan.json")) {
			plan = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		}
		JsonArray entries = plan.getAsJsonObject("x-catalogue").getAsJsonArray("entries");
		JsonObject e = null;
		for (var x : entries) {
			if (x.getAsJsonObject().get("id").getAsString().equals("rule.suspended")) {
				e = x.getAsJsonObject();
			}
		}
		assertTrue(e != null);
		assertEquals("supported", e.get("state").getAsString());
		assertEquals(1, e.get("schemaVersion").getAsInt());
		assertEquals("#/$defs/rule.suspended", e.get("def").getAsString());
		assertFalse(e.has("until"));
		assertFalse(e.has("draft"));
		assertEquals(JsonParser.parseString("[\"overhang\"]"), e.getAsJsonObject("limits").get("affordances"));
		JsonObject def = plan.getAsJsonObject("$defs").getAsJsonObject("rule.suspended");
		assertFalse(def.has("x-state"));
		assertFalse(def.get("additionalProperties").getAsBoolean());
	}
}
