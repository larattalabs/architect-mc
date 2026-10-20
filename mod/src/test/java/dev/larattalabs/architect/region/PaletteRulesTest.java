package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.PaletteCheck;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionRefused;
import dev.larattalabs.architect.api.Regions;
import dev.larattalabs.architect.apiimpl.ApiRules;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (6c VOC-c) The mod's palette measure (docs/CONTRACT.md "Phase 6c slice VOC-c" §4): one function for the pre-check, the realiseApproved
 * refusal and the delta re-judge, over the artifact's rows only (no vocabulary): the parts' counts plus each bound lot's histogram less
 * the row's unmeasured blocks; the share and its bounds; the worst lot; a non-required rule never refuses; the API additions.
 */
class PaletteRulesTest {
	/** An artifact body: one required copper rule over lots a and b, the parts 100 of 100 copper; one optional "no wood" rule over a. */
	static JsonObject body() {
		return JsonParser.parseString("""
			{"lots": [{"id": "a", "entry": "copper_cabin"}, {"id": "b"}],
			 "palette": [
			  {"rule": "copper_only", "required": true, "family": "copper", "share": [1, 1], "lots": ["a", "b"],
			   "blocks": ["minecraft:copper_block", "minecraft:cut_copper", "minecraft:copper_door"], "natural": ["minecraft:air", "minecraft:dirt", "minecraft:water"],
			   "partsCells": 100, "partsFamily": 100, "lotCounts": {"a": [10, 10]}},
			  {"rule": "no_wood", "required": false, "family": "wood", "share": [0, 0], "lots": ["a"],
			   "blocks": ["minecraft:oak_planks", "minecraft:oak_door"], "natural": ["minecraft:air", "minecraft:dirt", "minecraft:water"],
			   "partsCells": 50, "partsFamily": 0, "lotCounts": {}}
			 ]}""").getAsJsonObject();
	}

	static final Map<String, Map<String, Long>> HIST = Map.of(
		"copper_cabin", Map.of("minecraft:copper_block", 8L, "minecraft:cut_copper", 2L, "minecraft:dirt", 5L),
		"oak_cabin", Map.of("minecraft:oak_planks", 30L, "minecraft:oak_door", 2L, "minecraft:copper_block", 8L));

	static PaletteCheck run(Map<String, String> entries) {
		return PaletteRules.measure(body(), entries, (lot, entry) -> HIST.get(PaletteRules.bare(entry)));
	}

	@Test
	void theArtifactsOwnEntriesFit() {
		PaletteCheck c = run(PaletteRules.bound(body(), Map.of()));
		assertTrue(c.ok());
		PaletteCheck.Rule r = c.rules().get(0);
		assertEquals("copper_only", r.rule());
		// the parts' 100, plus lot a's 10 (its 5 dirt are natural: not measured); b has no entry (a pad: pending)
		assertEquals(110, r.cells());
		assertEquals(110, r.familyCells());
		assertEquals(1.0, r.share());
		assertEquals(List.of("b"), r.pendingLots());
		assertNull(PaletteRules.refusal(c));
	}

	@Test
	void anOakLotRefusesTheRequiredRuleNamingTheWorstLot() {
		PaletteCheck c = run(PaletteRules.bound(body(), Map.of("b", "oak_cabin@2")));
		assertFalse(c.ok());
		PaletteCheck.Rule r = c.rules().get(0);
		assertEquals(150, r.cells());
		assertEquals(118, r.familyCells());
		assertEquals(118 / 150.0, r.share());
		assertFalse(r.fits());
		assertEquals("b", r.worstLot());
		String[] why = PaletteRules.refusal(c);
		assertNotNull(why);
		assertEquals("copper_only", why[1]);
		assertTrue(why[0].contains("\"lot\":\"b\"") && why[0].contains("\"entry\":\"oak_cabin@2\"") && why[0].contains("\"family\":\"copper\""), why[0]);
		// the non-required rule over lot a still fits (a copper cabin has no wood); rows for the realise's ext
		assertTrue(c.rules().get(1).fits());
		assertEquals(2, PaletteRules.extRows(c).size());
	}

	@Test
	void aNonRequiredRuleNeverRefuses() {
		PaletteCheck c = run(Map.of("a", "oak_cabin"));
		PaletteCheck.Rule wood = c.rules().stream().filter(x -> x.rule().equals("no_wood")).findFirst().orElseThrow();
		assertFalse(wood.fits());
		assertEquals("a", wood.worstLot(), "share max 0: the lot with the most family cells");
		// copper_only breaks too (a's oak), and is required
		assertEquals("copper_only", PaletteRules.refusal(c)[1]);
		PaletteCheck only = PaletteRules.measure(JsonParser.parseString("{\"palette\": [" + body().getAsJsonArray("palette").get(1) + "]}").getAsJsonObject(),
			Map.of("a", "oak_cabin"), (lot, entry) -> HIST.get(entry));
		assertTrue(only.ok());
		assertNull(PaletteRules.refusal(only));
	}

	@Test
	void noMeasuredCellFitsAndNoRowsAnswerOk() {
		JsonObject b = JsonParser.parseString("""
			{"palette": [{"rule": "r", "required": true, "family": "copper", "share": [1, 1], "lots": [], "blocks": [], "natural": [], "partsCells": 0, "partsFamily": 0}]}""")
			.getAsJsonObject();
		PaletteCheck c = PaletteRules.measure(b, Map.of(), (lot, entry) -> null);
		assertTrue(c.ok());
		assertNull(c.rules().get(0).share());
		assertTrue(PaletteRules.measure(new JsonObject(), Map.of(), (lot, entry) -> null).rules().isEmpty());
	}

	@Test
	void theApiAdditions() {
		assertTrue(dev.larattalabs.architect.region.IrStale.semverCompare(ArchitectApi.VERSION, "1.39.0") >= 0, ArchitectApi.VERSION);
		assertEquals(Reason.ADOPT_REFUSED.ordinal() + 1, Reason.PALETTE.ordinal(), "VOC-c appends PALETTE after ADOPT_REFUSED");
		assertTrue(assertDoesNotThrowM(() -> Regions.class.getMethod("checkPalette", String.class, Map.class)).isDefault(), "a default method (binary compatible)");
		ArchitectRefused e = new RegionRefused(Reason.PALETTE, "m", "copper_only");
		assertEquals("copper_only", e.detail());
		assertTrue(ApiRules.features(2, List.of("plan.rules")).contains("rulePalette"));
		assertTrue(PaletteRules.hasPalette(JsonParser.parseString("{\"rules\": [{\"id\": \"r\", \"kind\": \"palette\"}]}").getAsJsonObject()));
		assertFalse(PaletteRules.hasPalette(JsonParser.parseString("{\"rules\": [{\"id\": \"r\", \"kind\": \"shape\"}]}").getAsJsonObject()));
		assertEquals(0, PaletteRules.lotBlocks(JsonParser.parseString("{\"zones\": []}").getAsJsonObject()).size(), "no palette rule: no lotBlocks");
	}

	static java.lang.reflect.Method assertDoesNotThrowM(org.junit.jupiter.api.function.ThrowingSupplier<java.lang.reflect.Method> s) {
		return org.junit.jupiter.api.Assertions.assertDoesNotThrow(s);
	}
}
