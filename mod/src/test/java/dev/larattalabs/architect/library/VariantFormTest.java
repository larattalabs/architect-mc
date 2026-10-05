package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Param controls from a {@code params} schema, palettes, and the variant.request payload. */
class VariantFormTest {
	static JsonObject json(String s) {
		return JsonParser.parseString(s).getAsJsonObject();
	}

	static final JsonObject PARAMS = json("""
		{
		  "floors": { "type": "int", "min": 1, "max": 3, "default": 1, "label": "Floors" },
		  "width":  { "type": "int", "min": 7, "max": 15, "default": 9 },
		  "porch":  { "type": "bool", "default": true, "label": "Porch" },
		  "roof":   { "type": "enum", "options": ["gable", "hip", "flat"], "default": "gable", "label": "Roof style" },
		  "bad":    { "type": "int", "min": 5, "max": 1 },
		  "weird":  { "type": "color" },
		  "notObj": 3
		}
		""");
	static final JsonObject PALETTE = json("""
		{ "preset": "rustic", "wood": "spruce", "stone": "cobblestone", "roof": "dark_oak", "accent": "dark_oak" }
		""");

	@Test
	void controlsFromSchema() {
		List<String> skipped = new ArrayList<>();
		List<VariantForm.Param> ps = VariantForm.controls(PARAMS, skipped);
		assertEquals(List.of("floors", "width", "porch", "roof"), ps.stream().map(VariantForm.Param::name).toList());
		VariantForm.IntParam floors = assertInstanceOf(VariantForm.IntParam.class, ps.get(0));
		assertEquals(1, floors.min());
		assertEquals(3, floors.max());
		assertEquals("Width", ps.get(1).label(), "label defaults to the humanized name");
		assertInstanceOf(VariantForm.BoolParam.class, ps.get(2));
		VariantForm.EnumParam roof = assertInstanceOf(VariantForm.EnumParam.class, ps.get(3));
		assertEquals(List.of("gable", "hip", "flat"), roof.options());
		assertEquals(3, skipped.size(), skipped.toString());
		assertEquals(List.of(), VariantForm.controls(null, skipped));
		assertEquals("Roof style", VariantForm.humanize("roofStyle"));
		assertEquals("Big windows", VariantForm.humanize("big_windows"));
	}

	@Test
	void coercion() {
		VariantForm.IntParam p = new VariantForm.IntParam("floors", "Floors", 1, 3, 1);
		assertEquals(new JsonPrimitive(3), p.coerce(new JsonPrimitive(9)));
		assertEquals(new JsonPrimitive(1), p.coerce(new JsonPrimitive("x")));
		assertEquals(new JsonPrimitive(2), p.coerce(new JsonPrimitive(2.4)));
		VariantForm.EnumParam e = new VariantForm.EnumParam("roof", "Roof", List.of("gable", "hip"), "gable");
		assertEquals(new JsonPrimitive("gable"), e.coerce(new JsonPrimitive("dome")));
		VariantForm.BoolParam b = new VariantForm.BoolParam("porch", "Porch", true);
		assertEquals(new JsonPrimitive(false), b.coerce(new JsonPrimitive("false")));
	}

	@Test
	void unchangedFormSendsNothingToMake() {
		VariantForm f = new VariantForm("gen_cabin", PARAMS, json("{\"floors\": 1, \"width\": 9, \"porch\": true}"), PALETTE, Palettes.FALLBACK);
		assertEquals("rustic", f.preset());
		assertFalse(f.changed());
		assertEquals(json("{\"from\": \"gen_cabin\"}"), f.requestJson());
		assertEquals(new JsonPrimitive("gable"), f.value("roof"), "missing values read as the default");
	}

	@Test
	void presetChipSendsTheName() {
		VariantForm f = new VariantForm("gen_cabin", PARAMS, null, PALETTE, Palettes.FALLBACK);
		f.choosePreset("birch");
		assertTrue(f.paletteChanged());
		assertEquals(json("{\"from\": \"gen_cabin\", \"palette\": \"birch\"}"), f.requestJson());
		f.choosePreset("rustic");
		assertFalse(f.changed(), "back to where it was");
		assertThrows(IllegalArgumentException.class, () -> f.choosePreset("nope"));
	}

	@Test
	void advancedFieldSendsTheInputs() {
		VariantForm f = new VariantForm("gen_cabin", PARAMS, null, PALETTE, Palettes.FALLBACK);
		f.setField("wood", "minecraft:cherry");
		assertNull(f.preset(), "no preset has these inputs");
		assertEquals(json("""
			{"from": "gen_cabin", "palette": {"wood": "cherry", "stone": "cobblestone", "roof": "dark_oak", "accent": "dark_oak"}}"""), f.requestJson());
		f.setField("wood", "spruce");
		assertEquals("rustic", f.preset(), "the inputs are a preset's again");
		assertFalse(f.changed());
	}

	@Test
	void paramChangesSendOnlyWhatChanged() {
		VariantForm f = new VariantForm("gen_cabin", PARAMS, json("{\"floors\": 1, \"width\": 9}"), PALETTE, Palettes.FALLBACK);
		f.step("floors", 1);
		f.step("floors", 5);
		f.step("width", -1);
		f.step("width", 1);
		f.toggle("porch");
		f.set("roof", new JsonPrimitive("hip"));
		f.setName("  Tall cabin ");
		assertEquals(json("""
			{"from": "gen_cabin", "values": {"floors": 3, "porch": false, "roof": "hip"}, "name": "Tall cabin"}"""), f.requestJson());
		assertThrows(IllegalArgumentException.class, () -> f.set("nope", new JsonPrimitive(1)));
	}

	@Test
	void entryWithoutPaletteOrParams() {
		VariantForm f = new VariantForm("cabin", null, null, null, Palettes.FALLBACK);
		assertNull(f.preset());
		assertTrue(f.params().isEmpty());
		assertFalse(f.changed());
		f.choosePreset("dark");
		assertEquals(json("{\"from\": \"cabin\", \"palette\": \"dark\"}"), f.requestJson());
	}

	@Test
	void palettesParseKitShapes() {
		Palettes p = Palettes.parse(json("""
			{ "presets": { "rustic": { "wood": "spruce", "stoneName": "cobblestone", "roofName": "dark_oak", "accentWood": "dark_oak" },
			               "fortress": { "inputs": { "wood": "dark_oak", "stone": "minecraft:deepslate_bricks", "roof": "deepslate_tiles" } } },
			  "woods": ["oak", "spruce"] }
			"""), "test");
		assertNotNull(p);
		assertEquals(List.of("rustic", "fortress"), List.copyOf(p.presets().keySet()));
		assertEquals("deepslate_bricks", p.preset("fortress").stone(), "minecraft: is dropped");
		assertTrue(p.woods().containsAll(List.of("oak", "spruce", "dark_oak")), "preset woods join the list");
		assertTrue(p.roofs().contains("deepslate_tiles"));
		assertEquals("rustic", p.presetMatching(new Palettes.Inputs("spruce", "cobblestone", "dark_oak", "dark_oak")));
		Palettes list = Palettes.parse(json("{\"presets\": [{\"name\": \"oak\", \"wood\": \"oak\"}]}"), "test");
		assertNotNull(list);
		assertEquals("oak", list.preset("oak").wood());
		assertNull(Palettes.parse(json("{}"), "test"));
	}
}
