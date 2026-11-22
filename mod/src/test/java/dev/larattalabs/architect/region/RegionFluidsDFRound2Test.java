package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.region.volume.Arvx;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import dev.larattalabs.architect.site.DurableHooksDF;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.GZIPOutputStream;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice DF round 2, the NOT SAFE review's P1s 1, 2, 5, 6, 7 and P2 9) Failing first on the seams commit (today's rules):
 * <ul>
 * <li>#1: a PLACING fluids stage (not APPROVED) starts no item while its record is owed;</li>
 * <li>#2: a loaded {@code removal=done} record that is owed holds the removal (the solids wait);</li>
 * <li>#6: a write step whose save fails stops that tick: no census or escape drain after it; a recheck that leaves the record owed stops
 * the gate;</li>
 * <li>#5: a drain takes back only what the body wrote: a player's waterlogged stair in a source cell and a waterlogged slab in a watched
 * cell stay, block and water;</li>
 * <li>#7: a region record whose save failed stops its drivers until a save is OK;</li>
 * <li>P2 9: a frozen volume already on disk with the right hash is confirmed (forced again), not trusted.</li>
 * </ul>
 */
class RegionFluidsDFRound2Test {
	@TempDir
	Path world;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@BeforeEach
	void clean() {
		DurableHooksDF.reset();
	}

	@AfterEach
	void reset() {
		DurableHooksDF.reset();
		RegionStore.failNext = null;
		RegionStore.failSticky = false;
		RegionStore.failInDoubt = false;
		RegionFluids.forget(null);
	}

