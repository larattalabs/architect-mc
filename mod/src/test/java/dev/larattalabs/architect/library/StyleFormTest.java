package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Style unification U2: StyleForm (both editor modes) replays every form op sequence the kit records (kit/lib/styles.mjs formApply /
 * formView; tools/gen-palettes.mjs --parity -> kit/test/fixtures/style-parity.json {@code forms}) to the same view after each op, and
 * refuses exactly the ops the kit refuses. Plus the rules spelled out: provenance, the custom mix, the swap rules, Save as style.
 */
class StyleFormTest {
	static JsonObject parity() throws Exception {
		return JsonParser.parseString(Files.readString(StyleRolesTest.PARITY)).getAsJsonObject();
	}

	static List<String> strings(JsonArray a) {
		List<String> l = new ArrayList<>();
		a.forEach(x -> l.add(x.getAsString()));
		return l;
	}

	static void apply(StyleForm f, JsonArray op, Map<String, StyleForm.Style> styles) {
		String kind = op.get(0).getAsString();
		switch (kind) {
			case "pick" -> f.pick(styles.get(op.get(1).getAsString()));
			case "unpick" -> f.unpick();
			case "revert" -> f.revert();
			case "main" -> f.editMain(op.get(1).getAsString(), op.get(2).getAsString());
			case "role" -> f.setRole(op.get(1).getAsString(), op.get(2).getAsString());
			case "feature" -> f.toggleFeature(op.get(1).getAsString());
			case "features" -> f.setFeatures(strings(op.get(1).getAsJsonArray()));
			default -> throw new AssertionError("unknown op " + kind);
		}
	}

	@Test
	void everyFormSequenceMatchesTheKit() throws Exception {
		JsonObject j = parity();
		StyleRoles t = StyleRoles.fallback();
		Map<String, StyleForm.Style> styles = new HashMap<>();
		j.getAsJsonObject("formStyles").entrySet().forEach(e -> styles.put(e.getKey(), StyleForm.Style.fromJson(e.getValue().getAsJsonObject(), t)));
		int ops = 0;
		int errors = 0;
		for (JsonElement ce : j.getAsJsonArray("forms")) {
			JsonObject c = ce.getAsJsonObject();
			String name = c.get("name").getAsString();
			JsonObject start = c.getAsJsonObject("start");
			StyleForm.Mode mode = start.get("mode").getAsString().equals("new") ? StyleForm.Mode.NEW : StyleForm.Mode.VARIANT;
			StyleForm f = new StyleForm(mode, start.has("style") ? styles.get(start.get("style").getAsString()) : null, start.has("features") ? strings(start
				.getAsJsonArray("features")) : List.of(), t, Palettes.FALLBACK);
			assertEquals(c.get("initial"), f.view(), name + ": initial");
			JsonArray opl = c.getAsJsonArray("ops");
			JsonArray views = c.getAsJsonArray("views");
			for (int i = 0; i < opl.size(); i++) {
				JsonArray op = opl.get(i).getAsJsonArray();
				JsonObject want = views.get(i).getAsJsonObject();
				String what = name + " #" + i + " " + op;
				if (want.has("error")) {
					JsonObject before = f.view();
					assertThrows(RuntimeException.class, () -> apply(f, op, styles), what);
					assertEquals(before, f.view(), what + ": a refused op leaves the state");
					errors++;
				} else {
					apply(f, op, styles);
					assertEquals(want, f.view(), what);
				}
				ops++;
			}
		}
		assertTrue(ops > 150 && errors >= 10, ops + " ops, " + errors + " refusals");
	}

	@Test
	void builtInStylesFromTheCheckedInPalettes() {
		for (String n : List.of("rustic", "medieval", "modern")) {
			StyleForm.Style s = StyleForm.Style.preset(Palettes.FALLBACK, n);
			assertNotNull(s, n);
			assertEquals(StyleForm.PRESET, s.kind());
			assertFalse(s.suggestedFeatures().isEmpty(), n);
			assertFalse(s.tags().isEmpty(), n);
		}
		assertEquals(List.of("chimney", "porch"), StyleForm.Style.preset(Palettes.FALLBACK, "rustic").suggestedFeatures());
	}

	@Test
	void newModeOutputIsWithStyleOrAMixBasedOnIt() {
		StyleForm f = new StyleForm(StyleForm.Mode.NEW, null, List.of("porch"));
		assertEquals(new JsonObject(), f.request(), "no Style: free text, no palette");
		f.pick(StyleForm.Style.preset(Palettes.FALLBACK, "medieval"));
		JsonObject p = f.request().getAsJsonObject("palette").getAsJsonObject("bible");
		assertEquals("medieval", p.get("id").getAsString());
		assertEquals("minecraft:white_terracotta", p.getAsJsonObject("roles").get("wall").getAsString());
		assertEquals(List.of("porch", "chimney", "balcony"), f.features());
		assertTrue(f.fromStyle("chimney") && !f.fromStyle("porch"));
		f.editMain("wood", "birch");
		assertTrue(f.mix());
		assertEquals("follows_wood", f.provenance().get("frame"));
		assertEquals("style", f.provenance().get("wall"));
		assertEquals("birch", f.main().get("wood"));
		JsonObject save = f.saveRequest("Birch daub");
		assertEquals("Birch daub", save.get("name").getAsString());
		assertEquals("medieval", save.getAsJsonObject("basedOn").get("id").getAsString());
		assertEquals("hand", save.get("origin").getAsString());
		assertEquals("minecraft:birch_log", save.getAsJsonObject("roles").get("frame").getAsString());
		f.revert();
		assertFalse(f.mix());
	}

	@Test
	void aHandRoleNeverMovesAMainRow() {
		StyleForm f = new StyleForm(StyleForm.Mode.NEW, StyleForm.Style.preset(Palettes.FALLBACK, "oak"), List.of());
		f.setRole("frame", "birch_log");
		assertEquals("birch", StyleRoles.fallback().mainOf(f.roles()).wood(), "read back from the roles, Wood would drift");
		assertEquals("oak", f.main().get("wood"));
		f.editMain("wood", "spruce");
		assertEquals("minecraft:birch_log", f.roles().get("frame"));
		assertEquals("minecraft:spruce_planks", f.roles().get("wall"));
	}

	@Test
	void variantModeFeaturesAreFixed() {
		StyleForm f = new StyleForm(StyleForm.Mode.VARIANT, StyleForm.Style.preset(Palettes.FALLBACK, "rustic"), List.of());
		assertThrows(IllegalStateException.class, () -> f.toggleFeature("porch"));
		assertFalse(f.changed());
		f.pick(StyleForm.Style.preset(Palettes.FALLBACK, "birch"));
		assertEquals("birch", f.request().get("palette").getAsString());
	}
}
