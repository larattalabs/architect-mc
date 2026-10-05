package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.design.DesignSpec;
import dev.larattalabs.architect.design.SetSpec;
import dev.larattalabs.architect.placement.Blueprint;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The pure rules behind the phase 4b UI: collections, the re-skin in the Variants dialog, open types, the set dialog. */
class Phase4bUiRulesTest {
	static LibraryCard card(String id, String extra) {
		String json = """
			{ "id": "%s", "name": "%s", "type": "cabin", "size": {"x": 9, "y": 9, "z": 9}, "source": "%s.mjs", "createdAt": 1 %s }
			""".formatted(id, id, id, extra);
		JsonObject o = JsonParser.parseString(json).getAsJsonObject();
		return LibraryCard.of(Blueprint.fromJson(o), o, LibraryMeta.NONE, false);
	}

	static final LibraryCard A = card("gen_a", ", \"bible\": {\"id\": \"bib_ash\", \"version\": 2}, \"group\": \"g1\", \"groupItem\": \"lot/a\"");
	static final LibraryCard B = card("gen_b", ", \"bible\": {\"id\": \"bib_ash\", \"version\": 1}, \"group\": \"g2\"");
	static final LibraryCard C = card("gen_a_dark", ", \"bible\": {\"id\": \"dark\", \"version\": 1}, \"variantOf\": \"gen_a\"");
	static final LibraryCard PLAIN = card("gen_plain", "");

	@Test
	void cardsCarryTheirCollections() {
		assertEquals("bib_ash", A.bible());
		assertEquals(2, A.bibleVersion());
		assertEquals("g1", A.group());
		assertEquals("lot/a", A.groupItem());
		assertEquals(List.of("bible:bib_ash", "group:g1"), A.collections());
		assertEquals(List.of(), PLAIN.collections());
		assertNull(PLAIN.bible());
		assertEquals(0, PLAIN.bibleVersion());
	}

	@Test
	void collectionFilter() {
		List<LibraryCard> all = List.of(A, B, C, PLAIN);
		assertEquals(List.of("gen_a", "gen_b"), LibraryQuery.ALL.withCollection("bible:bib_ash").apply(all).stream().map(LibraryCard::id).sorted().toList());
		assertEquals(List.of("gen_a"), LibraryQuery.ALL.withCollection("group:g1").apply(all).stream().map(LibraryCard::id).toList());
		assertEquals(List.of("gen_a_dark"), LibraryQuery.ALL.withCollection("bible:dark").apply(all).stream().map(LibraryCard::id).toList());
		assertEquals(4, LibraryQuery.ALL.apply(all).size());
		assertTrue(LibraryQuery.ALL.withCollection("group:g1").filtered());
		// other filters keep the collection, and the old 5-argument query has none
		LibraryQuery q = LibraryQuery.ALL.withCollection("group:g1").withText("gen").withSort(LibraryQuery.Sort.NAME).withType("cabin");
		assertEquals("group:g1", q.collection());
		assertNull(new LibraryQuery(null, null, false, "", LibraryQuery.Sort.NEWEST).collection());
		var cols = LibraryQuery.collections(all);
		assertEquals(List.of("bible:bib_ash", "bible:dark", "group:g1", "group:g2"), cols.stream().map(LibraryQuery.CollectionInfo::key).toList());
		assertEquals(2, cols.get(0).count());
		assertTrue(cols.get(0).bible() && !cols.get(2).bible());
	}

	@Test
	void variantWithABible() {
		JsonObject pal = JsonParser.parseString("{\"preset\":\"rustic\",\"wood\":\"spruce\",\"stone\":\"cobblestone\",\"roof\":\"dark_oak\",\"accent\":\"dark_oak\"}")
			.getAsJsonObject();
		VariantForm f = new VariantForm("gen_a", null, null, pal, Palettes.FALLBACK);
		assertFalse(f.changed());
		f.chooseBible("bib_ash");
		assertTrue(f.changed());
		JsonObject r = f.requestJson();
		assertEquals("bib_ash", r.get("bible").getAsString());
		assertFalse(r.has("palette"), "a bible excludes the palette");
		f.choosePreset("oak");
		assertNull(f.bible(), "a preset drops the bible");
		assertEquals("oak", f.requestJson().get("palette").getAsString());
		f.chooseBible("bib_ash");
		f.setField("wood", "birch");
		assertNull(f.bible(), "an advanced palette field drops the bible");
		// a re-skinned entry records its palette as {bible: {...}}: the form opens on it (no preset, no crash)
		JsonObject biblePalette = JsonParser.parseString("{\"bible\":{\"id\":\"dark\",\"version\":1,\"roles\":{\"wall\":\"minecraft:dark_oak_planks\"}}}")
			.getAsJsonObject();
		VariantForm g = new VariantForm("gen_a_dark", null, null, biblePalette, Palettes.FALLBACK);
		assertFalse(g.changed());
		assertNull(g.preset());
	}