	private RegionsImpl.Live live(String id) {
		JsonObject ir = JsonParser.parseString(RegionFluidsTest.IR).getAsJsonObject();
		RegionRec rec = new RegionRec(id, "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 90, 15}, 1L);
		return new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), world);
	}

	/** The record of {@code l}, owed: its save refused (sticky), so every retry fails too. */
	private RegionFluids.Regional owed(RegionsImpl.Live l) {
		RegionFluids.Regional st = RegionFluids.of(l);
		RegionStore.failNext = "fluids.json";
		RegionStore.failSticky = true;
		assertFalse(RegionFluids.save(l, st));
		assertTrue(st.owed);
		st.owedTriedAt = 0;
		return st;
	}

	@Test
	void p1aPlacingFluidsStageStartsNothingWhileItsRecordIsOwed() {
		RegionsImpl.Live l = live("rgr1");
		RegionFluids.Regional st = owed(l);
		st.phase = "writing";
		assertFalse(RegionFluids.stageMayRun(l, RegionFluids.STAGE, false, () -> true), "a PLACING stage (its gate passed before) waits for the record");
		RegionStore.failNext = null;
		st.owedTriedAt = 0;
		assertTrue(RegionFluids.stageMayRun(l, RegionFluids.STAGE, false, () -> true), "once a save is OK it goes on");
		assertTrue(RegionFluids.stageMayRun(l, "ground", false, () -> true), "another stage is not the fluids record's");
	}

	@Test
	void p2aLoadedDoneRemovalHoldsWhileItsRecordIsOwed() {
		RegionsImpl.Live l = live("rgr2");
		RegionFluids.Regional st = owed(l);
		st.removal = "done";
		assertFalse(RegionFluids.removalReady(l, st, () -> true), "the solids wait until the done record is on disk");
	}

	@Test
	void p6aWriteStepWhoseSaveFailsRunsNoCensusThatTick() {
		RegionsImpl.Live l = live("rgr3");
		RegionFluids.Regional st = RegionFluids.of(l);
		boolean[] settled = {false};
		RegionFluids.tickRecord(l, st, () -> true, () -> {
			st.owed = true; // the force's save failed
			st.owedTriedAt = System.nanoTime();
		}, () -> true, () -> settled[0] = true);
		assertFalse(settled[0], "no census (nor its escape drain) after a write step left the record owed");
	}

	@Test
	void p6bRecheckThatLeavesTheRecordOwedStopsTheGate() {
		RegionsImpl.Live l = live("rgr4");
		RegionFluids.Regional st = owed(l);
		st.phase = "writing";
		assertFalse(RegionFluids.afterRecheck(l, st));
	}

	@Test
	void p5DrainTakesBackOnlyWhatTheBodyWrote() {
		Map<Long, BlockState> w = new HashMap<>();
		long src = BlockPos.asLong(0, 63, 0), stair = BlockPos.asLong(1, 63, 0), watch = BlockPos.asLong(2, 63, 0), flow = BlockPos.asLong(3, 63, 0);
		BlockState stairs = Blocks.OAK_STAIRS.defaultBlockState().setValue(StairBlock.WATERLOGGED, true);
		BlockState slab = Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.WATERLOGGED, true);
		w.put(src, Blocks.WATER.defaultBlockState());
		w.put(stair, stairs); // a player's stair placed in a drained body's source cell, waterlogged
		w.put(watch, slab); // and a slab in a watched cell
		w.put(flow, Blocks.WATER.defaultBlockState().setValue(BlockStateProperties.LEVEL, 2)); // the body's own flow in a watched cell
		String air = UmtDrain.stateString(Blocks.AIR.defaultBlockState());
		UmtDrain.drain(new UmtDrain.Cells() {
			@Override
			public BlockState get(BlockPos p) {
				return w.getOrDefault(p.asLong(), Blocks.AIR.defaultBlockState());
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				w.put(p.asLong(), s);
			}
		}, new long[] {src, stair}, new String[] {air, air}, new long[] {watch, flow}, new String[] {air, air}, new long[0]);
		assertEquals(Blocks.AIR.defaultBlockState(), w.get(src), "the body's source drained");
		assertEquals(stairs, w.get(stair), "the player's waterlogged stair stays, block and water");
		assertEquals(slab, w.get(watch), "the waterlogged slab in the watch set stays");
		assertEquals(Blocks.AIR.defaultBlockState(), w.get(flow), "the body's own flow in the watch set drained");
	}

	@Test
	void p7RegionRecordWhoseSaveFailedStopsItsDrivers() {
		RegionsImpl.Live l = live("rgr5");
		RegionStore.failNext = "region.json";
		RegionStore.failSticky = true;
		assertFalse(RegionsImpl.save(l));
		assertFalse(RegionsImpl.mayDrive(l), "the removal, revision and undo drivers wait for the record");
		RegionStore.failNext = null;
		assertTrue(RegionsImpl.save(l));
		assertTrue(RegionsImpl.mayDrive(l));
	}

	@Test
	void p7bInDoubtIsTyped() throws IOException {
		Path f = world.resolve("architect-regions/rgr6/region.json");
		RegionStore.failNext = "region.json";
		RegionStore.failInDoubt = true;
		assertThrows(RegionStore.InDoubt.class, () -> RegionStore.writeJson(f, new JsonObject()), "renamed, then in doubt: typed");
		assertTrue(Files.exists(f), "the new file is on disk");
	}

	@Test
	void p2bFrozenVolumeAlreadyThereIsConfirmedNotTrusted() throws IOException {
		byte[] raw = "volume".getBytes(java.nio.charset.StandardCharsets.UTF_8);
		ByteArrayOutputStream bo = new ByteArrayOutputStream();
		try (GZIPOutputStream g = new GZIPOutputStream(bo)) {
			g.write(raw);
		}
		String sha = Arvx.sha256(raw);
		Path f = world.resolve("vol/" + sha + ".bin");
		DurableHooksDF.failFolderForcesOf(f.getParent());
		assertThrows(IOException.class, () -> VolumeSurvey.freeze(f, bo.toByteArray(), sha), "the first write's folder force fails: in doubt");
		assertTrue(Files.exists(f), "renamed into place");
		assertThrows(IOException.class, () -> VolumeSurvey.freeze(f, bo.toByteArray(), sha), "a retry finding the right hash still forces it: fails while forces fail");
		DurableHooksDF.reset();
		VolumeSurvey.freeze(f, bo.toByteArray(), sha);
	}
}
