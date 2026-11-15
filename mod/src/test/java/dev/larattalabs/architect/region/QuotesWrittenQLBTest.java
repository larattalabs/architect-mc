package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.Map;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (QL-b) A module growth's irrigation shells: the pads write every shell cell first, so the shell's dirt is always paid. Plan.json's
 * survivalTerrainWritten names those items per group; the may-already-stand note leaves them out, so they no longer make the quote inexact.
 */
class QuotesWrittenQLBTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static final JsonObject TILES = JsonParser.parseString("{\"rv1_farm_irr_0_0_shell\":{\"minecraft:dirt\":5},"
		+ "\"rv1_verges\":{\"minecraft:gravel\":54},\"rv1_props\":{\"minecraft:lantern\":1}}").getAsJsonObject();

	@Test
	void shellsWrittenFirstLeaveTheNote() {
		Map<String, Map<String, Integer>> kept = Map.of("rv1_verges", Map.of("minecraft:gravel", 32));
		String before = Quotes.mayAlreadyHold(TILES, kept);
		assertNotNull(before);
		assertTrue(before.contains("rv1_farm_irr_0_0_shell (5 dirt)") && before.contains("rv1_verges (22 gravel)"), before);
		JsonObject written = JsonParser.parseString("{\"rv1_farm_irr_0_0_shell\":{\"minecraft:dirt\":5}}").getAsJsonObject();
		String after = Quotes.mayAlreadyHold(TILES, Quotes.withWritten(kept, written));
		assertNotNull(after, "the verges' 22 unkept gravel still may stand");
		assertTrue(!after.contains("shell") && after.contains("22 paid cell(s)") && after.contains("rv1_verges (22 gravel)"), after);
		// every natural cell kept or written first: exact
		JsonObject all = JsonParser.parseString("{\"rv1_farm_irr_0_0_shell\":{\"minecraft:dirt\":5},\"rv1_verges\":{\"minecraft:gravel\":22}}").getAsJsonObject();
		assertNull(Quotes.mayAlreadyHold(TILES, Quotes.withWritten(kept, all)));
	}

	@Test
	void absentOrEmptyKeepsCovered() {
		Map<String, Map<String, Integer>> kept = Map.of("g", Map.of("minecraft:dirt", 3));
		assertSame(kept, Quotes.withWritten(kept, null));
		assertSame(kept, Quotes.withWritten(kept, new JsonObject()));
		assertEquals(Map.of("g", Map.of("minecraft:dirt", 5)), Quotes.withWritten(kept, JsonParser.parseString("{\"g\":{\"minecraft:dirt\":2}}").getAsJsonObject()));
	}
}
