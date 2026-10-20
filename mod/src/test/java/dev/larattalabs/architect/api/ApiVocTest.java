package dev.larattalabs.architect.api;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.region.IrStale;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * API 1.35.0 (released in the VOC batch as v0.38.0; docs/CONTRACT.md "Phase 6c slice VOC" §7): {@link BibleRequest.Rarity}, the
 * typed budget record (S-VOC-5), as BibleRequest's trailing component with the 1.10.0 constructor kept; the feature vocabulary (sidecar
 * vocab); the versions.
 */
class ApiVocTest {
	@Test
	void versionsAndFeature() {
		assertTrue(IrStale.semverCompare(ArchitectApi.VERSION, "1.35.0") >= 0, ArchitectApi.VERSION);
		assertTrue(IrStale.semverCompare(IrStale.KIT_VERSION, "0.36.0") >= 0, IrStale.KIT_VERSION);
		assertTrue(ApiRules.features(2, List.of("vocab")).contains("vocabulary"));
		assertFalse(ApiRules.features(2, List.of("region.wet")).contains("vocabulary"));
		assertFalse(ApiRules.features(1, List.of("vocab")).contains("vocabulary"), "protocol 1 has no helper features");
	}

	@Test
	void rarityRecord() {
		BibleRequest old = new BibleRequest("p", null, null, null, null, null, List.of(), null, null, false, "k1");
		assertNull(old.rarity(), "the 1.10.0 constructor has no budget");
		Map<String, Double> fam = new LinkedHashMap<>();
		fam.put("wool", 0.2);
		fam.put("concrete", 0.5);
		BibleRequest.Rarity r = new BibleRequest.Rarity(0.2, null, 1, null, fam, List.of("white", "light_gray", "black"), 3, null, List.of("minecraft:beacon", "#minecraft:wool"));
		BibleRequest b = old.withRarity(r);
		assertSame(r, b.rarity());
		assertEquals("k1", b.opKey());
		// every copy carries the budget (no silent drop)
		assertSame(r, b.withOpKey("k2").rarity());
		assertSame(r, b.withSheetCritique(true).rarity());
		assertEquals(JsonParser.parseString("{\"uncommonShareMax\":0.2,\"preciousMax\":1,\"families\":{\"concrete\":0.5,\"wool\":0.2},"
			+ "\"colours\":[\"white\",\"light_gray\",\"black\"],\"coloursMax\":3,\"allow\":[\"minecraft:beacon\",\"#minecraft:wool\"]}"), r.toJson());
		assertEquals(JsonParser.parseString("{}"), BibleRequest.Rarity.defaults().toJson(), "no member set: the defaults, nothing written");
		assertNull(BibleRequest.of("p", null).rarity());
	}
}
