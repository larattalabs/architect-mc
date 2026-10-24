package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.Bibles;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.StyleCatalog;
import dev.larattalabs.architect.library.StyleForm;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;

/**
 * Style unification U5: a Style's own parts ({@link Bible#parts}, additive, the 1.41.0 constructor kept), the wire's {@code parts} and
 * its fallback for an older helper or bible.json, "Use this style's parts" in the Style form (on for a Claude-made Style, off for any
 * other; set mode only with the Style's own materials), the browser's parts line, and the additive {@link Bibles} methods.
 */
class ApiStyleU5Test {
	static final List<String> REQ = List.of("window", "door_surround", "lantern_post", "roof_trim", "chimney");

	static Bible style(String origin, boolean builtin, List<String> parts) {
		return new Bible("bib_" + origin, "X", 2, List.of(1, 2), builtin, "building", ApiStyleU1Test.ROLES, Optional.empty(), Optional.empty(), REQ, Optional
			.empty(), new JsonObject(), 2, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of(), List.of(), Optional.empty(), Optional.empty(), origin,
			parts);
	}

	@Test
	void theEarlierConstructorsStayAndGiveTheRightParts() throws Exception {
		Class<?> s = String.class;
		Class<?> l = List.class;
		Class<?> op = Optional.class;
		// 1.41.0's 21 arguments (U1) stay beside the new canonical one
		assertNotNull(Bible.class.getConstructor(s, s, int.class, l, boolean.class, s, Map.class, op, op, l, op, JsonObject.class, int.class,
			Bible.Restraint.class, boolean.class, op, l, l, op, op, s));
		assertNotNull(Bible.class.getConstructor(s, s, int.class, l, boolean.class, s, Map.class, op, op, l, op, JsonObject.class, int.class,
			Bible.Restraint.class, boolean.class, op, l, l, op, op, s, l));
		// the 1.41.0 one: a Claude-made bible's parts are its components; a built-in or hand-made Style has none
		assertEquals(List.of(), ApiStyleU1Test.medieval().parts());
		Bible claude = new Bible("bib_c", "C", 1, List.of(1), false, "building", ApiStyleU1Test.ROLES, Optional.empty(), Optional.empty(), REQ, Optional
			.empty(), new JsonObject(), 2, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of(), List.of(), Optional.empty(), Optional.empty(),
			"claude");
		assertEquals(REQ, claude.parts());
		assertTrue(claude.hasParts());
		Bible hand = new Bible("bib_h", "H", 1, List.of(1), false, "building", ApiStyleU1Test.ROLES, Optional.empty(), Optional.empty(), REQ, Optional
			.empty(), new JsonObject(), 2, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of(), List.of(), Optional.empty(), Optional.empty(), "hand");
		assertFalse(hand.hasParts());
		// 1.2.0's: an installed bible (a bible job's)
		assertEquals(REQ, new Bible("bib_o", "O", 1, List.of(1), false, "building", ApiStyleU1Test.ROLES, Optional.empty(), Optional.empty(), REQ, Optional
			.empty(), new JsonObject()).parts());
	}

	@Test
	void theWireCarriesPartsAndFallsBackForOlderOnes() {
		JsonObject sent = JsonParser.parseString("{\"id\":\"medieval\",\"name\":\"Medieval\",\"version\":1,\"builtin\":true,\"roles\":{},\"components\":[],"
			+ "\"parts\":[],\"origin\":\"builtin\"}").getAsJsonObject();
		assertEquals(List.of(), Wire4b.bibleInfo(sent).parts());
		JsonObject rustic = JsonParser.parseString("{\"id\":\"rustic\",\"name\":\"Rustic\",\"version\":1,\"builtin\":true,\"roles\":{},\"components\":"
			+ "[\"window\"],\"parts\":[\"window\"],\"origin\":\"builtin\"}").getAsJsonObject();
		assertEquals(List.of("window"), Wire4b.bibleInfo(rustic).parts());
		// an older helper (no parts): a built-in has none, a bible job's are its components, a hand-made Style has none
		JsonObject oldBuiltin = JsonParser.parseString("{\"id\":\"oak\",\"name\":\"Oak\",\"version\":1,\"builtin\":true,\"roles\":{},\"components\":"
			+ "[\"window\",\"door_surround\",\"lantern_post\",\"roof_trim\",\"chimney\"]}").getAsJsonObject();
		assertEquals(List.of(), Wire4b.bibleInfo(oldBuiltin).parts());
		JsonObject oldJob = JsonParser.parseString("{\"id\":\"bib_a\",\"name\":\"A\",\"version\":3,\"roles\":{}}").getAsJsonObject();
		assertEquals(REQ, Wire4b.bibleInfo(oldJob).parts());
		JsonObject handSave = JsonParser.parseString("{\"id\":\"bib_h\",\"name\":\"H\",\"version\":1,\"roles\":{},\"origin\":\"hand\",\"components\":"
			+ "[\"window\",\"door_surround\",\"lantern_post\",\"roof_trim\",\"chimney\"]}").getAsJsonObject();
		assertEquals(List.of(), Wire4b.bibleInfo(handSave).parts());
		// parts added to a hand-made Style (bible.json since U5)
		handSave.add("parts", JsonParser.parseString("[\"window\",\"chimney\"]"));
		assertEquals(List.of("window", "chimney"), Wire4b.bibleInfo(handSave).parts());
	}

