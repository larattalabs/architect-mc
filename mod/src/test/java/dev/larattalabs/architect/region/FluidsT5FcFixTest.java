package dev.larattalabs.architect.region;

import static dev.larattalabs.architect.region.FluidsT5FFixTest.call;
import static dev.larattalabs.architect.region.FluidsT5FFixTest.method;
import static dev.larattalabs.architect.region.FluidsT5FFixTest.setStatic;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.txn.Await;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnEnv;
import dev.larattalabs.architect.txn.TxnStore;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (T5Fc fix round) The GPT review of 081d5c53..25748ae8 (NOT SAFE: 6 P1, 8 P2), one test per finding, red first, through the real adapters
 * on {@link MemFluidWorld} and, where a txn's order matters, a real {@link TxnCore} installed as the server's core (in-memory txn.json,
 * a barrier the test can refuse, a crash at a named point and a reload of the core from its store).
 */
class FluidsT5FcFixTest {
	// a lava pit of three cells, two in chunk 0,0 (x 14, 15) and one in chunk 1,0 (x 16); a water pool at x 15 whose east neighbour is in 1,0
	static final String IR = "{\"parts\":[{\"id\":\"pit\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pit\",\"part\":\"q\",\"fluid\":\"lava\","
		+ "\"level\":60,\"cells\":[[14,5,60,60],[15,5,60,60],[16,5,60,60]],\"shell\":[[13,5,59,60]],\"spill\":[[17,5,60,60]],\"settleTicks\":80}]},"
		+ "{\"id\":\"pool\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pool\",\"part\":\"p\",\"fluid\":\"water\",\"level\":60,"
		+ "\"cells\":[[15,9,60,60]],\"shell\":[[14,9,59,60]],\"settleTicks\":35}]}]}";
	// two lava bodies, pb written after pa (a course: drained in reverse, pb first); pa's cell in chunk 0,0, pb's in 1,0
	static final String IR2 = "{\"parts\":[{\"id\":\"pa\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pa\",\"part\":\"a\",\"fluid\":\"lava\","
		+ "\"level\":60,\"cells\":[[15,5,60,60]],\"shell\":[[14,5,59,60]],\"settleTicks\":80}]},{\"id\":\"pb\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\","
		+ "\"id\":\"pb\",\"part\":\"b\",\"fluid\":\"lava\",\"level\":60,\"cells\":[[16,5,60,60]],\"shell\":[[17,5,59,60]],\"after\":[\"pa\"],\"settleTicks\":80}]}]}";
	static final long A = BlockPos.asLong(14, 60, 5), B = BlockPos.asLong(15, 60, 5), C = BlockPos.asLong(16, 60, 5);
	static final long POOL = BlockPos.asLong(15, 60, 9), POOL_EAST = BlockPos.asLong(16, 60, 9);

	@TempDir
	Path world;
	RegionsImpl.Live l;
	RegionFluids.Regional st;
	MemFluidWorld w;
	String rec;
	BlockState LAVA, AIR, WATER;
	Env env;
	TxnCore core;
	TxnCore.BeginGuard wasGuard;
	StockLedger ledger;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@BeforeEach
	void setUp() throws Exception {
		LAVA = Blocks.LAVA.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
		WATER = Blocks.WATER.defaultBlockState();
		w = new MemFluidWorld();
		FluidTxns.testWorld = e -> w;
		env = new Env();
		wasGuard = TxnCore.BEGIN_GUARD;
		TxnCore.BEGIN_GUARD = null;
		newCore(null);
		ledger = new StockLedger();
		ledger.credit("seed", Map.of(StockLedger.BUCKET, 10), 1000, s -> 64); // ten empty buckets in the pile
		FluidTxns.testLedger = o -> ledger;
	}

