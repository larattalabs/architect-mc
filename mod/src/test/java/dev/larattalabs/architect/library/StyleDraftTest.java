package dev.larattalabs.architect.library;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BiblePin;
import java.util.List;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * Style unification U3: the Style editor's model. Edit makes a new version of the player's own Style (bibleId, "Save v3"); a copy is a
 * new hand-made one based on its source (any Style, built-in and mod-owned ones too); the main rows fan out as in the design editor;
 * shape hints and slots ride along untouched and read-only; the suggested features stay at most 6.
 */
class StyleDraftTest {
	static Bible bible(String id, boolean builtin, String origin, String owner) {
		return new Bible(id, "Alpine timber", 2, List.of(1, 2), builtin, "building", Palettes.FALLBACK.presetRoles("rustic"), Optional.empty(), Optional
			.empty(), List.of(), Optional.ofNullable(owner), new JsonObject(), 2, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of("cold", "timber"),
			List.of("chimney", "porch"), Optional.of("Spruce under deepslate"), Optional.of(new BiblePin("rustic", 1)), origin);
	}

	static final JsonObject FULL = JsonParser.parseString("""
		{"id": "bib_alpine", "version": 2, "name": "Alpine timber", "scope": "building", "format": 2, "roofLanguage": "steep gables",
		 "proportions": {"storey": 4, "roofPitch": 1.5}, "motifs": ["carved eaves"], "connectors": {"wall": "foundation", "gate": "frame"},
		 "tiers": {"rich": ["accent", "trim"]}, "createdAt": 5, "origin": "hand", "dir": "/x", "prose": "p", "components": ["window"]}
		""").getAsJsonObject();

	@Test
	void editMakesTheNextVersionOfTheSameStyle() {
		StyleDraft d = StyleDraft.edit(bible("bib_alpine", false, "hand", null), FULL, StyleRoles.fallback(), Palettes.FALLBACK);
		assertEquals("Save v3", d.saveLabel());
		assertFalse(d.dirty());
		d.materials().editMain("wood", "birch");
		assertTrue(d.dirty());
		assertEquals("minecraft:birch_log", d.roles().get("frame"));
		assertEquals("follows_wood", d.materials().provenance().get("frame"));
		d.addTag("Steep Roof, cold,  ");
		assertEquals(List.of("cold", "timber", "steep roof"), d.tags());
		JsonObject s = d.saveRequest();
		assertEquals("bib_alpine", s.get("bibleId").getAsString());
		JsonObject b = s.getAsJsonObject("bible");
		assertEquals("Alpine timber", b.get("name").getAsString());
		assertEquals("minecraft:birch_log", b.getAsJsonObject("roles").get("frame").getAsString());
		assertEquals("steep gables", b.get("roofLanguage").getAsString(), "shape hints ride along");
		assertEquals("foundation", b.getAsJsonObject("connectors").get("wall").getAsString(), "slots ride along");
		assertEquals("rustic", b.getAsJsonObject("basedOn").get("id").getAsString(), "an edit keeps what it was based on");
		assertEquals("hand", b.get("origin").getAsString());
		for (String k : List.of("id", "version", "createdAt", "dir", "prose", "components")) {
			assertFalse(b.has(k), "the store's own field " + k + " is not sent");
		}
		assertEquals("building", d.checkRequest().get("scope").getAsString());
	}

	@Test
	void onlyThePlayersOwnCanBeEdited() {
		assertThrows(IllegalArgumentException.class, () -> StyleDraft.edit(bible("rustic", true, "builtin", null), null, StyleRoles.fallback(),
			Palettes.FALLBACK));
		assertThrows(IllegalArgumentException.class, () -> StyleDraft.edit(bible("bib_town", false, "claude", "steward_mc:settlement/a"), null,
			StyleRoles.fallback(), Palettes.FALLBACK));
		// a Claude-made one of the player's is theirs to edit
		StyleDraft.edit(bible("bib_ash", false, "claude", null), null, StyleRoles.fallback(), Palettes.FALLBACK);
	}

	@Test
	void aCopyIsANewStyleBasedOnItsSource() {
		StyleDraft d = StyleDraft.copy(bible("bib_town", false, "claude", "steward_mc:settlement/a"), FULL, null, StyleRoles.fallback(), Palettes.FALLBACK);
		assertEquals("Save style", d.saveLabel());
		assertEquals("Alpine timber copy", d.name());
		JsonObject s = d.saveRequest();
		assertFalse(s.has("bibleId"));
		assertEquals("bib_town", s.getAsJsonObject("bible").getAsJsonObject("basedOn").get("id").getAsString());
		assertEquals(2, s.getAsJsonObject("bible").getAsJsonObject("basedOn").get("version").getAsInt());
		assertNull(d.id());
		assertEquals("Spruce under deepslate", s.getAsJsonObject("bible").get("blurb").getAsString());
	}

	@Test
	void hintsSlotsFeaturesAndErrors() {
		StyleDraft d = StyleDraft.edit(bible("bib_alpine", false, "hand", null), FULL, StyleRoles.fallback(), Palettes.FALLBACK);
		assertEquals(List.of("Roof language: steep gables", "Proportions: storey 4, roofPitch 1.5", "Motifs: carved eaves"), d.shapeHints());
		List<StyleDraft.Slot> slots = d.slots();
		assertEquals(3, slots.size());
		assertEquals(List.of("foundation"), slots.get(0).roles());
		assertEquals(List.of("accent", "trim"), slots.get(2).roles());
		assertTrue(d.errors().isEmpty());
		d.setName("  ");
		assertEquals("a Style needs a name", d.errors().get("name"));
		d.setName("x".repeat(41));
		assertTrue(d.errors().containsKey("name"));
		d.setName("Alpine");
		for (String f : List.of("balcony", "garden", "skylights", "courtyard")) {
			d.toggleFeature(f);
		}
		assertEquals(6, d.features().size());
		assertThrows(IllegalArgumentException.class, () -> d.toggleFeature("basement"));
		d.toggleFeature("porch");
		assertEquals(5, d.features().size());
		assertThrows(IllegalArgumentException.class, () -> d.toggleFeature("moat"));
		assertTrue(d.extraRoles().isEmpty());
		assertTrue(d.settlementRoles().isEmpty());
		for (int i = 0; i < 12; i++) {
			d.addTag("t" + i);
		}
		assertEquals(StyleDraft.MAX_TAGS, d.tags().size());
	}
}
