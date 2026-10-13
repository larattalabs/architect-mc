package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import org.junit.jupiter.api.Test;

/**
 * 6c PT2: the sliced capture's settle rule (3 passes, else SITE_BUSY), a block entity's captured data (no inventory, no position), the
 * captured source's tagged NBT (nested compounds, lists, a mixed list wrapped as vanilla does, longs as decimal strings), the marks.
 */
class AdoptTest {
	@Test
	void settleRule() {
		assertEquals("commit", Adopt.settle(1, 0, Adopt.SYNC_CELLS, Adopt.PASSES), "nothing changed: commit");
		assertEquals("commit", Adopt.settle(1, 50_000, 50_000, 3), "a re-read that fits a tick: commit (the capture then equals a one-tick capture)");
		assertEquals("again", Adopt.settle(1, 50_001, 50_000, 3), "too many changed: another pass");
		assertEquals("again", Adopt.settle(2, 60_000, 50_000, 3));
		assertEquals("busy", Adopt.settle(3, 60_000, 50_000, 3), "past 3 passes: SITE_BUSY");
	}

	@Test
	void capturedDropsInventoriesAndPosition() {
		CompoundTag t = new CompoundTag();
		t.putString("id", "minecraft:chest");
		t.put("Items", new ListTag());
		t.putInt("x", 1);
		t.putInt("y", 2);
		t.putInt("z", 3);
		t.putString("CustomName", "\"Alex\"");
		CompoundTag c = Adopt.captured(t);
		assertFalse(c.contains("Items"));
		assertFalse(c.contains("x"));
		assertEquals("\"Alex\"", c.getStringOr("CustomName", ""));
		assertTrue(t.contains("Items"), "the world's data is not touched");
		assertNull(Adopt.captured(null));
	}

	@Test
	void taggedJson() {
		CompoundTag t = new CompoundTag();
		CompoundTag front = new CompoundTag();
		ListTag msgs = new ListTag();
		msgs.add(StringTag.valueOf("Alex"));
		msgs.add(StringTag.valueOf("home"));
		front.put("messages", msgs);
		t.put("front_text", front);
		t.putLong("stamp", 9007199254740993L);
		ListTag mixed = new ListTag();
		mixed.add(IntTag.valueOf(1));
		mixed.add(StringTag.valueOf("a"));
		t.put("mixed", mixed);
		JsonObject j = Adopt.tagJson(t);
		assertEquals("compound", j.get("t").getAsString());
		JsonObject v = j.getAsJsonObject("v");
		assertEquals("9007199254740993", v.getAsJsonObject("stamp").get("v").getAsString());
		assertEquals("string", v.getAsJsonObject("front_text").getAsJsonObject("v").getAsJsonObject("messages").get("of").getAsString());
		JsonObject mx = v.getAsJsonObject("mixed");
		assertEquals("compound", mx.get("of").getAsString(), "a mixed list's elements are wrapped in compounds");
		assertEquals("int", mx.getAsJsonArray("v").get(0).getAsJsonObject().getAsJsonObject("v").getAsJsonObject("").get("t").getAsString());
	}

	@Test
	void marks() {
		JsonObject j = new JsonObject();
		assertFalse(Adopt.isAdoptedEntry(j));
		j.addProperty("sourceKind", "captured");
		assertTrue(Adopt.isAdoptedEntry(j));
		JsonObject k = new JsonObject();
		k.add("adopted", new JsonObject());
		assertTrue(Adopt.isAdoptedEntry(k));
		assertFalse(Adopt.isAdopted(null));
	}
}
