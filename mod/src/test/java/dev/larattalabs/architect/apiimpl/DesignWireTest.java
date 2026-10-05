package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * A design request's wire form: review 1's fields and 4b's (bible, bibleVersion, profile) only for a protocol-2 sidecar;
 * {@code group} never (the 4b sidecar refuses a design.request that carries it).
 */
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
		assertEquals("bible1", w.get("bible").getAsString());
		assertFalse(w.has("group"), "group is never sent");
		assertFalse(w.has("profile"), "a preset type sends no profile");
	}

	@Test
	void openTypeProfileAndBibleVersion() {
		DesignRequest r = new DesignRequest("hellish_lair", "spiky", null, List.of(), new BlockSize(21, 20, 21), null, null, null, null, null, null,
			null, null, null).withProfile(List.of("door", "lit", "no_floating")).withBible("bib_ashfall", 2);
		JsonObject w = DesignsImpl.wire(r, 2);
		assertEquals("hellish_lair", w.get("type").getAsString());
		assertEquals(3, w.getAsJsonArray("profile").size());
		assertEquals("bib_ashfall", w.get("bible").getAsString());
		assertEquals(2, w.get("bibleVersion").getAsInt());
		JsonObject w1 = DesignsImpl.wire(r, 1);
		assertFalse(w1.has("profile") || w1.has("bible") || w1.has("bibleVersion"));
		// the 1.1.0 constructor still works: no profile, no version
		assertTrue(req().profile().isEmpty());
		assertEquals(null, req().bibleVersion());
	}
}
