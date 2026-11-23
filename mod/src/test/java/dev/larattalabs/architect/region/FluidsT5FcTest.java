package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TxnEntry;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** (T5Fc, §4.3-§4.6) The removal drain per (body, chunk), its receipts, the scoop's sum, the deadline, the marks, on MemFluidWorld. */
class FluidsT5FcTest {
	@TempDir
	Path world;
	RegionsImpl.Live l;
	RegionFluids.Regional st;
	MemFluidWorld w;
	String rec;
	BlockState LAVA, AIR;
	static final long PIT_A = FluidsT5FFixTest.PIT_A, PIT_B = FluidsT5FFixTest.PIT_B;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@BeforeEach
	void setUp() {
		LAVA = Blocks.LAVA.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
		JsonObject ir = JsonParser.parseString(FluidsT5FFixTest.IR).getAsJsonObject();
		RegionRec r = new RegionRec("t5fx", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 40, 0, 31, 90, 31}, 1L);
		r.survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}").getAsJsonObject();
		l = new RegionsImpl.Live(r, Ir.lenient(ir, r.claim), world);
		RegionsImpl.putLive(l);
		st = RegionFluids.of(l);
		w = new MemFluidWorld();
		FluidTxns.testWorld = e -> w;
		rec = FluidTxns.recKey(l);
		RegionFluids.BodyState bs = st.states.get("pit");
		bs.before.put(PIT_A, "minecraft:air");
		bs.before.put(PIT_B, "minecraft:air");
		bs.state = "settled";
		// A delivered and standing; B delivered and taken by a player
		w.put(PIT_A, LAVA);
		mark(PIT_A);
		mark(PIT_B);
	}

	@AfterEach
	void tearDown() {
		FluidTxns.testWorld = null;
		RegionsImpl.dropLive("t5fx");
		RegionFluids.forget(null);
	}

	void mark(long p) {
		var m = w.marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec);
		m.put(w.index(p), FluidProv.Mark.WROTE);
		w.putMarks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec, m);
	}

	JsonObject data(long ck) {
		JsonObject d = new FluidsT5FFixTest().data((int) (ck >> 32), (int) ck, "pit");
		d.addProperty("flowing", 0);
		return d;
	}

	TxnEntry drainEntry() {
		List<JsonObject> es = new ArrayList<>();
		int i = 0;
		for (long ck : RegionFluids.drainChunksOf(st, st.body("pit"))) {
			es.add(FluidsT5FFixTest.eff(i++, "fluid.drain", "W", data(ck)));
		}
		JsonObject r = new JsonObject();
		r.addProperty("region", "t5fx");
		r.addProperty("rid", 0);
		r.addProperty("flowing", 0);
		r.addProperty("bound", 80);
		r.addProperty("v", 2);
		es.add(FluidsT5FFixTest.eff(i, "fluid.drained", "R", r));
		return FluidsT5FFixTest.entry("tx-31", FluidTxns.DRAIN, es);
	}

	@Test
	void theDrainCountsAtItsOwnApplyAndDeletesTheMarks() {
		TxnEntry t = drainEntry();
		FluidsT5FFixTest.recover(FluidTxns.DRAIN_KIND, t);
		assertEquals(AIR, w.get(PIT_A), "our standing lava drained");
		var a = FluidTxns.receiptOf(w, 0, 0, t.effects().stream().filter(e -> chunkOf(e) == 0L).findFirst().get().key(t.id));
		assertEquals("1,0", a.get("l"), "A counted as standing at its own apply");
		assertEquals("0,0", a.get("u"));
		var b = FluidTxns.receiptOf(w, 1, 0, t.effects().stream().filter(e -> chunkOf(e) == (1L << 32)).findFirst().get().key(t.id));
		assertEquals("0,0", b.get("l"));
		assertEquals("1,0,1", b.get("h"), "B taken: counted in h, never refunded");
		assertNull(w.mark(PIT_A, rec));
		assertNull(w.mark(PIT_B, rec), "no R mark left in any chunk of the drained record");
		assertNotNull(st.drainReceipts);
		assertTrue(st.taken[0] == 1 && st.taken[1] == 0 && st.taken[2] == 1, "Σh: 1 lava cell, 0 bars, 1 cell");
		int[] sum = FluidTxns.scoopSum(st, w);
		assertEquals(1, sum[0], "the scoop sums the receipts: 1 (A); charged 2 = 1 refunded + 1 held by the player");
	}

	static long chunkOf(Effect e) {
		var c = e.data().getAsJsonArray("chunks").get(0).getAsJsonArray();
		return (long) c.get(0).getAsInt() << 32 | c.get(1).getAsInt() & 0xffffffffL;
	}

	@Test
	void onlyALostChunkIsDrainedAgain_andTheDeadlineMovesWithIt() {
		TxnEntry t = drainEntry();
		w.time = 1000;
		FluidsT5FFixTest.recover(FluidTxns.DRAIN_KIND, t);
		w.save(0, 0); // chunk 0,0's drain and receipt on disk; chunk 1,0's never saved
		// a player dispenses lava into A's (drained, unmarked) cell; chunk 1,0 is lost at a crash
		w.put(PIT_A, LAVA);
		w.save(0, 0);
		w.lose(1, 0);
		w.time = 2000;
		for (Effect e : t.effects()) {
			if ("fluid.drain".equals(e.op()) && chunkOf(e) == 0L) {
				assertEquals(Probe.APPLIED, FluidTxns.DRAIN_KIND.adapter(e).probe(t, e), "chunk 0,0's receipt is on disk: never drained again");
			}
		}
		FluidsT5FFixTest.recover(FluidTxns.DRAIN_KIND, t);
		assertEquals(LAVA, w.get(PIT_A), "the dispensed lava stays (no mark; chunk 0,0 never re-run): P1-2b");
		st.until = -1;
		assertEquals(2000 + 80, RegionFluids.settleDeadline(w, st, 80, 2500), "the deadline: max(receipt t) + bound, the redone chunk's t included (F)");
	}

	@Test
	void aMissingReceiptHoldsTheScoopNeverGuesses() {
		TxnEntry t = drainEntry();
		FluidsT5FFixTest.recover(FluidTxns.DRAIN_KIND, t);
		w.lose(1, 0); // never saved
		assertNull(FluidTxns.scoopSum(st, w));
		assertEquals("chunk 1,0", FluidTxns.scoopMissing);
	}

	@Test
	void aNewDrainPlansNoLedgerEffect() {
		assertNull(FluidTxns.DRAIN_KIND.adapter(Effect.fromJson(FluidsT5FFixTest.eff(0, "pile.scoop", "L", new JsonObject()))), "I5: no L in a T5Fc drain");
		assertNotNull(FluidTxns.SCOOP_KIND.adapter(Effect.fromJson(FluidsT5FFixTest.eff(0, "pile.scoop", "L", new JsonObject()))));
	}

	@Test
	void s3s4_theRemovalResultReadsTheRecordsOnDiskOnce() throws java.io.IOException {
		java.nio.file.Path dir = world.resolve("rgn");
		java.nio.file.Files.createDirectories(dir);
		RegionStore.writeJson(dir.resolve("fluids.json"), JsonParser.parseString(
			"{\"scoopCredited\":{\"minecraft:lava_bucket\":2,\"minecraft:iron_bars\":3},\"taken\":[1,2,4]}").getAsJsonObject());
		RegionStore.writeJson(dir.resolve("fluids-rv2.json"), JsonParser.parseString("{\"scoopCredited\":{\"minecraft:lava_bucket\":1,\"planned\":true},"
			+ "\"taken\":[0,0,1]}").getAsJsonObject());
		RegionStore.writeJson(dir.resolve("fluids-rv3.json"), JsonParser.parseString("{\"scoopCredited\":{\"minecraft:lava_bucket\":9},\"taken\":[9,9,9]}")
			.getAsJsonObject());
		JsonObject x = RegionFluids.extrasIn(dir, null, java.util.Set.of("fluids-rv3.json"), "rgn");
		assertEquals(3, x.getAsJsonObject("refund").get("minecraft:lava_bucket").getAsInt(), "rv3 was undone (reported by its undo): never twice");
		assertEquals(3, x.getAsJsonObject("refund").get("minecraft:iron_bars").getAsInt());
		assertEquals(1, x.getAsJsonObject("taken").get("minecraft:lava_bucket").getAsInt());
		assertEquals(2, x.getAsJsonObject("taken").get("minecraft:iron_bars").getAsInt());
		assertEquals(5, x.get("takenCells").getAsInt(), "Σh over every standing record, water included");
		JsonObject one = RegionFluids.extrasIn(dir, "fluids-rv2.json", java.util.Set.of(), "rgn");
		assertEquals(1, one.getAsJsonObject("refund").get("minecraft:lava_bucket").getAsInt());
		assertNull(RegionFluids.extrasIn(world.resolve("none"), null, java.util.Set.of(), "none"));
	}
}
