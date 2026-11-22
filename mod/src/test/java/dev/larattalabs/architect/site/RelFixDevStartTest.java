package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.WorldJournal;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (REL-v0910 fix round, P2-3; row RELF-dev-start) Ported from the release reviewer's {@code Rel0910DevArmProbe}. World A's dev-start.json arms
 * kill point R4m; A closes before R4m is reached; world B opens with no dev-start.json. Red at 68d2b065: R4m is still armed in B (the start
 * reset cleared DevStart's own fields, never {@code WorldJournal.killAt}; nothing cleared it at the server's stop), so reaching R4m in B halts
 * its JVM; and the hook armed on any start, a player's normal launcher included. The rule now: dev-start.json is read only on a development
 * start (the dev client and the headless server are both development environments, like the DevBridge and the devserver); every fault it
 * armed is disarmed when the server stops, and the next start's reset disarms what the previous start armed (a point armed over the DevBridge
 * for the coming start, as gate4e's migration kills are, is not the previous start's and stays).
 */
class RelFixDevStartTest {
	@TempDir
	Path tmp;

	@AfterEach
	void disarm() throws Exception {
		WorldJournal.killAt(null);
		arm(Files.createDirectories(tmp.resolve("none")), true);
	}

	static Method method(String name, Class<?>... types) {
		try {
			Method m = DevStart.class.getDeclaredMethod(name, types);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			return null;
		}
	}

	/** {@code DevStart.arm(world, development)}: red, no such gate (it armed on every start). */
	static void arm(Path world, boolean dev) throws Exception {
		Method m = method("arm", Path.class, boolean.class);
		assertNotNull(m, "RELF-dev-start: dev-start.json is read only on a development start (DevStart.arm(world, development))");
		m.invoke(null, world, dev);
	}

	static void stopped() throws Exception {
		Method m = method("stopped");
		assertNotNull(m, "RELF-dev-start: the server's stop disarms what dev-start.json armed (DevStart.stopped)");
		m.invoke(null);
	}

	Path world(String name, String json) throws Exception {
		Path w = Files.createDirectories(tmp.resolve(name).resolve("architect")).getParent();
		if (json != null) {
			Files.writeString(w.resolve("architect").resolve("dev-start.json"), json);
		}
		return w;
	}

	@Test
	void anUnreachedStartKillNeverFiresInTheNextWorld() throws Exception {
		System.out.println("ROW RELF-dev-start (unit)");
		Path a = world("a", "{\"killAt\":\"R4m\",\"failWriteNow\":true,\"startGrace\":200}");
		arm(a, true);
		assertEquals("R4m", WorldJournal.armed(), "fixture: world A's start armed R4m");
		assertTrue(DevStart.failWriteNow() && DevStart.startGrace() == 200, "fixture: and its faults");
		// the crash-less path the probe took: B starts with no stop hook between (a stop handler that never ran)
		arm(world("b", null), true);
		System.out.println("ROW RELF-dev-start: next world, no dev-start.json: killAt=" + WorldJournal.armed());
		assertNull(WorldJournal.armed(), "RELF-dev-start: the next start's reset disarms the previous start's unreached kill point");
		assertFalse(DevStart.failWriteNow(), "and its faults");
		// the server's stop disarms everything
		arm(world("c", "{\"killAt\":\"R4m\",\"failWriteNow\":true,\"startGrace\":200}"), true);
		WorldJournal.failNextCommit();
		stopped();
		System.out.println("ROW RELF-dev-start: after the server stopped: killAt=" + WorldJournal.armed());
		assertNull(WorldJournal.armed(), "RELF-dev-start: the stop disarms the start's kill point");
		assertFalse(DevStart.failWriteNow(), "RELF-dev-start: and its faults");
		assertEquals(0, DevStart.startGrace(), "and its start grace");
		java.lang.reflect.Field fn = WorldJournal.class.getDeclaredField("failNext");
		fn.setAccessible(true);
		assertFalse(fn.getBoolean(null), "RELF-dev-start: and a DevBridge-armed commit failure");
		WorldJournal.killAt("K5"); // armed over the DevBridge in the world, never reached
		stopped();
		assertNull(WorldJournal.armed(), "RELF-dev-start: any kill point armed in the world is disarmed when its server stops");
	}

	@Test
	void notOnANormalStartAndAPointArmedForTheComingStartStays() throws Exception {
		Path a = world("a", "{\"killAt\":\"R4m\"}");
		arm(a, false);
		System.out.println("ROW RELF-dev-start: a normal (non-development) start with dev-start.json: killAt=" + WorldJournal.armed());
		assertNull(WorldJournal.armed(), "RELF-dev-start: a normal launcher's start arms nothing");
		assertTrue(Files.exists(a.resolve("architect").resolve("dev-start.json")), "and leaves the file as it is");
		// gate4e: armed over the DevBridge with no world open, for the coming start's migration (it halts in WorldJournal.open, before this reset)
		WorldJournal.killAt("migrate-before-commit");
		arm(world("b", null), true);
		assertEquals("migrate-before-commit", WorldJournal.armed(), "guard: a point armed for the coming start is not the previous start's: it stays");
	}
}
