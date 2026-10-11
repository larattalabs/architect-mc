package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;

/** (6c 0a, CONTRACT 0a §12) Own-time percentiles: {@code own} (wall) and {@code ownCpu} over the ticks with Architect work. */
class MsptTraceTest {
	@Test
	void ownOverTheTicksWithWork() {
		// 200 ticks with work 1..200 ms (CPU = half), 100 without
		int n = 300;
		double[] work = new double[n];
		double[] cpu = new double[n];
		for (int i = 0; i < 200; i++) {
			work[i] = i + 1;
			cpu[i] = (i + 1) / 2.0;
		}
		JsonObject o = MsptTrace.own(work, work, n);
		assertEquals(200, o.get("ticks").getAsInt());
		assertEquals(101, o.get("p50").getAsDouble(), 1e-9); // a[k / 2]
		assertEquals(199, o.get("p99").getAsDouble(), 1e-9); // a[floor(k * 0.99)]
		assertEquals(200, o.get("max").getAsDouble(), 1e-9);
		assertEquals(100.5, o.get("mean").getAsDouble(), 1e-9);
		JsonObject c = MsptTrace.own(cpu, work, n);
		assertEquals(200, c.get("ticks").getAsInt());
		assertEquals(100, c.get("max").getAsDouble(), 1e-9);
		assertEquals(99.5, c.get("p99").getAsDouble(), 1e-9);
		// a tick with work but no CPU figure: no ownCpu
		cpu[5] = -1;
		assertNull(MsptTrace.own(cpu, work, n));
		// no work at all: zeros
		JsonObject none = MsptTrace.own(new double[3], new double[3], 3);
		assertEquals(0, none.get("ticks").getAsInt());
		assertEquals(0, none.get("p99").getAsDouble(), 1e-9);
	}

	@Test
	void stopAnswersOwnAndOwnCpu() {
		MsptTrace.start();
		MsptTrace.tick(30_000_000L, 0, 0); // vanilla only
		MsptTrace.tick(40_000_000L, 10_000_000L, 8_000_000L);
		MsptTrace.tick(60_000_000L, 20_000_000L, 12_000_000L);
		JsonObject s = MsptTrace.stop();
		assertEquals(3, s.get("ticks").getAsInt());
		assertEquals(2, s.getAsJsonObject("own").get("ticks").getAsInt());
		assertEquals(20, s.getAsJsonObject("own").get("max").getAsDouble(), 1e-9);
		assertEquals(12, s.getAsJsonObject("ownCpu").get("max").getAsDouble(), 1e-9);
		assertEquals(10, s.getAsJsonObject("ownCpu").get("mean").getAsDouble(), 1e-9);
		assertEquals(20, s.get("writeMsMax").getAsDouble(), 1e-9, "6a's fields stay");
		assertEquals(60, s.getAsJsonObject("all").get("max").getAsDouble(), 1e-9);
		// a JVM without thread CPU: no ownCpu
		MsptTrace.start();
		MsptTrace.tick(40_000_000L, 10_000_000L, -1);
		JsonObject u = MsptTrace.stop();
		assertTrue(u.has("own"));
		assertFalse(u.has("ownCpu"));
	}
}
