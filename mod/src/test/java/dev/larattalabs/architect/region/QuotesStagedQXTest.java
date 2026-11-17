package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Quote;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8a QX, docs/CONTRACT.md "Phase 8a" §5) {@link Quote#terrainCells} from plan.json's {@code survivalStaged}: the time side only. A plan
 * planned before QX has none (empty, not a refusal); only positive counts are kept, sorted by group; the bill members are untouched.
 */
class QuotesStagedQXTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@Test
	void absentIsEmpty() {
		assertTrue(Quotes.stagedCells(null).isEmpty());
		assertTrue(Quotes.stagedCells(new JsonObject()).isEmpty());
	}

	@Test
	void keepsPositiveCountsSorted() {
		JsonObject st = JsonParser.parseString("{\"isle\":8884,\"hamlet\":8139,\"zero\":0,\"bad\":\"x\",\"obj\":{}}").getAsJsonObject();
		Map<String, Long> m = Quotes.stagedCells(st);
		assertEquals(Map.of("hamlet", 8139L, "isle", 8884L), m);
		assertEquals(List.of("hamlet", "isle"), List.copyOf(m.keySet()));
	}

	@Test
	void quoteCarriesThemWithTheBillUnchanged() {
		JsonObject bom = JsonParser.parseString("{\"minecraft:oak_planks\":57}").getAsJsonObject();
		JsonObject parts = JsonParser.parseString("{\"tiles:hamlet\":{\"minecraft:oak_planks\":57}}").getAsJsonObject();
		Map<String, Long> staged = Quotes.stagedCells(JsonParser.parseString("{\"hamlet\":8139,\"isle\":8884}").getAsJsonObject());
		Quote before = new Quote("p", null, null, true, bom, parts, Map.of(), true, List.of("n"), Map.of());
		Quote after = new Quote("p", null, null, true, bom, parts, Map.of(), true, List.of("n"), Map.of(), staged);
		assertEquals(before.bom(), after.bom());
		assertEquals(before.bomParts(), after.bomParts());
		assertEquals(before.terrain(), after.terrain());
		assertEquals(before.notes(), after.notes());
		assertTrue(before.terrainCells().isEmpty());
		assertEquals(Map.of("hamlet", 8139L, "isle", 8884L), after.terrainCells());
	}
}