	@AfterEach
	void tearDown() throws Exception {
		FluidTxns.testWorld = null;
		FluidTxns.testLedger = null;
		setStatic(dev.larattalabs.architect.journal.WorldJournal.class, "killProbe", null);
		FluidTxns.testCore = null;
		TxnCore.BEGIN_GUARD = wasGuard;
		RegionsImpl.dropLive("t5fx");
		RegionFluids.forget(null);
	}

	/** A fresh core over the env's txn.json ({@code doc}: as on disk; null: empty), installed as the server's, recovered. */
	void newCore(JsonObject doc) throws Exception {
		core = new TxnCore(env);
		for (var k : List.of(FluidTxns.CHARGE_KIND, FluidTxns.DRAIN_KIND, FluidTxns.WRITE_KIND, FluidTxns.ADOPT_KIND, FluidTxns.SCOOP_KIND, FluidTxns.STRAY_KIND)) {
			core.register(k); // (FluidTxns.register's kinds, without its dev-environment flags)
		}
		core.load(doc, null);
		FluidTxns.testCore = core;
		core.recover();
	}

	/** A restart: the record read again from fluids.json, the core from txn.json, recovery run. */
	void restart() throws Exception {
		RegionFluids.forget(null);
		st = RegionFluids.of(l);
		newCore(env.disk == null ? null : env.disk.deepCopy());
	}

