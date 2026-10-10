package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * (6c 0a, CONTRACT 0a §11) Slow tiles: a {@code region.tile.error code: "timeout"} puts the tile in WAITING (TILE_SLOW) and it is asked
 * again after 30 s, 60 s, 120 s, then every 5 min; RETRY asks now; any other error (or none, an older helper) fails it as before.
 */
class TileStreamSlowTest {
	final AtomicLong now = new AtomicLong(1_000_000L);
	TileStreamBlobTest.Script link;

	@BeforeEach
	void setUp() {
		link = new TileStreamBlobTest.Script();
		TileStream.setLink(link);
		TileStream.CLOCK = now::get;
	}

	@AfterEach
	void clean() {
		TileStream.forgetRegion(null);
		TileStream.setLink(null);
		TileStream.CLOCK = System::currentTimeMillis;
	}

	static TileStream.Tile request(String key) {
		JsonObject ir = new JsonObject();
		TileStream.request("rg1", "p1", "irsha", x -> ir, "ground", "terrain", key, new byte[] {1});
		return TileStream.get("rg1", "ground", "terrain", key);
	}

	static void error(String key, String code, int attempts) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.tile.error");
		m.addProperty("planId", "p1");
		m.addProperty("key", key);
		m.addProperty("stage", "ground");
		m.addProperty("set", "terrain");
		m.addProperty("message", "the tile took longer than its limit");
		if (code != null) {
			m.addProperty("code", code);
		}
		if (attempts > 0) {
			m.addProperty("attempts", attempts);
		}
		TileStream.onMessage(m);
	}

	@Test
	void theSchedule() {
		assertEquals(30_000L, TileStream.slowDelayMs(1));
		assertEquals(60_000L, TileStream.slowDelayMs(2));
		assertEquals(120_000L, TileStream.slowDelayMs(3));
		for (int r = 4; r < 20; r++) {
			assertEquals(300_000L, TileStream.slowDelayMs(r), "every 5 min after the third");
		}
	}

	@Test
	void aTimeoutWaitsAndIsAskedAgainOnSchedule() {
		TileStream.Tile t = request("0,0");
		error("0,0", "timeout", 4);
		assertEquals(TileStream.Phase.WAITING, t.phase);
		assertTrue(t.slow);
		assertEquals(1, t.slowRound);
		assertTrue(t.error.contains("all 4 attempts"), t.error);
		assertEquals(0, TileStream.outstanding("rg1"), "a slow tile waiting holds no window slot");
		// before 30 s: still waiting
		now.addAndGet(29_999);
		assertSame(t, TileStream.get("rg1", "ground", "terrain", "0,0"));
		// at 30 s: dropped, so the caller asks again
		now.addAndGet(1);
		assertNull(TileStream.get("rg1", "ground", "terrain", "0,0"));
		long[] expect = {60_000, 120_000, 300_000, 300_000};
		for (int i = 0; i < expect.length; i++) {
			TileStream.Tile again = request("0,0");
			assertEquals(TileStream.Phase.REQUESTED, again.phase);
			assertEquals(1, TileStream.outstanding("rg1"), "asked again: it holds a slot");
			error("0,0", "timeout", 4);
			assertEquals(i + 2, again.slowRound);
			now.addAndGet(expect[i] - 1);
			assertNotNull(TileStream.get("rg1", "ground", "terrain", "0,0"), "round " + (i + 2) + " waits " + expect[i] + " ms");
			now.addAndGet(1);
			assertNull(TileStream.get("rg1", "ground", "terrain", "0,0"));
		}
	}

	@Test
	void retryAsksNowAndTheScheduleGoesOn() {
		request("0,0");
		error("0,0", "timeout", 4);
		assertEquals(1, TileStream.retryWaiting("rg1"));
		assertNull(TileStream.get("rg1", "ground", "terrain", "0,0"), "RETRY: asked again now");
		TileStream.Tile again = request("0,0");
		error("0,0", "timeout", 4);
		assertEquals(2, again.slowRound, "the count goes on after a RETRY");
		now.addAndGet(59_999);
		assertNotNull(TileStream.get("rg1", "ground", "terrain", "0,0"));
	}

	@Test
	void anErrorOrAnOlderHelperFailsTheTile() {
		TileStream.Tile a = request("1,0");
		error("1,0", "error", 1);
		assertEquals(TileStream.Phase.FAILED, a.phase);
		assertFalse(a.slow);
		TileStream.Tile b = request("2,0");
		error("2,0", null, 0); // no code: a helper before 0a
		assertEquals(TileStream.Phase.FAILED, b.phase);
		assertFalse(b.slow);
		assertEquals(0, TileStream.slowRound("rg1", "ground", "terrain", "2,0"));
	}

	@Test
	void releaseAndForgetClearTheCount() {
		request("0,0");
		error("0,0", "timeout", 4);
		assertEquals(1, TileStream.slowRound("rg1", "ground", "terrain", "0,0"));
		TileStream.release("rg1", "ground", "terrain", "0,0");
		assertEquals(0, TileStream.slowRound("rg1", "ground", "terrain", "0,0"));
		request("3,0");
		error("3,0", "timeout", 4);
		TileStream.forgetRegion("rg1");
		assertEquals(0, TileStream.slowRound("rg1", "ground", "terrain", "3,0"));
	}

	@Test
	void slowDueIsPure() {
		TileStream.Tile t = request("4,0");
		assertFalse(TileStream.slowDue(t, Long.MAX_VALUE), "a requested tile is never due");
		error("4,0", "timeout", 4);
		assertFalse(TileStream.slowDue(t, t.askAgainAt - 1));
		assertTrue(TileStream.slowDue(t, t.askAgainAt));
	}
}