	@Test
	void usePartsInTheStyleForm() {
		// a Claude-made Style with parts: on when picked (set mode, as before U5)
		StyleForm f = new StyleForm(StyleForm.Mode.NEW, null, List.of());
		f.pick(StyleForm.Style.of(style("claude", false, REQ)));
		assertTrue(f.partsOffered() && f.partsOn());
		assertEquals("bib_claude", f.request().get("bible").getAsString());
		assertEquals(2, f.request().get("bibleVersion").getAsInt());
		assertFalse(f.request().has("palette"));
		// a custom mix: the materials only (the parts read the Style's own roles)
		f.editMain("wood", "oak");
		assertFalse(f.partsOn());
		assertTrue(f.request().has("palette"));
		f.revert();
		assertTrue(f.partsOn());
		// a hand-made Style with parts added: off when picked (the hybrid default), on when asked
		f.pick(StyleForm.Style.of(style("hand", false, REQ)));
		assertTrue(f.partsOffered());
		assertFalse(f.partsOn());
		assertTrue(f.request().has("palette"));
		f.useParts(true);
		assertTrue(f.partsOn());
		// a Style without parts: no toggle
		f.pick(StyleForm.Style.preset(Palettes.FALLBACK, "medieval"));
		assertFalse(f.partsOffered());
		assertThrows(IllegalStateException.class, () -> f.useParts(true));
		assertEquals("minecraft:white_concrete", f.request().getAsJsonObject("palette").getAsJsonObject("bible").getAsJsonObject("roles").get("wall")
			.getAsString(), "medieval's wall moved off white_terracotta");
		// a variant: never
		StyleForm v = new StyleForm(StyleForm.Mode.VARIANT, StyleForm.Style.of(style("claude", false, REQ)), List.of());
		assertFalse(v.partsOffered());
		assertThrows(IllegalStateException.class, () -> v.useParts(true));
	}

	@Test
	void theBrowserSaysWhetherAStyleHasParts() {
		assertEquals("Parts: 5", StyleCatalog.partsLine(style("claude", false, REQ)));
		assertEquals("No parts · Add parts… (+ New style)", StyleCatalog.partsLine(style("hand", false, List.of())));
		assertEquals("No parts · Add parts… (+ New style): on your copy", StyleCatalog.partsLine(ApiStyleU1Test.medieval()));
		Bible town = new Bible("bib_t", "T", 1, List.of(1), false, "building", ApiStyleU1Test.ROLES, Optional.empty(), Optional.empty(), REQ, Optional.of(
			"steward_mc:settlement/a"), new JsonObject(), 2, Bible.Restraint.DEFAULT, false, Optional.empty(), List.of(), List.of(), Optional.empty(),
			Optional.empty(), "hand", List.of());
		assertEquals("No parts (only its owner adds them)", StyleCatalog.partsLine(town));
		assertFalse(StyleCatalog.cards(List.of(town), Map.of(), null, id -> null).get(0).canAddParts());
	}

	@Test
	void theNewBiblesMethodsAreDefaults() throws Exception {
		assertTrue(Bibles.class.getMethod("addParts", String.class, Integer.class, String.class).isDefault());
		assertTrue(Bibles.class.getMethod("estimateParts").isDefault());
		assertTrue(Bible.class.getMethod("hasParts") != null);
	}
}
