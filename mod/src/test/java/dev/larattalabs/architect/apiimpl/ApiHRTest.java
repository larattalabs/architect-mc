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
 * (7c HR) Hidden rooms on the mod side: the feature name {@code hiddenRooms} comes with the helper's {@code plan.hiddenRooms} (never
 * without it), and the jar's plan.json holds {@code form.hidden_room} supported with its def and limits.
 */
class ApiHRTest {
	@Test
	void hiddenRoomsFollowsTheHelper() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "plan.hiddenRooms")).contains("hiddenRooms"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan", "plan.bigForms")).contains("hiddenRooms"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("hiddenRooms"));
	}

	@Test
	void theHiddenRoomIsSupported() throws Exception {
		JsonObject plan;
		try (var in = ApiHRTest.class.getResourceAsStream("/architect_mc/schemas/plan.json")) {
			plan = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		}
		JsonArray entries = plan.getAsJsonObject("x-catalogue").getAsJsonArray("entries");
		JsonObject e = null;
		for (var x : entries) {
			if (x.getAsJsonObject().get("id").getAsString().equals("form.hidden_room")) {
				e = x.getAsJsonObject();
			}
		}
		assertTrue(e != null);
		assertEquals("supported", e.get("state").getAsString());
		assertEquals("#/$defs/form.hidden_room", e.get("def").getAsString());
		assertFalse(e.has("until"));
		assertEquals(JsonParser.parseString("[3, 15]"), e.getAsJsonObject("limits").get("size"));
		JsonObject def = plan.getAsJsonObject("$defs").getAsJsonObject("form.hidden_room");
		assertFalse(def.has("x-state"));
		assertFalse(def.get("additionalProperties").getAsBoolean());
	}
}
