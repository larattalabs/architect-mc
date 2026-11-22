package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T4R-D last round, P2; row T4RDL-kill-marker) A kill point armed for a world's start by dev-start.json leaves durable proof that it
 * fired: right before the halt, {@code <world>/architect/dev-killed.json} names the armed point. The gate's second-crash predicate
 * (tools/lib/second-crash.mjs) requires that marker. Red at ae97e9da: nothing recorded where the start halted, so a start that failed before
 * the barrier (dev-start.json already consumed) left the same disk state as one that reached it.
 */
class T4RDLKillMarkerTest {
	static final String POINT = "TX:recover:removal.site:barrier:member";

	@TempDir
	Path world;

	@AfterEach
	void disarm() throws Exception {
		dev.larattalabs.architect.journal.WorldJournal.killAt(null);
		Path empty = Files.createTempDirectory("t4rdl-km-empty");
		DevStart.arm(empty); // no dev-start.json: nothing armed for the start
		Files.deleteIfExists(empty);
	}

	static Method marker() {
		Method m = null;
		try {
			m = DevStart.class.getDeclaredMethod("markKilled", String.class);
			m.setAccessible(true);
		} catch (NoSuchMethodException e) {
			// red: a start-armed kill left no trace of where it halted
		}
		assertNotNull(m, "T4RDL-kill-marker: a start-armed kill records where it halted (DevStart.markKilled)");
		return m;
	}

	@Test
	void aStartArmedKillWritesItsMarkerOnlyForItsOwnPoint() throws Exception {
		System.out.println("ROW T4RDL-kill-marker (unit)");
		Method m = marker();
		Path arch = Files.createDirectories(world.resolve("architect"));
		Path f = arch.resolve("dev-killed.json");
		Files.writeString(arch.resolve("dev-start.json"), "{\"killAt\": \"" + POINT + "\"}", StandardCharsets.UTF_8);
		DevStart.arm(world);
		assertFalse(Files.exists(arch.resolve("dev-start.json")), "dev-start.json consumed at the start");
		m.invoke(null, "TX:removal.site:apply:1+save");
		assertFalse(Files.exists(f), "T4RDL-kill-marker: another point (the first crash's, armed over the DevBridge) writes no start marker");
		m.invoke(null, POINT);
		assertTrue(Files.exists(f), "T4RDL-kill-marker: the start-armed point writes its marker before the halt");
		String point = JsonParser.parseString(Files.readString(f)).getAsJsonObject().get("point").getAsString();
		System.out.println("ROW T4RDL-kill-marker: " + Files.readString(f));
		assertEquals(POINT, point, "T4RDL-kill-marker: the marker names the point that fired");
		Files.delete(f);
		Path other = Files.createTempDirectory("t4rdl-km-none");
		DevStart.arm(other); // the next start, no dev-start.json
		m.invoke(null, POINT);
		assertFalse(Files.exists(f), "a start without dev-start.json writes no marker");
		assertFalse(Files.exists(other.resolve("architect").resolve("dev-killed.json")), "anywhere");
		Files.deleteIfExists(other);
	}

	@Test
	void everyHaltInWorldJournalKillWritesTheMarkerFirst() throws Exception {
		String src = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/journal/WorldJournal.java"));
		int a = src.indexOf("public static void kill(String point)");
		int b = src.indexOf("\n\t}\n", a);
		assertTrue(a > 0 && b > a, "WorldJournal.kill");
		String body = src.substring(a, b);
		int halts = 0;
		for (int i = body.indexOf("Runtime.getRuntime().halt("); i >= 0; i = body.indexOf("Runtime.getRuntime().halt(", i + 1)) {
			halts++;
			String before = body.substring(0, i);
			int mark = before.lastIndexOf("DevStart.markKilled(");
			int prevHalt = before.lastIndexOf("Runtime.getRuntime().halt(");
			assertTrue(mark > prevHalt, "T4RDL-kill-marker: halt #" + halts + " in WorldJournal.kill is preceded by its marker");
		}
		assertEquals(2, halts, "both halts (plain and +save)");
		String js = Files.readString(Path.of("../tools/lib/second-crash.mjs"));
		assertTrue(js.contains("'dev-killed.json'"), "the gate reads the same file name (tools/lib/second-crash.mjs KILL_MARKER)");
	}
}
