package dev.larattalabs.architect.design;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The phase 4c UI rules: Massing first's default, the Approve request, the review ghost's spot, a set's row, the set dialog's fields. */
class MassingRulesTest {
	@Test
	void massingFirstDefault() {
		assertTrue(MassingRules.massingFirstByDefault("L"));
		assertTrue(MassingRules.massingFirstByDefault("plot"));
		assertFalse(MassingRules.massingFirstByDefault("M"));
		assertFalse(MassingRules.massingFirstByDefault("S"));
		assertFalse(MassingRules.massingFirstByDefault("custom"));
		assertFalse(MassingRules.massingFirstByDefault(null));
	}

	@Test
	void detailRequest() {
		JsonObject m = JsonParser.parseString("""
			{"type":"tavern","style":"rustic","features":["porch"],"maxSize":{"x":21,"y":20,"z":21},"name":"Tankard","notes":"by the river",
			 "massing":true,"model":"claude-sonnet-5-5","redirect":{"fromVersion":1,"notes":"taller"},"bible":"oak","bibleVersion":1,
			 "context":"river bend"}""").getAsJsonObject();
		JsonObject d = MassingRules.detailRequest(m, "mas_tankard", 2);
		assertEquals("mas_tankard", d.get("fromMassing").getAsString());
		assertEquals(2, d.get("massingVersion").getAsInt());
		for (String gone : List.of("massing", "model", "redirect", "bibleVersion")) {
			assertFalse(d.has(gone), gone + " is the massing's (the detail pass keeps the design model and inherits the bible pin)");
		}
		for (String kept : List.of("type", "style", "features", "maxSize", "name", "notes", "bible", "context")) {
			assertTrue(d.has(kept), kept);
		}
		assertTrue(m.has("massing"), "the massing's own request is not changed");
	}

	@Test
	void rowAcrossTheView() {
		// two 10x8 boxes (front south), the player at 0,64,0 looking north: entrances face south (the player), the row runs along x
		var boxes = List.of(new MassingRules.Box(10, 8, 1, "south"), new MassingRules.Box(6, 6, 1, "south"));
		List<int[]> at = MassingRules.row(0, 64, 0, "north", boxes, 2);
		assertEquals(0, at.get(0)[3], "already facing the player");
		assertEquals(63, at.get(0)[1], "the ground row on the spot");
		// left to right for a player looking north is -x to +x; centred: total 10 + 4 + 6 = 20
		assertEquals(-10, at.get(0)[0]);
		assertEquals(4, at.get(1)[0]);
		assertTrue(at.get(0)[0] + 10 + MassingRules.ROW_GAP <= at.get(1)[0], "no overlap");
		// the near edge is 2 ahead (north = -z): the box ends at z -2
		assertEquals(-2 - 8 + 1, at.get(0)[2]);
		// looking east: the row runs along z, left (north, -z) to right (+z); a south-front box turns to face west
		List<int[]> east = MassingRules.row(0, 64, 0, "east", boxes, 2);
		assertEquals(BlueprintTransform.turnsToFace("south", "west"), east.get(0)[3]);
		assertTrue(east.get(0)[2] < east.get(1)[2]);
		assertEquals(2, east.get(0)[0], "2 ahead along +x");
		// looking south: left is +x
		List<int[]> south = MassingRules.row(0, 64, 0, "south", boxes, 2);
		assertTrue(south.get(0)[0] > south.get(1)[0]);
	}

	@Test
	void setDialog4c() {
		var items = List.of(new SetSpec.Item("tower", "Watch", true, null), new SetSpec.Item("house", null, false, null));
		SetSpec.Draft d = new SetSpec.Draft("Hamlet", "oak", items, 3, null, true, 2, "  a river bend, street to the south  ");
		assertTrue(SetSpec.validate(d).isEmpty());
		JsonObject g = SetSpec.groupJson(d, "Oak");
		assertTrue(g.get("massingFirst").getAsBoolean());
		assertEquals(2, g.get("maxRedirects").getAsInt());
		assertEquals("a river bend, street to the south", g.get("context").getAsString());
		assertFalse(g.has("approvalUi"), "Architect's own UI approves: the default");
		JsonObject plain = SetSpec.groupJson(new SetSpec.Draft("Hamlet", "oak", items, 3, null), "Oak");
		assertFalse(plain.has("massingFirst") || plain.has("maxRedirects") || plain.has("context"), "the 4b shape");
		Map<String, String> e = SetSpec.validate(new SetSpec.Draft("Hamlet", "oak", items, 3, null, true, 11, "x".repeat(4001)));
		assertTrue(e.containsKey("redirects"));
		assertTrue(e.containsKey("context"));
	}
}
