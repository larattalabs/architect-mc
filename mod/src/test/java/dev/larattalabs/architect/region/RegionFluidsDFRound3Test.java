package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.site.DurableHooksDF;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice DF round 3, the final check's P1s 3, 4, 5, 6) Failing first on the round 3 seams commit:
 * <ul>
 * <li>#3: a publication in doubt keeps its install trigger across an unrelated OK save of the record;</li>
 * <li>#4: a refused removal never erases the record's earlier debt;</li>
 * <li>#5: a drain leaves a source a player placed (its Placed record) in a body cell;</li>
 * <li>#6: a {@code removal=done} written before the barrier (no {@code barrierDone}) is not trusted: it loads as drained (re-drain, barrier,
 * then done).</li>
 * </ul>
 */
class RegionFluidsDFRound3Test {
	@TempDir
	Path world;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@AfterEach
	void reset() {
		DurableHooksDF.reset();
		RegionStore.failNext = null;
		RegionStore.failSticky = false;
		RegionStore.failInDoubt = false;
		RegionsImpl.RECOVER = Revisions::recoverOne;
		for (String id : List.of("rq1", "rq2", "rq3")) {
			RegionsImpl.dropLive(id);
			RegionsImpl.clearOwed(id);
		}
		RegionFluids.forget(null);
	}

	private RegionsImpl.Live live(String id) {
		JsonObject ir = JsonParser.parseString(RegionFluidsTest.IR).getAsJsonObject();
		RegionRec rec = new RegionRec(id, "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 90, 15}, 1L);
		return new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), world);
	}

	@Test
	void p3InDoubtPublicationKeepsItsInstallTriggerAcrossAnUnrelatedSave() {
		RegionsImpl.Live l = live("rq1");
		RegionsImpl.putLive(l);
		RegionsImpl.publicationInDoubt(l);
		assertTrue(RegionsImpl.save(l), "an unrelated save (a lot's state) is OK");
		List<String> recovered = new ArrayList<>();
		RegionsImpl.RECOVER = (s, x) -> recovered.add(x.rec().id);
		RegionsImpl.retryOwed(null);
		assertEquals(List.of("rq1"), recovered, "the regions tick still runs the held install");
	}

	@Test
	void p4RefusedRemovalKeepsTheEarlierDebt() {
		RegionsImpl.Live l = live("rq2");
		RegionsImpl.putLive(l);
		RegionStore.failNext = "region.json";
		RegionStore.failInDoubt = true;
		assertEquals(false, RegionsImpl.save(l), "the REMOVING save in doubt");
		assertTrue(RegionsImpl.owed("rq2"));
		RegionsImpl.removalRefused(l, RegionState.REMOVING, dev.larattalabs.architect.api.RemovalStop.NONE, null);
		assertTrue(RegionsImpl.owed("rq2"), "a later refused attempt never clears the debt the in-doubt save made");
	}

	@Test
	void p5DrainLeavesASourceAPlayerPlaced() {
		RegionFluids.Body b = new RegionFluids.Body();
		b.id = "q";
		long own = BlockPos.asLong(0, 63, 0), placed = BlockPos.asLong(1, 63, 0);
		b.cells = new long[] {own, placed};
		b.watch = new long[0];
		RegionFluids.Regional st = new RegionFluids.Regional(List.of(b));
		RegionFluids.BodyState bs = st.states.get(b.id);
		bs.state = "settled";
		String air = RegionFluids.stateString(Blocks.AIR.defaultBlockState());
		bs.before.put(own, air);
		bs.before.put(placed, air);
		Map<Long, BlockState> w = new HashMap<>();
		w.put(own, Blocks.WATER.defaultBlockState());
		w.put(placed, Blocks.WATER.defaultBlockState()); // a player's bucket, after the body was drained once
		RegionFluids.drain(new RegionFluids.DrainTarget() {
			@Override
			public BlockState get(BlockPos p) {
				return w.getOrDefault(p.asLong(), Blocks.AIR.defaultBlockState());
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				w.put(p.asLong(), s);
			}

			@Override
			public boolean playerPlaced(BlockPos p) {
				return p.asLong() == placed;
			}
		}, null, st, b, bs, true, new LongOpenHashSet(), RegionFluids.NOT_HELD, true);
		assertEquals(Blocks.AIR.defaultBlockState(), w.get(own), "the body's own source drained");
		assertEquals(Blocks.WATER.defaultBlockState(), w.get(placed), "the player's source stays");
	}

	@Test
	void p6DoneWrittenBeforeTheBarrierIsNotTrusted() throws IOException {
		RegionsImpl.Live l = live("rq3");
		JsonObject old = new JsonObject();
		old.addProperty("phase", "done");
		old.addProperty("removal", "done"); // a record written before round 2's barrier: no barrierDone
		RegionStore.writeJson(RegionStore.region(world, "rq3").resolve("fluids.json"), old);
		RegionFluids.Regional st = new RegionFluids.Regional(RegionFluids.bodiesOf(l.ir().json()));
		RegionFluids.load(l, st);
		assertNotEquals("done", st.removal, "re-drained through the ownership check and the barrier before it is done");
	}
}
