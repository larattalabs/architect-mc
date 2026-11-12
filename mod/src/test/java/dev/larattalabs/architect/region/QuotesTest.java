package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/** (M5 QT) Quotes' bill: the pieces in the plan check's cost.bomParts shape, their sum the cost.bom shape (sorted, no zeros). */
class QuotesTest {
	@Test
	void piecesSumIntoTheBom() {
		Quotes.Bill b = new Quotes.Bill();
		b.add("tiles:lanes", Map.of("minecraft:gravel", 12, "minecraft:cobblestone", 3));
		b.add("lot:qa", new TreeMap<>(Map.of("minecraft:oak_planks", 40, "minecraft:cobblestone", 9)));
		b.add("road:street_1", Map.of("minecraft:dirt_path", 5));
		assertEquals("{\"minecraft:cobblestone\":12,\"minecraft:dirt_path\":5,\"minecraft:gravel\":12,\"minecraft:oak_planks\":40}", b.bom().toString(), "summed, sorted by id");
		assertEquals(3, b.parts.size());
		assertEquals(9, b.parts.getAsJsonObject("lot:qa").get("minecraft:cobblestone").getAsInt());
		assertTrue(b.exact);
	}

	@Test
	void emptyAndZeroPiecesAreLeftOut() {
		Quotes.Bill b = new Quotes.Bill();
		b.add("mech:gate_1", Map.of());
		b.add("fluids", Map.of("minecraft:lava_bucket", 0));
		assertFalse(b.parts.has("mech:gate_1"), "an empty piece is not named");
		assertFalse(b.parts.has("fluids"), "a piece of zeros is not named");
		assertTrue(b.bom().isEmpty());
	}

	@Test
	void aPieceAddedTwiceSums() {
		Quotes.Bill b = new Quotes.Bill();
		b.add("lot:qa", Map.of("minecraft:glass", 2));
		b.add("lot:qa", Map.of("minecraft:glass", 3, "minecraft:torch", 1));
		assertEquals(5, b.parts.getAsJsonObject("lot:qa").get("minecraft:glass").getAsInt());
		assertEquals(5, b.bom().get("minecraft:glass").getAsInt());
		assertEquals(1, b.bom().get("minecraft:torch").getAsInt());
	}
}