	@Test
	void openTypesAndProfiles() {
		DesignSpec.Draft open = new DesignSpec.Draft("hellish_lair", "spiky", null, List.of(), 21, 20, 21, null, null, null, null, List.of("door",
			"passage:3x4", "tall:1.5", "min_interior_volume:200"), "bib_ash");
		assertTrue(DesignSpec.validate(open).isEmpty(), DesignSpec.validate(open).toString());
		JsonObject r = DesignSpec.requestJson(open);
		assertEquals("hellish_lair", r.get("type").getAsString());
		assertEquals(4, r.getAsJsonArray("profile").size());
		assertEquals("bib_ash", r.get("bible").getAsString());
		// no profile: the default; a preset type sends none
		JsonObject d = DesignSpec.requestJson(new DesignSpec.Draft("mining_hall", "x", null, List.of(), 21, 14, 21, null, null, null, null, List.of(),
			null));
		assertEquals(DesignSpec.DEFAULT_PROFILE, d.getAsJsonArray("profile").asList().stream().map(e -> e.getAsString()).toList());
		assertFalse(DesignSpec.requestJson(new DesignSpec.Draft("cabin", "x", null, List.of(), 21, 14, 21, null, null, null, null, List.of("door"),
			null)).has("profile"));
		Map<String, String> bad = DesignSpec.validate(new DesignSpec.Draft("lair", "x", null, List.of(), 21, 14, 21, null, null, null, null,
			List.of("fly"), null));
		assertTrue(bad.get("type").contains("fly"));
		assertTrue(DesignSpec.validate(new DesignSpec.Draft("9lair", "x", null, List.of(), 21, 14, 21, null, null, null, null)).containsKey("type"));
		for (DesignSpec.Choice c : DesignSpec.PROFILE_RULES) {
			assertTrue(DesignSpec.PROFILE_RULE.matcher(c.id()).matches(), c.id());
		}
	}

	@Test
	void setDialog() {
		SetSpec.Draft ok = new SetSpec.Draft("Ashfall hamlet", "bib_ash", List.of(new SetSpec.Item("tower", "Watch", true, "spiky"),
			new SetSpec.Item("house", "", false, null), new SetSpec.Item("hellish_lair", "Lair", false, "")), 2, 5.0);
		assertTrue(SetSpec.validate(ok).isEmpty(), SetSpec.validate(ok).toString());
		JsonObject g = SetSpec.groupJson(ok, "Ashfall");
		assertEquals("bib_ash", g.get("bible").getAsString());
		assertEquals(2, g.get("concurrency").getAsInt());
		assertEquals(5.0, g.get("budgetUsd").getAsDouble());
		var items = g.getAsJsonArray("items");
		JsonObject t = items.get(0).getAsJsonObject();
		assertEquals("landmark", t.get("role").getAsString());
		assertTrue(t.get("anchor").getAsBoolean());
		assertEquals("Ashfall", t.get("style").getAsString());
		assertEquals(DesignSpec.preset("L", "tower")[1], t.getAsJsonObject("maxSize").get("y").getAsInt(), "a landmark gets the L size");
		JsonObject h = items.get(1).getAsJsonObject();
		assertEquals("ordinary", h.get("role").getAsString());
		assertFalse(h.has("anchor") || h.has("name") || h.has("notes") || h.has("profile"));
		assertEquals(DesignSpec.preset("M", "house")[0], h.getAsJsonObject("maxSize").get("x").getAsInt());
		assertEquals(3, items.get(2).getAsJsonObject().getAsJsonArray("profile").size());
		assertFalse(SetSpec.groupJson(new SetSpec.Draft("S", "oak", ok.items(), 3, null), null).has("budgetUsd"));
		// problems: no bible, a bad type, too many items, a bad concurrency
		List<SetSpec.Item> many = java.util.Collections.nCopies(25, new SetSpec.Item("house", null, false, null));
		Map<String, String> e = SetSpec.validate(new SetSpec.Draft(" ", null, List.of(new SetSpec.Item("Bad Type", null, false, null)), 9, -1.0));
		assertEquals(List.of("name", "bible", "item1", "concurrency", "budget"), List.copyOf(e.keySet()));
		assertTrue(SetSpec.validate(new SetSpec.Draft("S", "oak", many, 3, null)).containsKey("items"));
		assertTrue(SetSpec.validate(new SetSpec.Draft("S", "oak", List.of(), 3, null)).containsKey("items"));
		assertEquals("x".repeat(40), SetSpec.style("x".repeat(50)));
	}
}
