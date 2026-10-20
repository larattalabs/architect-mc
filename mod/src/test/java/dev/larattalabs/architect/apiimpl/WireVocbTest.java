package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.BibleRequest;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (6c VOC-b) BibleRequest.rarity on the wire (docs/CONTRACT.md "Phase 6c slice VOC" §4.3, S-VOC-1/S-VOC-5): written only when set, so a request
 * without one sends exactly its 1.10.0 bytes (an opKey's body hash doesn't move); with one, the record's toJson() as the request's `rarity`;
 * the feature rarityBudgets (sidecar bible.rarity).
 */
class WireVocbTest {
	@Test
	void withoutRarityTheOldBytes() {
		BibleRequest r = new BibleRequest(" a lair ", "Ashfall", "apitest:o", null, null, 2.0, List.of("gen_x"), "settlement", "oak", true, "k1");
		JsonObject w = Wire4b.bibleRequest(r);
		assertFalse(w.has("rarity"));
		assertEquals(w.toString(), Wire4b.bibleRequest(r.withRarity(null)).toString(), "withRarity(null) is the old request, byte for byte");
		assertEquals("{\"prompt\":\"a lair\",\"name\":\"Ashfall\",\"owner\":\"apitest:o\",\"budgetUsd\":2.0,\"references\":[\"gen_x\"],\"scope\":\"settlement\",\"seedPreset\":\"oak\","
			+ "\"critique\":{\"mode\":\"report\"},\"opKey\":\"k1\"}", w.toString());
	}

	@Test
	void withRarityItsJson() {
		BibleRequest.Rarity ra = new BibleRequest.Rarity(null, 0.06, 1, null, Map.of("concrete", 0.6), List.of("white", "light_gray", "black"), null, null, List.of("minecraft:beacon"));
		JsonObject w = Wire4b.bibleRequest(BibleRequest.of("modern", null).withRarity(ra));
		assertEquals(ra.toJson(), w.getAsJsonObject("rarity"));
		assertEquals(JsonParser.parseString("{\"rareShareMax\":0.06,\"preciousMax\":1,\"families\":{\"concrete\":0.6},\"colours\":[\"white\",\"light_gray\",\"black\"],\"allow\":[\"minecraft:beacon\"]}"),
			w.getAsJsonObject("rarity"));
		// the defaults (no member set): an empty budget, still sent (the bible opts in at the defaults)
		assertEquals(new JsonObject(), Wire4b.bibleRequest(BibleRequest.of("modern", null).withRarity(BibleRequest.Rarity.defaults())).getAsJsonObject("rarity"));
	}

	@Test
	void feature() {
		assertTrue(ApiRules.features(2, List.of("bible.rarity")).contains("rarityBudgets"));
		assertFalse(ApiRules.features(2, List.of("vocab")).contains("rarityBudgets"));
	}
}
