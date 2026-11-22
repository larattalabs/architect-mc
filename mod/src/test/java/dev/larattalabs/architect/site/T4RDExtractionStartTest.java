package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R-D, D1c; rows T4RD-p0 / T4RD-p0-window, Steward P3-4) An extraction attempt recorded at P0 (saved {@code planned}, its cells held
 * from that save) whose txn never began (a crash between P0 and the begin: kill point P0b): at the start it is aborted (nothing of it ran,
 * the cells unchanged), its holds released, and the next attempt takes a new generation. Reflective: red on the merged head (no
 * extractions table).
 */
class T4RDExtractionStartTest {
	@Test
	void aPlannedAttemptWithNoTxnIsAbortedAtTheStart() throws Exception {
		System.out.println("ROW T4RD-p0-window (unit)");
		Class<?> ex;
		try {
			ex = Class.forName("dev.larattalabs.architect.site.Extractions");
		} catch (ClassNotFoundException e) {
			ex = null;
		}
		assertNotNull(ex, "T4RD-p0-window: no extraction attempt is recorded (R1 drops the player's blocks as items)");
		Method read = ex.getDeclaredMethod("read", com.google.gson.JsonElement.class);
		Method json = ex.getDeclaredMethod("json");
		Method atStart = ex.getDeclaredMethod("atStart", net.minecraft.server.MinecraftServer.class, java.util.function.Predicate.class,
			java.util.function.Predicate.class);
		Method holds = ex.getDeclaredMethod("holds");
		for (Method m : new Method[] {read, json, atStart, holds}) {
			m.setAccessible(true);
		}
		JsonObject t = JsonParser.parseString("{\"r1@5\":{\"gen\":1,\"attempts\":{\"1\":{\"key\":\"pblocks:r1@5#1\",\"dim\":\"minecraft:overworld\",\"target\":\"r1\","
			+ "\"cells\":[{\"pos\":" + net.minecraft.core.BlockPos.asLong(3, 65, 3) + ",\"block\":\"minecraft:sponge\",\"was\":\"{Name:\\\"minecraft:air\\\"}\","
			+ "\"items\":{\"minecraft:sponge\":1},\"recipient\":\"p\"}],\"state\":\"planned\"}}}}").getAsJsonObject();
		read.invoke(null, t);
		try {
			assertEquals(1, ((java.util.List<?>) holds.invoke(null)).size(), "fixture: its cell is held from P0");
			assertTrue(CrateSettle.stashBoxHeld("minecraft:overworld", 3, 65, 3), "fixture: a player can't change it meanwhile");
			java.util.function.Predicate<String> none = k -> false;
			atStart.invoke(null, null, none, none); // no txn open or committed for it: its intent never became durable
			JsonObject after = (JsonObject) json.invoke(null);
			System.out.println("ROW T4RD-p0-window: after the start: " + after);
			String st = after.getAsJsonObject("r1@5").getAsJsonObject("attempts").getAsJsonObject("1").get("state").getAsString();
			assertEquals("aborted", st, "T4RD-p0-window: a planned attempt with no txn is aborted at the start");
			assertEquals(0, ((java.util.List<?>) holds.invoke(null)).size(), "T4RD-p0-window: its holds released");
			assertTrue(!CrateSettle.stashBoxHeld("minecraft:overworld", 3, 65, 3), "T4RD-p0-window: the cell is free again");
			assertEquals(1, after.getAsJsonObject("r1@5").get("gen").getAsInt(), "its generation stays used: the next attempt takes gen 2");
		} finally {
			read.invoke(null, (Object) null);
		}
	}
}
