package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ConnectorRequest;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.Sites;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/**
 * (7c CX) {@code Sites.placeConnector} on the mod side: the feature follows the helper's plan check; the one-part plan, its claim and anchors
 * equal the kit fixture the kit test plans (kit/test/fixtures/plan/cx/cx01_ravine.json); the kinds (the contract's {@code spiral} is plan/0's
 * {@code stairs_around}); the caller's params copied, {@code architect_mc:*} keys left out; bad requests refused before anything is asked.
 */
class ApiCXTest {
	private static JsonObject fixture() throws Exception {
		return JsonParser.parseString(Files.readString(Path.of("..", "kit", "test", "fixtures", "plan", "cx", "cx01_ravine.json"))).getAsJsonObject();
	}

	private static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	private static ConnectorRequest req(String kind, BlockPos a, BlockPos b, JsonObject params) {
		return new ConnectorRequest(kind, a, b, null, params, Mode.AUTO, "cx.test");
	}

	@Test
	void placeConnectorFollowsTheHelpersPlanCheck() {
		assertTrue(ApiRules.features(2, List.of("job.run", "region.plan", "region.planCheck")).contains("placeConnector"));
		assertFalse(ApiRules.features(2, List.of("job.run", "region.plan")).contains("placeConnector"));
		assertFalse(ApiRules.features(1, List.of()).contains("placeConnector"));
		assertFalse(ApiRules.JAVA_FEATURES.contains("placeConnector"));
	}

	@Test
	void theImplementationOverridesTheStub() throws Exception {
		assertEquals(SitesImpl.class, SitesImpl.class.getMethod("placeConnector", ConnectorRequest.class).getDeclaringClass());
		assertTrue(Sites.class.getMethod("placeConnector", ConnectorRequest.class).isDefault(), "the API default stays (it throws on an older Architect)");
	}

	@Test
	void thePlanIsTheKitFixtures() throws Exception {
		JsonObject fx = fixture();
		JsonObject an = fx.getAsJsonObject("anchors");
		BlockPos a = pos(an.getAsJsonArray("cx_from")), b = pos(an.getAsJsonArray("cx_to"));
		JsonObject params = new JsonObject();
		params.addProperty(ConnectorPlace.PARAM_OWNER, "test:cx");
		params.addProperty(ConnectorPlace.PARAM_DIMENSION, "minecraft:overworld");
		ConnectorPlace.Plan p = ConnectorPlace.planOf(req("rope_bridge", a, b, params), -64, 319);
		assertEquals(fx.getAsJsonObject("plan"), p.plan(), "Java's plan is the fixture's (no architect_mc:* key reaches it)");
		JsonArray c = fx.getAsJsonArray("claim");
		assertEquals(List.of(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt(), c.get(3).getAsInt()), List.of(p.claim().minX(), p.claim().minZ(),
			p.claim().maxX(), p.claim().maxZ()));
		assertEquals(List.of(-64, 319), List.of(p.claim().minY(), p.claim().maxY()));
		assertEquals(List.of(ConnectorPlace.FROM, ConnectorPlace.TO), List.copyOf(p.anchors().keySet()));
		assertEquals(a, p.anchors().get(ConnectorPlace.FROM));
		assertEquals(b, p.anchors().get(ConnectorPlace.TO));
	}

	@Test
	void kindsAndParams() {
		BlockPos a = new BlockPos(0, 70, 0), b = new BlockPos(0, 60, 9);
		assertEquals(List.of("rope_bridge", "ladder", "catwalk", "rock_stair", "spiral", "stairs_around"), List.copyOf(ConnectorPlace.KINDS.keySet()));
		JsonObject params = new JsonObject();
		params.addProperty("width", 1);
		params.addProperty("architect_mc:anything", true);
		JsonObject part = ConnectorPlace.planOf(req("SPIRAL", a, b, params), -64, 319).plan().getAsJsonArray("connectors").get(0).getAsJsonObject();
		assertEquals("stairs_around", part.get("kind").getAsString());
		assertEquals(1, part.get("width").getAsInt());
		assertFalse(part.has("architect_mc:anything"));
		for (String k : List.of("rope_bridge", "ladder", "catwalk", "rock_stair")) {
			assertEquals(k, ConnectorPlace.planOf(req(k, a, b, new JsonObject()), -64, 319).plan().getAsJsonArray("connectors").get(0).getAsJsonObject().get("kind")
				.getAsString());
		}
	}

	@Test
	void badRequestsAreRefusedBeforeAnythingIsAsked() {
		BlockPos a = new BlockPos(0, 70, 0);
		assertThrows(ConnectorPlace.Bad.class, () -> ConnectorPlace.planOf(req("zipline", a, a.east(9), new JsonObject()), -64, 319));
		assertThrows(ConnectorPlace.Bad.class, () -> ConnectorPlace.planOf(req("rope_bridge", a, a, new JsonObject()), -64, 319));
		assertThrows(ConnectorPlace.Bad.class, () -> ConnectorPlace.planOf(req("rope_bridge", a, a.east(ConnectorPlace.MAX_REACH + 1), new JsonObject()), -64, 319));
		ConnectorPlace.planOf(req("rope_bridge", a, a.east(ConnectorPlace.MAX_REACH), new JsonObject()), -64, 319); // at the limit: fine
		for (String own : List.of("id", "kind", "from", "to", "required")) {
			JsonObject p = new JsonObject();
			p.addProperty(own, "x");
			assertThrows(ConnectorPlace.Bad.class, () -> ConnectorPlace.planOf(req("rope_bridge", a, a.east(20), p), -64, 319), own);
		}
	}
}
