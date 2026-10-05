package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.design.DesignSpec;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class DesignSpecTest {
	static DesignSpec.Draft draft(String type, int x, int y, int z) {
		return new DesignSpec.Draft(type, "rustic", "spruce and cobblestone", List.of("porch", "chimney"), x, y, z, null, null, null, null);
	}

	@Test
	void typesAreTheContracts() {
		// docs/CONTRACT.md "Building types", and Blueprint.TYPES (what a sidecar may say)
		assertEquals(List.of("house", "cabin", "cottage", "tower", "shop", "tavern", "barn", "smithy", "chapel", "gatehouse", "custom"),
			DesignSpec.ids(DesignSpec.TYPES));
		assertEquals(Blueprint.TYPES, DesignSpec.ids(DesignSpec.TYPES));
		assertTrue(DesignSpec.FEATURES.size() >= DesignSpec.MAX_FEATURES);
	}

	@Test
	void validDraftsPass() {
		assertTrue(DesignSpec.validate(draft("cabin", 21, 14, 21)).isEmpty());
		assertTrue(DesignSpec.validate(draft("tower", 7, 64, 7)).isEmpty());
		assertTrue(DesignSpec.validate(draft("custom", 96, 6, 96)).isEmpty());
		// any style text up to 40, a free-form feature id, blanks omitted
		assertTrue(DesignSpec.validate(new DesignSpec.Draft("house", "  art deco seaside  ", " ", List.of("wine_cellar"), 20, 10, 20, null, " ", "",
			null)).isEmpty());
	}

	@Test
	void limitsAreTheSidecars() {
		Map<String, String> e = DesignSpec.validate(draft("castle", 6, 65, 97));
		assertEquals(List.of("type", "maxSize"), List.copyOf(e.keySet()));
		assertTrue(e.get("maxSize").contains("width 6"));
		assertTrue(e.get("maxSize").contains("height 65"));
		assertTrue(e.get("maxSize").contains("depth 97"));
		DesignSpec.Draft bad = new DesignSpec.Draft("house", "x".repeat(41), "m".repeat(201), List.of("porch", "porch"), 20, 10, 20, null,
			"Not An Id", "n".repeat(41), "z".repeat(2001));
		Map<String, String> b = DesignSpec.validate(bad);
		assertEquals(List.of("style", "materials", "features", "remix", "name", "notes"), List.copyOf(b.keySet()));
		assertTrue(b.get("features").contains("duplicate"));
		assertNotNull(DesignSpec.validate(new DesignSpec.Draft("house", " ", null, List.of(), 20, 10, 20, null, null, null, null)).get("style"));
		assertNotNull(DesignSpec.validate(new DesignSpec.Draft("house", "rustic", null, List.of("Big Windows"), 20, 10, 20, null, null, null, null))
			.get("features"));
		List<String> seven = List.of("porch", "chimney", "balcony", "garden", "skylights", "courtyard", "basement");
		assertTrue(DesignSpec.validate(new DesignSpec.Draft("house", "rustic", null, seven, 20, 10, 20, null, null, null, null)).get("features")
			.contains("at most 6"));
	}

	@Test
	void requestJsonOmitsBlanksAndStrips() {
		JsonObject r = DesignSpec.requestJson(new DesignSpec.Draft("cabin", " rustic ", "", List.of("porch"), 21, 14, 21, null, null, " Lake hut ",
			null));
		assertEquals(JsonParser.parseString("{\"type\":\"cabin\",\"style\":\"rustic\",\"features\":[\"porch\"],"
			+ "\"maxSize\":{\"x\":21,\"y\":14,\"z\":21},\"name\":\"Lake hut\"}"), r);
		DesignSpec.Plot plot = DesignSpec.Plot.of(10, 64, 10, 24, 66, 30, 20, "south", "minecraft:overworld");
		JsonObject p = DesignSpec.requestJson(new DesignSpec.Draft("tower", "medieval", "stone", List.of(), 15, 20, 21, plot, "gen_cabin", null,
			"two floors"));
		assertEquals("stone", p.get("materials").getAsString());
		assertEquals("gen_cabin", p.get("remix").getAsString());
		assertEquals("two floors", p.get("notes").getAsString());
		assertEquals(15, p.getAsJsonObject("plot").get("dx").getAsInt());
		assertEquals("south", p.getAsJsonObject("plot").get("front").getAsString());
		assertFalse(p.has("name"));
	}

	@Test
	void presets() {
		assertArrayEquals(new int[] {13, 10, 13}, DesignSpec.preset("S", "cabin"));
		assertArrayEquals(new int[] {21, 14, 21}, DesignSpec.preset("m", "house"));
		assertArrayEquals(new int[] {11, 26, 11}, DesignSpec.preset("M", "tower"));
		assertArrayEquals(new int[] {37, 22, 41}, DesignSpec.preset("L", "barn"));
		for (String type : Blueprint.TYPES) {
			for (String s : List.of("S", "M", "L")) {
				int[] p = DesignSpec.preset(s, type);
				assertTrue(DesignSpec.validate(draft(type, p[0], p[1], p[2])).isEmpty(), type + " " + s);
			}
		}
		assertThrows(IllegalArgumentException.class, () -> DesignSpec.preset("XL", "house"));
	}

	@Test
	void plotFromCorners() {
		DesignSpec.Plot p = DesignSpec.Plot.of(20, 66, 5, 10, 64, 30, 16, "south", "minecraft:overworld");
		assertEquals(10, p.minX());
		assertEquals(64, p.y());
		assertEquals(5, p.minZ());
		assertEquals(11, p.dx());
		assertEquals(26, p.dz());
		assertArrayEquals(new int[] {11, 16, 26}, p.maxSize());
		// fronting east: the entrance side runs along z
		DesignSpec.Plot e = DesignSpec.Plot.of(0, 64, 0, 10, 64, 25, 80, "east", "minecraft:overworld");
		assertArrayEquals(new int[] {26, 64, 11}, e.maxSize());
		assertTrue(DesignSpec.Plot.of(0, 64, 0, 4, 64, 4, 10, "south", "x").tooSmall());
	}

	@Test
	void placementOnAPlot() {
		DesignSpec.Plot p = DesignSpec.Plot.of(0, 64, 0, 20, 64, 14, 16, "west", "minecraft:overworld");
		// a south-fronted 11 x 13 design turned to face west: 13 along x, 11 along z, centred
		int[] at = p.placement("south", 11, 13, 1);
		assertEquals(1, at[3]);
		assertEquals(4, at[0]); // (21 - 13) / 2
		assertEquals(63, at[1]);
		assertEquals(2, at[2]); // (15 - 11) / 2
		assertTrue(p.fits("south", 11, 13));
		assertFalse(p.fits("south", 11, 30));
	}
}
