package dev.larattalabs.architect.survival;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.Site;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The site record's construction additions survive a JSON round trip; records without them stay as they were. */
class ConstructionJsonTest {
	static final Anchors.Bounds BOX = new Anchors.Bounds(10, 64, -5, 20, 75, 6);

	static Construction sample() {
		BitSet free = new BitSet();
		free.set(3);
		free.set(70);
		return new Construction(Construction.BUILDING, new int[] {400, 401, 402, 13, 9000}, "s4-123-target.nbt",
			new Construction.Crate(15, 64, 9, "minecraft:grass_block[snowy=false]", null), free, true, "0f0e-uuid");
	}

	@Test
	void roundTrip() {
		Construction c = sample();
		Site s = new Site("s4", "cabin", "clockwise_90", BOX, BOX, Map.of(), 7L, Site.OVERWORLD, new Anchors.Bounds(10, 63, -5, 20, 75, 12),
			"s4-123.nbt", null, new Site.Pin("abcd", List.of(1, 2, 3)), c);
		String json = s.toJson().toString();
		Site back = Site.fromJson(JsonParser.parseString(json).getAsJsonObject());
		assertEquals(s, back);
		assertTrue(back.building());
		assertArrayEquals(c.queue(), back.construction().queue());
		assertEquals(c.free(), back.construction().free());
		// the whole file too
		Site.FileData f = Site.fileFromJson(JsonParser.parseString(Site.fileJson(List.of(s), 5, List.of()).toString()).getAsJsonObject());
		assertEquals(s, f.sites().get(0));
	}

	@Test
	void builtWithoutCrate() {
		Construction c = sample().withState(Construction.BUILT, null).withPaused(false);
		JsonObject o = c.toJson();
		assertFalse(o.has("crate"));
		assertFalse(o.has("paused"));
		Construction back = Construction.fromJson(o);
		assertEquals(c, back);
		assertNull(back.crate());
		assertFalse(back.building());
	}

	@Test
	void crateSnapshotWithNbt() {
		Construction.Crate cr = new Construction.Crate(1, 2, 3, "minecraft:chest[facing=north,type=single,waterlogged=false]", "{Items:[]}");
		assertEquals(cr, Construction.Crate.fromJson(cr.toJson()));
	}

	@Test
	void instantSitesHaveNoConstruction() {
		Site s = new Site("s1", "hut", "none", BOX, BOX, Map.of(), 1L, Site.OVERWORLD, null, "s1-1.nbt", null, null);
		JsonObject o = s.toJson();
		assertFalse(o.has("construction"));
		Site back = Site.fromJson(o);
		assertNull(back.construction());
		assertFalse(back.building());
		assertEquals(s, back);
	}

	@Test
	void badRecordsAreRefused() {
		JsonObject o = sample().toJson();
		o.addProperty("queueSize", 99);
		assertThrows(IllegalArgumentException.class, () -> Construction.fromJson(o));
		JsonObject p = sample().toJson();
		p.addProperty("state", "half");
		assertThrows(IllegalArgumentException.class, () -> Construction.fromJson(p));
	}

	@Test
	void boxIndexes() {
		int dx = 11;
		int dz = 18;
		for (int[] c : new int[][] {{0, 0, 0}, {10, 0, 17}, {3, 7, 9}}) {
			int i = Construction.index(c[0], c[1], c[2], dx, dz);
			assertArrayEquals(c, Construction.offsets(i, dx, dz));
		}
		assertEquals(1, Construction.index(1, 0, 0, dx, dz));
		assertEquals(dx, Construction.index(0, 0, 1, dx, dz));
		assertEquals(dx * dz, Construction.index(0, 1, 0, dx, dz));
	}
}
