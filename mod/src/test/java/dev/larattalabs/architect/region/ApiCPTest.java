package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ComposeRequest;
import dev.larattalabs.architect.api.PlanRequest;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.junit.jupiter.api.Test;

/**
 * (7c CP) Compose follow-ups on the mod side: the skip-pick key; owner and level on {@link ComposeRequest} (the old constructor is the
 * Overworld and owner null), sent only when set, so a request as CO froze it sends the same message as before.
 */
class ApiCPTest {
	private static final BoundingBox CLAIM = new BoundingBox(0, 0, 0, 9, 0, 9);

	@Test
	void theExtKeys() {
		assertEquals("architect_mc:skipPick", ComposeRequest.EXT_SKIP_PICK); // = the sidecar's EXT_* (compose.test.ts)
		assertEquals("architect_mc:composeVocab", ComposeRequest.EXT_VOCAB);
		assertEquals("architect_mc:streetFix", ComposeRequest.EXT_STREET_FIX);
	}

	@Test
	void theOldConstructorIsTheOverworldAndNoOwner() {
		ComposeRequest r = new ComposeRequest("b", CLAIM, null, false, null, "k", null);
		assertNull(r.level());
		assertNull(r.owner());
		assertEquals(new ComposeRequest("b", CLAIM, null, false, null, "k", null, null, null), r);
	}

	@Test
	void ownerAndDimensionAreSentOnlyWhenSet() {
		ComposeRequest old = new ComposeRequest("b", CLAIM, null, false, null, "k", null);
		JsonObject before = Composes.message(old, "k", -64, 319, "b1", "", null);
		assertEquals(before, Composes.message(old, "k", -64, 319, "b1", "", null, null), "a request as CO froze it: the same message");
		assertFalse(before.has("owner") || before.has("dimension"));
		ComposeRequest r = new ComposeRequest("b", CLAIM, null, false, null, "k", null, null, "steward:s1");
		JsonObject m = Composes.message(r, "k", 0, 127, "b1", "", null, "minecraft:the_nether");
		assertEquals("steward:s1", m.get("owner").getAsString());
		assertEquals("minecraft:the_nether", m.get("dimension").getAsString());
		JsonObject want = before.deepCopy();
		want.get("claim").getAsJsonObject().addProperty("minY", 0);
		want.get("claim").getAsJsonObject().addProperty("maxY", 127);
		want.addProperty("owner", "steward:s1");
		want.addProperty("dimension", "minecraft:the_nether");
		assertEquals(want, m, "only the owner, the dimension and the level's height differ");
	}

	@Test
	void aRoundIsCheckedWithTheRecordsOwner() {
		JsonObject st = JsonParser.parseString("{\"claim\":{\"minX\":0,\"minZ\":0,\"maxX\":9,\"maxZ\":9},\"owner\":\"steward:s1\",\"dimension\":\"minecraft:the_nether\"}")
			.getAsJsonObject();
		PlanRequest pr = Composes.checkRequest(JsonParser.parseString("{\"schemaVersion\":\"plan/0\"}").getAsJsonObject(), null, new BoundingBox(0, 0, 0, 9, 127, 9), st);
		assertEquals("steward:s1", pr.owner());
	}
}
