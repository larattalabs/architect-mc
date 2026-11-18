package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.site.DurableHooksDF;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice DF, CONTRACT 8c §4.4, rule 3) fluids.json on T0's DurableFile: save answers whether the record is durably on disk; a REFUSED save
 * (dev.region.failNextSave) and an IN_DOUBT one (renamed, the folder's force failed) leave the record owed, never saved, until a fresh
 * forced write is OK; a loaded file not confirmed (written before DF) is owed; a removal's draining phase is durable and read back. The
 * gate's use of it (no source while owed, FL1r) runs in game: h-df.
 */
class RegionFluidsDurableDFTest {
	@TempDir
	Path world;

	@BeforeEach
	void clean() {
		DurableHooksDF.reset();
	}

	@AfterEach
	void reset() {
		DurableHooksDF.reset();
		RegionStore.failNext = null;
		RegionStore.failSticky = false;
	}

	private RegionsImpl.Live live() {
		JsonObject ir = JsonParser.parseString(RegionFluidsTest.IR).getAsJsonObject();
		RegionRec rec = new RegionRec("rgdf", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 90, 15}, 1L);
		return new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), world);
	}

	private RegionFluids.Regional regional(RegionsImpl.Live l) {
		return new RegionFluids.Regional(RegionFluids.bodiesOf(l.ir().json()));
	}

	private Path file() {
		return RegionStore.region(world, "rgdf").resolve("fluids.json");
	}

	@Test
	void aRefusedSaveIsOwedUntilAWriteIsOk() throws IOException {
		RegionsImpl.Live l = live();
		RegionFluids.Regional st = regional(l);
		st.phase = "writing";
		RegionStore.failNext = "fluids.json";
		RegionStore.failSticky = true;
		assertFalse(RegionFluids.save(l, st), "REFUSED is not saved");
		assertTrue(st.owed);
		assertTrue(st.owedWhy.startsWith("REFUSED"), st.owedWhy);
		assertFalse(RegionFluids.durable(l, st), "still refused: still owed");
		st.owedTriedAt = 0;
		assertFalse(Files.exists(file()), "nothing on disk");
		RegionStore.failNext = null;
		st.owedTriedAt = System.nanoTime();
		assertFalse(RegionFluids.durable(l, st), "a retry within a second of the last waits");
		st.owedTriedAt = 0;
		assertTrue(RegionFluids.durable(l, st), "the retry writes a fresh snapshot");
		assertFalse(st.owed);
		JsonObject on = RegionStore.readJson(file());
		assertEquals("writing", on.get("phase").getAsString());
		assertEquals(RegionFluids.STORE, on.getAsJsonObject(DurableFile.MEMBER).get("type").getAsString());
		assertTrue(on.getAsJsonObject(DurableFile.MEMBER).get("gen").getAsLong() >= 1);
	}

	@Test
	void anInDoubtSaveIsNotSaved() throws IOException {
		RegionsImpl.Live l = live();
		RegionFluids.Regional st = regional(l);
		assertTrue(RegionFluids.save(l, st));
		DurableHooksDF.failFolderForces();
		st.phase = "writing";
		assertFalse(RegionFluids.save(l, st), "IN_DOUBT (renamed, the folder's force failed) is not saved");
		assertTrue(st.owed && st.owedWhy.startsWith("IN_DOUBT"), st.owedWhy);
		assertEquals("writing", RegionStore.readJson(file()).get("phase").getAsString(), "the rename happened: the file may or may not survive");
		assertFalse(RegionFluids.durable(l, st), "the folder still fails: held");
		DurableHooksDF.reset();
		st.owedTriedAt = 0;
		assertTrue(RegionFluids.durable(l, st), "an OK write covers the IN_DOUBT one");
		assertFalse(st.owed);
		assertNull(st.owedWhy);
		assertTrue(st.durable.inDoubt() == 0);
	}

	@Test
	void aLoadedUnconfirmedRecordIsOwedAndTheRemovalsDrainingPhaseReadsBack() throws IOException {
		RegionsImpl.Live l = live();
		JsonObject legacy = new JsonObject();
		legacy.addProperty("phase", "done");
		RegionStore.writeJson(file(), legacy); // a record written before DF: no generation
		RegionFluids.Regional st = regional(l);
		RegionFluids.load(l, st);
		RegionFluids.opened(l, st);
		assertEquals("done", st.phase);
		assertTrue(st.owed, "loaded, not confirmed: written again before the stage goes on");
		assertTrue(RegionFluids.durable(l, st));
		assertEquals(1, DurableFile.readGen(file(), RegionFluids.STORE));
		st.removal = "draining";
		assertTrue(RegionFluids.save(l, st));
		RegionFluids.Regional again = regional(l);
		RegionFluids.load(l, again);
		RegionFluids.opened(l, again);
		assertEquals("draining", again.removal, "a start finds the removal draining: it drains again from the start");
		assertFalse(again.owed, "a confirmed generation is not owed");
	}
}
