package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The site record's owner and ext (docs/CONTRACT.md phase 4a, R5): JSON round trip, old files, copies. */
class SiteOwnershipJsonTest {
	private static final Anchors.Bounds BOX = new Anchors.Bounds(0, 64, 0, 8, 70, 8);

	private static Site site() {
		JsonObject ext = new JsonObject();
		ext.addProperty("steward_mc:lot", "L3");
		JsonObject nested = new JsonObject();
		nested.addProperty("n", 2);
		ext.add("steward_mc:data", nested);
		return new Site("s7", "cabin", "none", BOX, BOX, Map.of(), 5L, Site.OVERWORLD, null, "s7-5.nbt", null, null).withOwnership("steward_mc:settlement/set_ab12",
			ext);
	}

	@Test
	void roundTrip() {
		Site s = site();
		JsonObject j = s.toJson();
		assertEquals("steward_mc:settlement/set_ab12", j.get("owner").getAsString());
		assertEquals("L3", j.getAsJsonObject("ext").get("steward_mc:lot").getAsString());
		Site back = Site.fromJson(JsonParser.parseString(j.toString()).getAsJsonObject());
		assertEquals(s, back);
		assertEquals("steward_mc:settlement/set_ab12", back.owner());
		assertEquals(2, back.ext().getAsJsonObject("steward_mc:data").get("n").getAsInt());
		assertTrue(back.owned());
		// through the whole sites file too
		Site.FileData data = Site.fileFromJson(Site.fileJson(List.of(s), 8, List.of(new Site.Pending(s, 9L, "removed"))));
		assertEquals(s, data.sites().get(0));
		assertEquals(s, data.pending().get(0).site());
	}

	@Test
	void oldFilesReadWithoutThem() {
		JsonObject old = new Site("s1", "hut", "none", BOX, BOX, Map.of(), 1L, Site.OVERWORLD, null, "s1-1.nbt", null, null).toJson();
		assertFalse(old.has("owner"));
		assertFalse(old.has("ext"));
		Site back = Site.fromJson(old);
		assertNull(back.owner());
		assertEquals(0, back.ext().size());
		assertFalse(back.owned());
	}

	@Test
	void copiesKeepOwnership() {
		Site s = site();
		assertEquals(s.owner(), s.withPin(new Site.Pin("abc", List.of())).owner());
		assertEquals(s.ext(), s.withConstruction(null).ext());
		// the record never shares its ext
		s.ext().addProperty("x:y", 1);
		assertFalse(s.ext().has("x:y"));
		// a blank owner is no owner
		assertNull(s.withOwnership(" ", null).owner());
	}
}
