package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * 6c Y1: {@code stockpiles.json} keys each stockpile by its own id (the owner is an attribute). A file without ids (a pre-release
 * Y1 build) loads, every stockpile gets an id, and no id is ever handed out twice (also past the file's {@code nextId}).
 */
class StockpileFileTest {
	static JsonObject file(String json) {
		return JsonParser.parseString(json).getAsJsonObject();
	}

	@Test
	void anIdlessFileLoadsGetsIdsAndNeverReusesOne() {
		Stockpiles.readInto(file("""
			{"format":1,"stockpiles":[
			 {"owner":"test:a","dimension":"minecraft:overworld","crates":[],"ledger":{"delivered":{"minecraft:cobblestone":5}}},
			 {"owner":"test:b","dimension":"minecraft:overworld","crates":[]}]}"""));
		Stockpiles.Pile a = Stockpiles.get("test:a");
		Stockpiles.Pile b = Stockpiles.get("test:b");
		assertNotNull(a);
		assertNotNull(b);
		assertTrue(a.id().matches("sp\\d+") && b.id().matches("sp\\d+"), a.id() + " " + b.id());
		assertNotEquals(a.id(), b.id());
		assertEquals(5, a.ledger().stock("minecraft:cobblestone"), "the ledger survives");
		assertEquals(a, Stockpiles.byId(a.id()));
		Set<String> taken = new HashSet<>(Set.of(a.id(), b.id()));
		assertTrue(!taken.contains(Stockpiles.peekNextId()), "the next id is a new one");
		// written back and read again: the same ids
		JsonObject again = Stockpiles.toJson();
		Stockpiles.readInto(again);
		assertEquals(a.id(), Stockpiles.get("test:a").id());
		assertEquals(b.id(), Stockpiles.get("test:b").id());
	}

	@Test
	void idsInTheFileAreNeverHandedOutAgain() {
		// nextId says 2, but sp7 is taken: the next is sp8; an id-less entry gets sp8 and the next is sp9
		Stockpiles.readInto(file("""
			{"format":1,"nextId":2,"stockpiles":[
			 {"id":"sp7","owner":"test:a","dimension":"minecraft:overworld","crates":[]},
			 {"owner":"test:b","dimension":"minecraft:overworld","crates":[]}]}"""));
		assertEquals("sp7", Stockpiles.get("test:a").id());
		assertEquals("sp8", Stockpiles.get("test:b").id());
		assertEquals("sp9", Stockpiles.peekNextId());
	}
}
