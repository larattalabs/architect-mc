package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import java.util.List;
import org.junit.jupiter.api.Test;

/** A design request's wire form: review 1's fields only for a protocol-2 sidecar; bible and group never. */
class DesignWireTest {
	private static DesignRequest req() {
		JsonObject ext = new JsonObject();
		ext.addProperty("apitest:k", "v");
		return new DesignRequest("cabin", "rustic", null, List.of("porch"), new BlockSize(15, 12, 15), "Api Cabin", null, null, "apitest:owner",
			ext, "claude-haiku-5", 0.5, "bible1", "group1");
	}

	@Test
	void protocol1DropsTheNewFields() {
		JsonObject w = DesignsImpl.wire(req(), 1);
		assertEquals("cabin", w.get("type").getAsString());
		assertEquals(15, w.getAsJsonObject("maxSize").get("x").getAsInt());
		for (String k : List.of("owner", "ext", "model", "budgetUsd", "bible", "group")) {
			assertFalse(w.has(k), k);
		}
	}

	@Test
	void protocol2SendsThem() {
		JsonObject w = DesignsImpl.wire(req(), 2);
		assertEquals("apitest:owner", w.get("owner").getAsString());
		assertEquals("v", w.getAsJsonObject("ext").get("apitest:k").getAsString());
		assertEquals("claude-haiku-5", w.get("model").getAsString());
		assertTrue(w.has("budgetUsd"));
		assertFalse(w.has("bible"));
		assertFalse(w.has("group"));
	}
}
