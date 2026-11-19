package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice 8cTa, failing first: the DF final review's P2 F) Recorded red on a6b14ace; 8cTb turns it green and drops the guard. Until then it
 * runs only with {@code -Dred.8cT=true}, so the ordinary build stays green.
 * <ul>
 * <li>A {@code done} saved before the barrier ({@code barrierDone} absent) is re-drained at the start; its solids must still wait a fresh
 * settle bound after that re-drain. On a6b14ace the loader sets {@code until = -1}, so the wait answers at once (DONE, or CAPPED while
 * fluid ticks).</li>
 * </ul>
 * 8cTb may move the assertion onto its re-drain seam (where the fresh bound is written); the scenario stays the same.
 */
class RegionFluids8cTaRedTest {
	@TempDir
	Path world;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@BeforeEach
	void red() {
		Assumptions.assumeTrue(Boolean.getBoolean("red.8cT"), "8cTa red record: run with -Dred.8cT=true");
	}

	@AfterEach
	void reset() {
		RegionsImpl.dropLive("rt8f");
		RegionFluids.forget(null);
	}

	@Test
	void f_migratedDoneWaitsAFreshSettleBound() throws IOException {
		JsonObject ir = JsonParser.parseString(RegionFluidsTest.IR).getAsJsonObject();
		RegionRec rec = new RegionRec("rt8f", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 90, 15}, 1L);
		RegionsImpl.Live l = new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), world);
		JsonObject old = new JsonObject();
		old.addProperty("phase", "done");
		old.addProperty("removal", "done"); // written before the barrier: no barrierDone
		RegionStore.writeJson(RegionStore.region(world, "rt8f").resolve("fluids.json"), old);
		RegionFluids.Regional st = new RegionFluids.Regional(RegionFluids.bodiesOf(l.ir().json()));
		RegionFluids.load(l, st);
		long now = 100_000;
		int bound = 200;
		assertEquals(RegionFluids.RemovalWait.WAIT, RegionFluids.removalWait(now, st.until, bound, false),
			"re-drained at the start (until " + st.until + "): the solids wait a fresh settle bound, not DONE at once");
		assertEquals(RegionFluids.RemovalWait.WAIT, RegionFluids.removalWait(now, st.until, bound, true),
			"with fluid still ticking: a fresh wait, never CAPPED at once");
	}
}
