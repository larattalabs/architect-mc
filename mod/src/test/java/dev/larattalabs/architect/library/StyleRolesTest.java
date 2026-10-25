package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Style unification U0: the Java fan-out (StyleRoles, driven by the kit's table in the checked-in palettes-fallback.json) equals
 * the kit's (kit/lib/styles.mjs) on every parity case tools/gen-palettes.mjs --parity records (kit/test/fixtures/style-parity.json;
 * kit/test/styles.test.mjs holds both files current). And the fallback lists every preset the kit has.
 */
class StyleRolesTest {
	static final Path PARITY = Path.of("../kit/test/fixtures/style-parity.json");

	static Map<String, String> map(JsonElement e) {
		Map<String, String> m = new LinkedHashMap<>();
		e.getAsJsonObject().entrySet().forEach(x -> m.put(x.getKey(), x.getValue().getAsString()));
		return m;
	}

	static Map<String, String> main(Palettes.Inputs in) {
		Map<String, String> m = new LinkedHashMap<>();
		m.put("wood", in.wood());
		m.put("stone", in.stone());
		m.put("roof", in.roof());
		m.put("accent", in.accent());
		return m;
	}

	@Test
	void everyParityCaseMatchesTheKit() throws Exception {
		JsonObject j = JsonParser.parseString(Files.readString(PARITY)).getAsJsonObject();
		StyleRoles s = StyleRoles.fallback();
		JsonObject sets = j.getAsJsonObject("sets");
		int n = 0;
		for (JsonElement ce : j.getAsJsonArray("cases")) {
			JsonObject c = ce.getAsJsonObject();
			String set = c.get("set").getAsString();
			Map<String, String> base = map(sets.get(set));
			String what = set + (c.has("edit") ? " " + c.get("edit") : "");
			if (!c.has("edit")) {
				assertEquals(map(c.get("main")), main(s.mainOf(base)), what);
				assertEquals(map(c.get("provenance")), s.provenance(base, base), what);
			} else {
				String field = c.getAsJsonArray("edit").get(0).getAsString();
				String value = c.getAsJsonArray("edit").get(1).getAsString();
				if (c.has("error")) {
					assertThrows(IllegalArgumentException.class, () -> s.editMain(base, field, value), what);
				} else {
					Map<String, String> r = s.editMain(base, field, value);
					assertEquals(map(c.get("roles")), r, what);
					assertEquals(map(c.get("main")), main(s.mainOf(r)), what);
					assertEquals(map(c.get("provenance")), s.provenance(r, base), what);
				}
			}
			n++;
		}
		assertTrue(n > 200, "cases: " + n);
	}

	@Test
	void fanOutOfEveryPlainPresetIsItsRoles() {
		StyleRoles s = StyleRoles.fallback();
		Palettes p = Palettes.FALLBACK;
		// the kit's presets, with their roles (the fallback is the kit's own output)
		for (String n : List.of("rustic", "oak", "birch", "dark", "fortress", "medieval", "nordic", "japanese", "cozy", "fantasy", "modern")) {
			assertNotNull(p.preset(n), n);
			assertNotNull(p.presetRoles(n), n);
		}
		assertTrue(p.presets().size() >= 16, "presets: " + p.presets().keySet());
		// the presets without extras: the four inputs fan out into exactly their roles
		for (String n : List.of("rustic", "oak", "birch", "dark")) {
			assertEquals(p.presetRoles(n), s.fanOut(p.preset(n)), n);
		}
		assertEquals("minecraft:smooth_sandstone", p.presetRoles("desert").get("wall_alt"));
	}

	@Test
	void editMainKeepsStyleSetRoles() {
		StyleRoles s = StyleRoles.fallback();
		Map<String, String> med = Palettes.FALLBACK.presetRoles("medieval");
		Map<String, String> w = s.editMain(med, "wood", "birch");
		assertEquals("minecraft:white_concrete", w.get("wall"));
		assertEquals("minecraft:birch_log", w.get("frame"));
		assertEquals("follows_wood", s.provenance(w, med).get("frame"));
		assertEquals("style", s.provenance(w, med).get("wall"));
		assertThrows(IllegalArgumentException.class, () -> s.editMain(med, "colour", "red"));
	}
}
