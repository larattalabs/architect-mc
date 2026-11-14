package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** (SA, A11) A survival quote is an upper bound when the region's paid cells include natural terrain the land may already hold. */
class QuotesMayHoldTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@Test
	void x03sHamletIsAnUpperBound() {
		// x03's hamlet as measured: its grading columns' 49 dirt, the lamps' lanterns and fences
		JsonObject tiles = JsonParser.parseString("{\"hamlet\":{\"minecraft:dirt\":49,\"minecraft:lantern\":4,\"minecraft:oak_fence\":4},"
			+ "\"cellar:entrance\":{\"minecraft:ladder\":4,\"minecraft:spruce_trapdoor\":1}}").getAsJsonObject();
		String n = Quotes.mayAlreadyHold(tiles);
		assertNotNull(n);
		assertTrue(n.contains("49 paid cell(s)") && n.contains("hamlet (49 dirt)") && n.contains("upper bound") && !n.contains("lantern")
			&& !n.contains("cellar"), n);
	}

	@Test
	void builtBlocksOnlyStayExact() {
		JsonObject tiles = JsonParser.parseString("{\"walls\":{\"minecraft:stone_bricks\":40,\"minecraft:oak_planks\":12,\"minecraft:lantern\":2}}")
			.getAsJsonObject();
		assertNull(Quotes.mayAlreadyHold(tiles), "no natural terrain: exact");
		assertNull(Quotes.mayAlreadyHold(new JsonObject()));
	}
}
