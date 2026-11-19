package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice 8cTa, failing first: the DF final review's P2 F) Recorded red on a6b14ace (the wait judged on until -1: DONE at once); 8cTb
 * moved the assertion onto its seam (the drain txn that writes the fresh bound) and dropped the -Dred.8cT guard.
 * <ul>
 * <li>A {@code done} saved before the barrier ({@code barrierDone} absent) is re-drained at the start; its solids must still wait a fresh
 * settle bound after that re-drain. On a6b14ace the loader sets {@code until = -1}, so the wait answers at once (DONE, or CAPPED while
 * fluid ticks).</li>
 * </ul>
 */
class RegionFluids8cTaRedTest {
	@TempDir
	Path world;

	@BeforeAll
	static void boot() {
		Boot.boot();
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
		// (8cTb, the seam) the record is drained again in a legacy drain txn, whose W effect writes the fresh bound before any wait: it is
		// untrusted (no drain txn), so the removal's gate begins that drain instead of judging the wait on until -1
		assertEquals(null, st.drainTxn, "a done saved before the barrier carries no trusted drain txn");
		org.junit.jupiter.api.Assertions.assertTrue(RegionFluids.needsDrain(l, st), "the removal drains again (and starts a fresh bound) before it waits");
	}
}