	void region(String ir, String survival) {
		RegionRec r = new RegionRec("t5fx", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 40, 0, 31, 90, 31}, 1L);
		if (survival != null) {
			r.survival = JsonParser.parseString(survival).getAsJsonObject();
		}
		l = new RegionsImpl.Live(r, Ir.lenient(JsonParser.parseString(ir).getAsJsonObject(), r.claim), world);
		RegionsImpl.putLive(l);
		st = RegionFluids.of(l);
		assertNotNull(st);
		st.prov = true;
		rec = FluidTxns.recKey(l);
	}

	/** The pit (and pool) written: the cells standing, WROTE, their befores air; the record saved; every chunk saved. */
	void pit(String survival) {
		region(IR, survival);
		for (long p : new long[] {A, B, C}) {
			w.put(p, LAVA);
			mark(p, "WROTE");
			st.states.get("pit").before.put(p, "minecraft:air");
		}
		st.states.get("pit").state = "settled";
		w.put(POOL, WATER);
		mark(POOL, "WROTE");
		st.states.get("pool").before.put(POOL, "minecraft:air");
		st.states.get("pool").state = "settled";
		assertTrue(RegionFluids.save(l, st));
		w.saveAll();
	}

	void mark(long p, String m) {
		var ms = w.marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec);
		ms.put(w.index(p), FluidProv.Mark.valueOf(m));
		w.putMarks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec, ms);
	}

	String markName(long p) {
		var m = w.mark(p, rec);
		return m == null ? null : m.name();
	}

	FluidTxns.Step drain() {
		return FluidTxns.removalDrain(null, null, l, st, "g1", false);
	}

	TxnEntry open(String kind) {
		return core.open().stream().filter(t -> kind.equals(t.kind)).findFirst().orElse(null);
	}

	int[] sum() {
		return FluidTxns.scoopSum(st, w);
	}

	// ------------------------------------------------------------------ P1-1: l from owned removals, never a standing count

	@Test
	void p1_1_aPlayersSourceInAWroteCellIsNeitherDrainedNorRefunded() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		// the player harvested A and put lava back from their own bucket (a Placed record): theirs now
		w.put(A, LAVA);
		w.playerPlaced.add(A);
		assertEquals(FluidTxns.Step.Kind.DONE, drain().kind());
		assertEquals(LAVA, w.get(A), "the player's source stays");
		assertEquals(AIR, w.get(B));
		assertEquals(AIR, w.get(C));
		int[] s = sum();
		assertNotNull(s, "every drain receipt is on disk");
		assertEquals(2, s[0], "refunded only what the drain took (B, C); A is the player's (red: the standing count refunded 3)");
	}

	@Test
	void p1_1_aFlowingDrainTakesSourcesOnlyAndARefusedSourceHolds() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		BlockState flow = RegionFluids.flowingState(net.minecraft.world.level.material.Fluids.LAVA, 6);
		w.put(BlockPos.asLong(17, 60, 5), flow);
		w.refuse.add(B);
		FluidTxns.Step g = FluidTxns.removalDrain(null, null, l, st, "g1", true);
		assertTrue(g.kind() != FluidTxns.Step.Kind.DONE, "a refused source holds the flowing drain W too (red: Placed.set's answer ignored)");
		assertEquals(flow, w.get(BlockPos.asLong(17, 60, 5)), "a flowing drain takes the sources only: the flow dies by itself (red: the unit's world never took that path)");
		assertEquals("DRAINED", markName(A), "the accepted source keeps its entitlement");
		w.refuse.clear();
		core.tick();
		core.open().forEach(core::drive);
		assertNotNull(sum());
		assertEquals(3, sum()[0]);
	}

	// ------------------------------------------------------------------ P1-2: a partly refused W keeps the accepted cells' entitlement

	@Test
	void p1_2_aPartlyRefusedDrainKeepsTheAcceptedRemovalAcrossACrash() throws Exception {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		w.refuse.add(B); // a hold refuses B; A (same chunk) drains
		FluidTxns.Step g = drain();
		assertTrue(g.kind() != FluidTxns.Step.Kind.DONE);
		assertEquals(AIR, w.get(A));
		assertEquals(LAVA, w.get(B));
		w.saveAll(); // an autosave holds the partly drained chunk; then a crash
		restart();
		w.refuse.clear();
		core.open().forEach(core::drive);
		assertNull(open(FluidTxns.DRAIN), "the drain retired");
		assertEquals(3, sum()[0], "A (drained before the refusal), B and C refunded (red: A read as harvested, refunded 0: lost)");
	}

	// ------------------------------------------------------------------ P1-3: the legacy allocation frozen before any mark changes

	@Test
	void p1_3_theLegacyBudgetIsFrozenInTheIntent() {
		region(IR2, "{\"on\":true,\"chargedAt\":5,\"charged\":{\"minecraft:lava_bucket\":1}}");
		long pa = BlockPos.asLong(15, 60, 5), pb = BlockPos.asLong(16, 60, 5);
		st.states.get("pa").before.put(pa, "minecraft:air"); // never delivered (lost at a K4): no mark, air
		st.states.get("pb").before.put(pb, "minecraft:air");
		mark(pb, "WROTE"); // delivered, then the player bucketed it
		assertTrue(RegionFluids.save(l, st));
		w.saveAll();
		assertEquals(FluidTxns.Step.Kind.DONE, drain().kind());
		int[] s = sum();
		assertEquals(0, s[0], "charged 1 = the player's 1: nothing to refund (red: pb's mark deleted first, pa got the budget: minted 1)");
	}

	// ------------------------------------------------------------------ P1-4: a system drain's removal keeps its entitlement

	@Test
	void p1_4_aHeldDrainOfADeliveredPaidSourceIsRefundedAtTheRemoval() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		RegionFluids.Body b = st.body("pit");
		FluidTxns.Step h = FluidTxns.hold(l, st, b, "uncontained", "TEST recheck", List.of());
		assertEquals(FluidTxns.Step.Kind.DONE, h.kind(), "the held body's drain txn retired: " + h.detail());
		assertEquals(AIR, w.get(A));
		assertEquals("DRAINED", markName(A), "Architect's own removal of a delivered paid source: its entitlement stays with its block");
		assertEquals(FluidTxns.Step.Kind.DONE, drain().kind());
		assertEquals(3, sum()[0], "the removal refunds the three sources the recheck drained (red: read as taken, refunded 0)");
	}

	// ------------------------------------------------------------------ P1-5: one chunk-key convention

	@Test
	void p1_5_strayPlansEachChunkInItsOwnCoordinates() {
		pit(null);
		st.removal = "restoring";
		List<Long> chunks = List.of(ChunkPos.pack(100, 7), ChunkPos.pack(-3, 5));
		FluidTxns.stray(l, st, "g1", chunks);
		TxnEntry t = open(FluidTxns.STRAY);
		assertNotNull(t, "the stray txn (its W needs a level: held in a unit)");
		List<String> at = new ArrayList<>();
		for (Effect e : t.effects()) {
			if ("fluid.stray".equals(e.op())) {
				JsonArray c = e.data().getAsJsonArray("chunks").get(0).getAsJsonArray();
				at.add(c.get(0).getAsInt() + "," + c.get(1).getAsInt());
			}
		}
		assertEquals(List.of("100,7", "-3,5"), at, "(red: x and z transposed, the real chunk marked done)");
	}

	// ------------------------------------------------------------------ P1-6: the restart fallback only for legacy records

	@Test
	void p1_6_aRestartInTheStrayPassRedrainsOnlyALegacyRecord() {
		pit(null);
		st.removal = "restoring";
		st.redrained = false;
		st.drainReceipts = new JsonArray();
		var m = method(RegionFluids.class, "restartRedrains", RegionFluids.Regional.class);
		assertFalse((Boolean) call(m, st), "a T5Fc record recovers by its receipts: never the raw drain of every source");
		st.drainReceipts = null;
		assertTrue((Boolean) call(m, st), "a record drained before T5Fc (no index) keeps 8c's fallback");
	}

	// ------------------------------------------------------------------ P2-7: the escape's W is the intent's, chunk-local

	@Test
	void p2_7_anEscapePlansItsClosureAndEachWLeavesTheRecordAlone() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		env.barrierOk = false; // the Ws apply, the barrier holds the txn: the R has not run
		FluidTxns.escape(l, st, st.body("pit"), "escaped", "escaped", List.of(new long[] {18, 60, 5}));
		TxnEntry t = open(FluidTxns.DRAIN);
		assertNotNull(t);
		Effect w0 = t.effects().stream().filter(e -> "fluid.escape".equals(e.op())).findFirst().orElseThrow();
		assertTrue(w0.data().has("closure"), "the upstream closure is in the intent (red: recomputed at each W)");
		assertEquals(AIR, w.get(A));
		assertEquals("settled", st.states.get("pit").state, "a W writes the world only; the record is the R's (red: the first W set drained, steering the next)");
	}

	@Test
	void p2_7_abortFlowingWritesOnlyItsFilteredChunk() {
		var m = method(RegionFluids.class, "abortFlowing", FluidWorld.class, RegionFluids.Regional.class, RegionFluids.Body.class, RegionFluids.BodyState.class,
			java.util.function.LongPredicate.class);
		pit(null);
		Object n = call(m, w, st, st.body("pit"), st.states.get("pit"), (java.util.function.LongPredicate) p -> RegionFluids.inChunk(p, 1, 0));
		assertEquals(LAVA, w.get(A), "chunk 0,0 untouched by chunk 1,0's abort");
		assertEquals(AIR, w.get(C));
		assertEquals(1, ((Number) n).intValue());
	}

	// ------------------------------------------------------------------ P2-8: ticks from geometry

	@Test
	void p2_8_aBorderNeighbourIsTickedByItsOwnChunksW() {
		pit(null);
		w.put(POOL_EAST, RegionFluids.flowingState(net.minecraft.world.level.material.Fluids.WATER, 7));
		assertEquals(FluidTxns.Step.Kind.DONE, drain().kind());
		assertTrue(w.ticksIn(1, 0).contains(POOL_EAST), "chunk 1,0's W ticks the flow beside the drained source at x 15 (red: no W ticked it)");
		assertFalse(w.ticksIn(0, 0).contains(POOL_EAST));
	}

	// ------------------------------------------------------------------ P2-9: wait for the scoop's EFFECTS_DONE

	@Test
	void p2_9_theScoopStepWaitsWhileItsTxnIsOpen() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		assertEquals(FluidTxns.Step.Kind.DONE, drain().kind());
		env.barrierOk = false; // the scoop's L and R apply; its effects barrier refuses: the txn stays open, held
		boolean first = RegionFluids.scoopStep(l, st);
		assertFalse(first);
		TxnEntry t = open(FluidTxns.SCOOP);
		if (t == null) { // (red: no ledger seam; the scoop as if its R ran and its barrier refused)
			TxnCore.Started s = core.begin(FluidTxns.SCOOP, "scoop:" + FluidTxns.scoopKey(l), List.of(FluidTxns.resource(l)), null);
			core.plan(s.entry(), Effect.of("region.scooped", dev.larattalabs.architect.txn.EffectClass.R).data("region", "t5fx").data("rid", 0).data("lava", 0)
				.data("grates", 0));
			core.persist(s.entry());
			st.scooped = s.entry().id;
		}
		assertNotNull(st.scooped, "the R ran before the barrier");
		assertFalse(RegionFluids.scoopStep(l, st), "scooped is no completion: the txn is not EFFECTS_DONE (red: true)");
		env.barrierOk = true;
		core.open().forEach(core::drive);
		assertTrue(RegionFluids.scoopStep(l, st));
	}

	// ------------------------------------------------------------------ P2-10: the amount the ledger credited, kept with its key

	@Test
	void p2_10_theScoopKeepsWhatTheLedgerCreditedNeverThePlan() {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		StockLedger led = new StockLedger();
		led.credit("seed", Map.of(StockLedger.BUCKET, 2), 1000, s -> 64); // two empty buckets only
		ledger = led;
		String key = FluidTxns.scoopKey(l);
		var into = method(dev.larattalabs.architect.site.Stockpiles.class, "scoopInto", StockLedger.class, String.class, int.class, int.class, int.class,
			java.util.function.ToIntFunction.class, Map.class);
		call(into, led, key, 10, 0, 1000, (java.util.function.ToIntFunction<String>) s -> 64, new TreeMap<String, Integer>());
		// the L's ledger save happened; a crash lost its answer before the R
		st.scoopCreditedNow = null;
		JsonObject sc = new JsonObject();
		sc.addProperty("owner", "steward");
		sc.addProperty("key", key);
		sc.addProperty("lava", 10);
		sc.addProperty("grates", 0);
		sc.addProperty("region", "t5fx");
		sc.addProperty("rid", 0);
		sc.addProperty("v", 2);
		JsonObject sr = new JsonObject();
		sr.addProperty("region", "t5fx");
		sr.addProperty("rid", 0);
		sr.addProperty("lava", 10);
		sr.addProperty("grates", 0);
		TxnEntry t = FluidsT5FFixTest.entry("tx-77", FluidTxns.SCOOP, List.of(FluidsT5FFixTest.eff(0, "pile.scoop", "L", sc), FluidsT5FFixTest.eff(1,
			"region.scooped", "R", sr)));
		Effect r = t.effects().get(1);
		FluidTxns.SCOOP_KIND.adapter(r).apply(t, r);
		assertEquals(2, st.scoopCredited.get("minecraft:lava_bucket").getAsInt(), "two buckets credited, not the ten planned (red: 10, planned)");
		assertFalse(st.scoopCredited.has("planned"));
	}

	// ------------------------------------------------------------------ P2-11: taken from the final receipts

	@Test
	void p2_11_takenIsReadFromTheFinalReceiptsAfterAReplay() throws Exception {
		pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
		env.crashAt = "barrier:effects"; // the drain's Ws and R applied, the barrier not passed
		try {
			drain();
		} catch (Crash expected) {
			// the crash
		}
		RegionFluids.save(l, st); // (its R had saved drained and taken 0)
		w.save(0, 0);
		w.lose(1, 0); // chunk 1,0's drain was never saved: C stands again, WROTE
		w.put(C, AIR); // the player buckets C before the replay
		restart();
		assertNull(open(FluidTxns.DRAIN), "the replay redid chunk 1,0 (h=1 now) and retired");
		assertTrue(RegionFluids.scoopStep(l, st), "the scoop: " + st.drainHeldAt);
		assertNotNull(st.taken);
		assertEquals(1, st.taken[2], "C taken: counted from the final receipts (red: the R's stale 0)");
		assertEquals(2, st.scoopCredited.get("minecraft:lava_bucket").getAsInt(), "A and B refunded; C is the player's");
	}

	// ------------------------------------------------------------------ P2-12: a resumed revision undo merges its fluids

	@Test
	void p2_12_aStageFinishedByItselfMergesItsFluidsToo() {
		var m = method(Revisions.class, "mergeAwaited", JsonObject.class, String.class, JsonObject.class, java.util.function.UnaryOperator.class);
		JsonObject op = new JsonObject();
		JsonArray aw = new JsonArray();
		aw.add("fluids:rv2");
		op.add("awaited", aw);
		JsonObject snap = JsonParser.parseString("{\"refund\":{\"minecraft:cobblestone\":3}}").getAsJsonObject();
		JsonObject fx = JsonParser.parseString("{\"refund\":{\"minecraft:lava_bucket\":2},\"taken\":{\"minecraft:lava_bucket\":1},\"takenCells\":1}")
			.getAsJsonObject();
		var from = method(dev.larattalabs.architect.site.Groups.class, "withFluidsFrom", dev.larattalabs.architect.site.Groups.Removed.class, JsonObject.class);
		java.util.function.UnaryOperator<Object> fluids = r -> call(from, r, fx);
		assertTrue((Boolean) call(m, op, "fluids:rv2", snap, fluids));
		JsonObject agg = op.getAsJsonObject("result");
		assertEquals(2, agg.getAsJsonObject("refund").get("minecraft:lava_bucket").getAsInt(), "the scoop's refund joins the undo's aggregate");
		assertEquals(1, agg.get("fluidsTakenCells").getAsInt());
	}

	// ------------------------------------------------------------------ P2-13: a revision's rows frozen with its tombstone

	@Test
	void p2_13_anUndoneRevisionsRowsAreFrozen() {
		pit(null);
		RegionsImpl.Live x = new RegionsImpl.Live(l.rec(), l.ir(), world, 2, null, null);
		RegionFluids.Regional xs = new RegionFluids.Regional(st.bodies);
		xs.states.get("pit").state = "settled";
		RegionFluids.freezeRows(x, xs);
		assertTrue(l.rec().ext.get("architect_mc:fluidsUndone") instanceof JsonObject u && u.get("2") instanceof JsonArray a && !a.isEmpty(),
			"the revision's final rows kept in the region's record (red: only a REMOVING region froze its rows): " + l.rec().ext);
		RegionFluids.report(l, st);
		assertTrue(l.rec().ext.get("architect_mc:fluidsUndone") instanceof JsonObject, "the report never drops them");
	}

	// ------------------------------------------------------------------ P2-14: aliases after the receipt

	@Test
	void p2_14_fl5FiresAfterTheHeadsReceipt() {
		region(IR2, null);
		long pa = BlockPos.asLong(15, 60, 5), pb = BlockPos.asLong(16, 60, 5);
		for (long p : new long[] {pa, pb}) {
			w.put(p, LAVA);
			mark(p, "WROTE");
		}
		st.states.get("pa").before.put(pa, "minecraft:air");
		st.states.get("pb").before.put(pb, "minecraft:air");
		assertTrue(st.ordered);
		List<String> seen = new ArrayList<>();
		setStatic(dev.larattalabs.architect.journal.WorldJournal.class, "killProbe", (java.util.function.Consumer<String>) p -> {
			if ("FL5".equals(p)) {
				TxnEntry t = open(FluidTxns.DRAIN);
				Effect head = t.effects().stream().filter(e -> "fluid.drain".equals(e.op()) && "pb".equals(e.data().get("body").getAsString()) && RegionFluids
					.inChunk(pb, chunk(e)[0], chunk(e)[1])).findFirst().orElseThrow();
				seen.add(w.hasReceipt(1, 0, head.key(t.id)) ? "receipt" : "none");
			}
		});
		drain();
		assertEquals(List.of("receipt"), seen, "FL5 (+save) saves the head's chunk with its receipt (red: before it)");
	}

	static int[] chunk(Effect e) {
		JsonArray c = e.data().getAsJsonArray("chunks").get(0).getAsJsonArray();
		return new int[] {c.get(0).getAsInt(), c.get(1).getAsInt()};
	}

	// ------------------------------------------------------------------ drain then scoop through a real TxnCore, a crash at each step

	@Test
	void drainThenScoopThroughTheCore_aCrashAtEachStep_conservation() throws Exception {
		for (String at : new String[] {"apply:0", "barrier:effects", "drained", "effects", "scoop", "scooped", null}) {
			tearDown();
			setUp();
			pit("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}");
			w.put(A, AIR); // the player took A before the removal: it is theirs (3 charged = 2 refunded + 1 held)
			w.saveAll();
			int buckets = ledger.stock(StockLedger.BUCKET);
			env.crashAt = at;
			setStatic(dev.larattalabs.architect.journal.WorldJournal.class, "killProbe", (java.util.function.Consumer<String>) env::kill);
			try {
				drain();
				RegionFluids.scoopStep(l, st);
			} catch (Crash expected) {
				// a bare crash: the chunks as last saved
			}
			if (at != null) {
				for (long ck : RegionFluids.drainChunks(st)) {
					w.lose((int) (ck >> 32), (int) ck);
				}
				restart();
			}
			for (int i = 0; i < 4 && (st.drainTxn == null || st.scooped == null || open(FluidTxns.SCOOP) != null); i++) {
				drain();
				RegionFluids.scoopStep(l, st);
				core.open().forEach(core::drive);
			}
			assertTrue(RegionFluids.scoopStep(l, st), at + ": the scoop done");
			int lava = ledger.stock("minecraft:lava_bucket");
			assertEquals(2, lava, at + ": refunded exactly once: B and C");
			assertEquals(buckets - 2, ledger.stock(StockLedger.BUCKET), at + ": two empty buckets became lava buckets");
			assertEquals(1, st.taken[0], at + ": A reported taken");
			for (long p : new long[] {A, B, C}) {
				assertNull(markName(p), at + ": no mark of R left after the drain");
			}
			assertEquals(2, st.scoopCredited.get("minecraft:lava_bucket").getAsInt(), at + ": what the ledger credited");
		}
	}

	// ------------------------------------------------------------------ the core's environment

	static final class Crash extends RuntimeException {
		Crash(String at) {
			super("TEST crash at " + at);
		}
	}

	static final class Env implements TxnEnv {
		JsonObject disk;
		boolean barrierOk = true;
		String crashAt;

		@Override
		public TxnStore store() {
			return new TxnStore() {
				@Override
				public DurableFile.Outcome write(JsonObject doc) {
					disk = doc.deepCopy();
					return DurableFile.Outcome.OK;
				}

				@Override
				public DurableFile.Outcome confirm() {
					return DurableFile.Outcome.OK;
				}

				@Override
				public boolean inDoubt() {
					return false;
				}
			};
		}

		@Override
		public Barrier barrier() {
			return barrierOk ? Barrier.ok(List.of()) : Barrier.refused("TEST barrier refused");
		}

		@Override
		public boolean satisfied(Await a) {
			return true;
		}

		@Override
		public void kill(String point) {
			if (crashAt != null && point.endsWith(":" + crashAt)) {
				crashAt = null;
				throw new Crash(point);
			}
		}

		@Override
		public boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
			return true;
		}

		@Override
		public long tick() {
			return 0;
		}

		@Override
		public long wall() {
			return 0;
		}
	}
}
