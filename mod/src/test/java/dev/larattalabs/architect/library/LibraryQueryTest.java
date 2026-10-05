package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Blueprint;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The Library tab's cards, filters and sorts. */
class LibraryQueryTest {
	static LibraryCard card(String id, String name, String type, int x, int y, int z, long createdAt, String extra, LibraryMeta meta, boolean bundled) {
		String json = """
			{ "id": "%s", "name": "%s", "type": "%s", "description": "A %s for testing", "tags": ["stone"],
			  "size": {"x": %d, "y": %d, "z": %d}, "source": "%s.mjs", "createdAt": %d %s }
			""".formatted(id, name, type, type, x, y, z, id, createdAt, extra);
		JsonObject o = JsonParser.parseString(json).getAsJsonObject();
		return LibraryCard.of(Blueprint.fromJson(o), o, meta, bundled);
	}

	static final LibraryCard CABIN = card("cabin", "Log Cabin", "cabin", 11, 12, 12, 0, "", new LibraryMeta(true, List.of("cozy"), null), true);
	static final LibraryCard TOWER = card("gen_tower", "Gate Tower", "tower", 11, 30, 11, 300, "", new LibraryMeta(false, List.of("tall", "cozy"),
		"Watch Post"), false);
	static final LibraryCard VARIANT = card("gen_tower_birch", "Gate Tower", "tower", 11, 30, 11, 400, ", \"variantOf\": \"gen_tower\"",
		LibraryMeta.NONE, false);
	static final LibraryCard IMPORTED = card("imp_hut", "Hut", "custom", 5, 5, 5, 200, ", \"imported\": true", LibraryMeta.NONE, false);
	static final List<LibraryCard> ALL = List.of(CABIN, TOWER, VARIANT, IMPORTED);

	static List<String> ids(List<LibraryCard> l) {
		return l.stream().map(LibraryCard::id).toList();
	}

	@Test
	void cardFields() {
		assertEquals("Watch Post", TOWER.name(), "displayName wins");
		assertEquals("Gate Tower", TOWER.baseName());
		assertEquals("VARIANT", VARIANT.badge());
		assertEquals("IMPORTED", IMPORTED.badge());
		assertNull(CABIN.badge());
		assertFalse(IMPORTED.canVariant(), "imported entries have no source to re-run");
		assertTrue(VARIANT.canVariant());
		assertEquals("variant of Gate Tower", VARIANT.provenance(id -> id.equals("gen_tower") ? "Gate Tower" : id));
		assertEquals("bundled with Architect", CABIN.provenance(id -> id));
	}

	@Test
	void sorts() {
		assertEquals(List.of("gen_tower_birch", "gen_tower", "imp_hut", "cabin"), ids(LibraryQuery.ALL.apply(ALL)));
		assertEquals(List.of("gen_tower_birch", "imp_hut", "cabin", "gen_tower"), ids(LibraryQuery.ALL.withSort(LibraryQuery.Sort.NAME).apply(ALL)),
			"by the shown name: Gate Tower, Hut, Log Cabin, Watch Post");
		assertEquals(List.of("imp_hut", "cabin", "gen_tower", "gen_tower_birch"), ids(LibraryQuery.ALL.withSort(LibraryQuery.Sort.SIZE).apply(ALL)),
			"by volume, ties by id");
	}

	@Test
	void filters() {
		assertEquals(List.of("gen_tower_birch", "gen_tower"), ids(LibraryQuery.ALL.withType("tower").apply(ALL)));
		assertEquals(List.of("gen_tower", "cabin"), ids(LibraryQuery.ALL.withTag("cozy").apply(ALL)));
		assertEquals(List.of("cabin"), ids(LibraryQuery.ALL.withFavoritesOnly(true).apply(ALL)));
		assertEquals(List.of("gen_tower"), ids(LibraryQuery.ALL.withText("watch").apply(ALL)), "display name");
		assertEquals(List.of("gen_tower_birch", "gen_tower"), ids(LibraryQuery.ALL.withText("GATE tow").apply(ALL)), "all words, any case");
		assertEquals(List.of("imp_hut"), ids(LibraryQuery.ALL.withText("custom for").apply(ALL)), "description");
		assertEquals(List.of("gen_tower"), ids(LibraryQuery.ALL.withText("tall").apply(ALL)), "user tags");
		assertEquals(4, LibraryQuery.ALL.withText("stone").apply(ALL).size(), "design tags");
		assertEquals(List.of("gen_tower"), ids(LibraryQuery.ALL.withType("tower").withTag("cozy").apply(ALL)), "filters combine");
		assertEquals(List.of(), LibraryQuery.ALL.withType("barn").apply(ALL));
		assertTrue(LibraryQuery.ALL.withText(" x ").filtered());
		assertFalse(LibraryQuery.ALL.withText("").filtered());
	}

	@Test
	void facetLists() {
		assertEquals(List.of("cabin", "custom", "tower"), LibraryQuery.types(ALL));
		assertEquals(List.of("cozy", "tall"), LibraryQuery.userTags(ALL));
		assertEquals(LibraryQuery.Sort.SIZE, LibraryQuery.Sort.of("Size"));
		assertNull(LibraryQuery.Sort.of("nope"));
	}
}
