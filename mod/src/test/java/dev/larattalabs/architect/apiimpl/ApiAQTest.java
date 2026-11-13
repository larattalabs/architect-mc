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
 * (7c AQ) Aqueducts on the mod side: the feature name {@code aqueduct} comes with the helper's {@code plan.aqueduct} (never without it),
 * and the jar's plan.json holds {@code channel.aqueduct} supported with its def and limits.
 */
class ApiAQTest {
	@Test
	void aqueductFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "plan.aqueduct")).contains("aqueduct"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "plan.hiddenRooms")).contains("aqueduct"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("aqueduct"));
	}

	@Test
	void theAqueductIsSupported() throws Exception {
		JsonObject plan;
		try (var in = ApiAQTest.class.getResourceAsStream("/architect_mc/schemas/plan.json")) {
			plan = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		}
		JsonArray entries = plan.getAsJsonObject("x-catalogue").getAsJsonArray("entries");
		JsonObject e = null;
		for (var x : entries) {
			if (x.getAsJsonObject().get("id").getAsString().equals("channel.aqueduct")) {
				e = x.getAsJsonObject();
			}
		}
		assertTrue(e != null);
		assertEquals("supported", e.get("state").getAsString());
		assertEquals(1, e.get("schemaVersion").getAsInt());
		assertEquals("#/$defs/channel.aqueduct", e.get("def").getAsString());
		assertFalse(e.has("until"));
		assertFalse(e.has("draft"));
		assertEquals(JsonParser.parseString("[3, 24]"), e.getAsJsonObject("limits").get("rise"));
		assertEquals(JsonParser.parseString("[\"piers\", \"arches\"]"), e.getAsJsonObject("limits").get("spans"));
		JsonObject def = plan.getAsJsonObject("$defs").getAsJsonObject("channel.aqueduct");
		assertFalse(def.has("x-state"));
	}
}
