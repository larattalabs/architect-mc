package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7c HR, S-7c-4) A check's secrets: the artifact's {@code $.secrets[]} reach the preview and its siteplan only when the request asks
 * ({@code ext[PlanRequest.EXT_SECRETS]: true}), and the ask is in the key's body only when made (every other key keeps its hash).
 */
class PlanChecksSecretsTest {
	private static PlanRequest req(JsonObject ext) {
		return new PlanRequest(JsonParser.parseString("{\"schemaVersion\":\"plan/0\"}").getAsJsonObject(), null, new BoundingBox(0, -64, 0, 63, 319, 63), Map.of(), null,
			null, null, null, "k", ext);
	}

	private static JsonObject planned(String artifact) {
		JsonObject k = new JsonObject();
		k.addProperty("overall", "READY");
		k.add("parts", new JsonArray());
		JsonObject pv = new JsonObject();
		pv.add("bounds", new JsonObject());
		k.add("preview", pv);
		if (artifact != null) {
			k.addProperty("artifact", artifact);
		}
		JsonObject o = new JsonObject();
		o.add("planCheck", k);
		JsonObject sp = new JsonObject();
		sp.add("parts", new JsonArray());
		o.add("sitePlan", sp);
		return o;
	}

	@Test
	void secretsOnlyWhenAsked() {
		JsonObject ask = new JsonObject();
		ask.addProperty(PlanRequest.EXT_SECRETS, true);
		assertTrue(PlanChecks.secretsAsked(req(ask)));
		assertFalse(PlanChecks.secretsAsked(req(new JsonObject())));
		JsonObject no = new JsonObject();
		no.addProperty(PlanRequest.EXT_SECRETS, "yes");
		assertFalse(PlanChecks.secretsAsked(req(no)), "only a boolean true asks");
		String art = "{\"secrets\":[{\"part\":\"vault\",\"host\":\"hold\",\"entrance\":{\"cell\":[1,2,3],\"kind\":\"wall\"},\"room\":[0,0,0,1,1,1]}]}";
		JsonObject pl = planned(art);
		PlanCheck plain = PlanChecks.fromPlanned("p", pl);
		assertFalse(plain.preview().has("secrets"));
		assertFalse(plain.preview().getAsJsonObject("siteplan").has("secrets"));
		PlanCheck asked = PlanChecks.fromPlanned("p", pl);
		PlanChecks.addSecrets(asked, pl);
		assertEquals(1, asked.preview().getAsJsonArray("secrets").size());
		assertEquals("wall", asked.preview().getAsJsonArray("secrets").get(0).getAsJsonObject().getAsJsonObject("entrance").get("kind").getAsString());
		assertEquals(asked.preview().get("secrets"), asked.preview().getAsJsonObject("siteplan").get("secrets"));
		// no hidden room: nothing added
		JsonObject none = planned("{\"overall\":\"READY\"}");
		PlanCheck n = PlanChecks.fromPlanned("p", none);
		PlanChecks.addSecrets(n, none);
		assertFalse(n.preview().has("secrets"));
	}

	@Test
	void theAskIsInTheKeyOnlyWhenMade() {
		JsonObject ask = new JsonObject();
		ask.addProperty(PlanRequest.EXT_SECRETS, true);
		dev.larattalabs.architect.api.PlanBudget b = dev.larattalabs.architect.api.PlanBudget.defaults();
		JsonObject plain = PlanChecks.body(req(new JsonObject()), b);
		JsonObject asked = PlanChecks.body(req(ask), b);
		assertFalse(plain.has("secrets"));
		assertTrue(asked.get("secrets").getAsBoolean());
		assertEquals(List.of("plan", "claim", "anchors", "budget"), List.copyOf(plain.keySet()));
	}
}
