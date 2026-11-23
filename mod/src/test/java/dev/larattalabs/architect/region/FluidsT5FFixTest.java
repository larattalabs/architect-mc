package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.Probe;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnKind;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
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

/**
 * (slice T5F fix round: the T5Fb review's P1-1..4, P2-5..7 and the PLACING harvest) The real fluid.write and fluid.adopt adapters run
 * against an in-memory world ({@link MemFluidWorld}: blocks, marks, receipts and ticks per chunk, saved and lost together), asserting the
 * saved marks, receipts, ticks and the refund; legacy entries, refused writes, mixed snapshots and a second crash during recovery.
 */
class FluidsT5FFixTest {
	// a pond across the chunk border x=15|16 (chunks 0,0 and 1,0) and a lava pit across the same border
	static final String IR = "{\"parts\":[{\"id\":\"pond\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pond\",\"part\":\"p\",\"fluid\":\"water\","
		+ "\"level\":63,\"cells\":[[15,1,63,63],[16,1,63,63]],\"ice\":[],\"shell\":[[14,1,62,63]],\"spill\":[],\"joins\":[],\"watch\":[],\"predicted\":[],"
		+ "\"settleTicks\":35}]},{\"id\":\"pit\",\"stage\":\"fluids\",\"ops\":[{\"op\":\"fluid\",\"id\":\"pit\",\"part\":\"q\",\"fluid\":\"lava\",\"level\":60,"
		+ "\"cells\":[[15,5,60,60],[16,5,60,60]],\"shell\":[[14,5,59,60]],\"settleTicks\":80}]}]}";
	static final long POND_A = BlockPos.asLong(15, 63, 1), POND_B = BlockPos.asLong(16, 63, 1);
	static final long PIT_A = BlockPos.asLong(15, 60, 5), PIT_B = BlockPos.asLong(16, 60, 5);
	BlockState WATER, LAVA, AIR; // (after Boot)

	@TempDir
	Path world;
	RegionsImpl.Live l;
	RegionFluids.Regional st;
	MemFluidWorld w;
	String rec;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@BeforeEach
	void setUp() {
		WATER = Blocks.WATER.defaultBlockState();
		LAVA = Blocks.LAVA.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
		JsonObject ir = JsonParser.parseString(IR).getAsJsonObject();
		RegionRec r = new RegionRec("t5fx", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 40, 0, 31, 90, 31}, 1L);
		l = new RegionsImpl.Live(r, Ir.lenient(ir, r.claim), world);
		RegionsImpl.putLive(l);
		st = RegionFluids.of(l);
		assertNotNull(st);
		w = new MemFluidWorld();
		FluidTxns.testWorld = e -> w;
		rec = FluidTxns.recKey(l);
	}

	@AfterEach
	void tearDown() {
		FluidTxns.testWorld = null;
		FluidTxns.testEvidence = null;
		setStatic(RegionFluids.class, "testLegacyJournal", null);
		RegionsImpl.dropLive("t5fx");
		RegionFluids.forget(null);
	}

	// ------------------------------------------------------------------ helpers

	static void setStatic(Class<?> c, String name, Object v) {
		try {
			Field f = c.getDeclaredField(name);
			f.setAccessible(true);
			f.set(null, v);
		} catch (NoSuchFieldException e) {
			// not built (the red run): the test's own assertion fails
		} catch (IllegalAccessException e) {
			throw new AssertionError(e);
		}
	}

	static Method method(Class<?> c, String name, Class<?>... args) {
		try {
			Method m = c.getDeclaredMethod(name, args);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			fail("not built: " + c.getSimpleName() + "." + name);
			return null;
		}
	}

	static Object call(Method m, Object... args) {
		try {
			return m.invoke(null, args);
		} catch (ReflectiveOperationException e) {
			throw new AssertionError(m + ": " + e.getCause(), e.getCause());
		}
	}

	JsonObject data(int cx, int cz, String body) { // (also T5Fc's tests)
		JsonObject d = new JsonObject();
		d.addProperty("region", "t5fx");
		d.addProperty("rid", 0);
		d.addProperty("dim", "minecraft:overworld");
		d.addProperty("group", "g1");
		JsonArray chunks = new JsonArray();
		JsonArray c = new JsonArray();
		c.add(cx);
		c.add(cz);
		chunks.add(c);
		d.add("chunks", chunks);
		if (body != null) {
			d.addProperty("body", body);
		}
		return d;
	}

	static JsonObject eff(int i, String op, String cls, JsonObject data) {
		JsonObject o = new JsonObject();
		o.addProperty("i", i);
		o.addProperty("op", op);
		o.addProperty("class", cls);
		o.add("data", data);
		return o;
	}

	/** A committed write txn (recovered: not live) of these effects. */
	static TxnEntry entry(String id, String kind, List<JsonObject> effects) { // (also fix round 2's)
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("kind", kind);
		o.addProperty("kv", 1);
		o.addProperty("key", "k-" + id);
		o.add("decision", com.google.gson.JsonNull.INSTANCE);
		o.addProperty("phase", "PREPARED");
		JsonObject at = new JsonObject();
		at.addProperty("tick", 0);
		at.addProperty("wall", 0);
		o.add("at", at);
		o.add("resources", new JsonArray());
		JsonObject dc = new JsonObject();
		dc.addProperty("kind", "txn");
		o.add("decider", dc);
		JsonArray es = new JsonArray();
		effects.forEach(es::add);
		o.add("effects", es);
		return TxnEntry.fromJson(o);
	}

	static TxnKind.Adapter adapter(TxnKind k, Effect e) {
		TxnKind.Adapter a = k.adapter(e);
		assertNotNull(a, e.op());
		return a;
	}

	/** Recovery as the core does it: every effect whose probe is not APPLIED is applied, in order. */
	static void recover(TxnKind k, TxnEntry t) {
		for (Effect e : t.effects()) {
			TxnKind.Adapter a = adapter(k, e);
			if (a.probe(t, e) != Probe.APPLIED) {
				a.apply(t, e);
			}
		}
	}

	void markWrote(long p) {
		var m = w.marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec);
		m.put(w.index(p), FluidProv.Mark.WROTE);
		w.putMarks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec, m);
	}

	// ------------------------------------------------------------------ P1-2: a refused write leaves no mark and no receipt

	@Test
	void p1_2_aRefusedPlaceHoldsWithoutAMarkOrAReceipt() {
		TxnEntry t = entry("tx-11", FluidTxns.WRITE, List.of(eff(0, "fluid.place", "W", data(0, 0, "pit"))));
		Effect e = t.effects().get(0);
		w.refuse.add(PIT_A); // a T4 hold refuses the cell's write
		assertThrows(RuntimeException.class, () -> adapter(FluidTxns.WRITE_KIND, e).apply(t, e), "the W holds: a refused cell is no completion");
		assertEquals(AIR, w.get(PIT_A));
		assertNull(w.mark(PIT_A, rec), "no WROTE over a cell the world refused (P1-2: delivery and refund kept)");
		assertFalse(w.hasReceipt(0, 0, e.key(t.id)), "no receipt for a held W");
		w.refuse.clear();
		assertEquals(Probe.ABSENT, adapter(FluidTxns.WRITE_KIND, e).probe(t, e));
		adapter(FluidTxns.WRITE_KIND, e).apply(t, e);
		assertEquals(LAVA, w.get(PIT_A));
		assertEquals(FluidProv.Mark.WROTE, w.mark(PIT_A, rec));
		assertEquals("1", w.receipt(0, 0, e.key(t.id)).get("n"));
	}

	@Test
	void p1_2_aRefusedClearKeepsWrote() {
		w.put(POND_A, WATER);
		markWrote(POND_A);
		TxnEntry t = entry("tx-12", FluidTxns.WRITE, List.of(eff(0, "fluid.clear", "W", withBodies(data(0, 0, null), "pond"))));
		Effect e = t.effects().get(0);
		w.refuse.add(POND_A);
		assertThrows(RuntimeException.class, () -> adapter(FluidTxns.WRITE_KIND, e).apply(t, e));
		assertEquals(WATER, w.get(POND_A));
		assertEquals(FluidProv.Mark.WROTE, w.mark(POND_A, rec), "the water still stands: never recorded CLEARED (P1-2)");
		assertFalse(w.hasReceipt(0, 0, e.key(t.id)));
		w.refuse.clear();
		adapter(FluidTxns.WRITE_KIND, e).apply(t, e);
		assertEquals(AIR, w.get(POND_A));
		assertEquals(FluidProv.Mark.CLEARED, w.mark(POND_A, rec));
	}

	static JsonObject withBodies(JsonObject d, String... ids) {
		JsonArray a = new JsonArray();
		for (String id : ids) {
			a.add(id);
		}
		d.add("bodies", a);
		return d;
	}

	@Test
	void p1_2_theRollbackScopeClearsOnlyAnAcceptedOrVerifiedWriteOverOurs() {
		Method m = method(FluidProv.class, "clearsOnWrite", boolean.class, boolean.class, boolean.class);
		assertEquals(true, call(m, true, true, false), "ours, written back: cleared");
		assertEquals(true, call(m, true, false, true), "ours, the cell already holds the target: a verified completion");
		assertEquals(false, call(m, true, false, false), "refused: the mark stays");
		assertEquals(false, call(m, false, true, true), "not ours before the write (harvested while PLACING): WROTE stays, never delivered again");
	}

	@Test
	void placing_aTileNeverWritesOverAWroteCellThatIsTaken() {
		RegionFluids.Body pit = st.body("pit");
		Method m = method(RegionFluids.class, "tileSkips", RegionFluids.Body.class, long.class, FluidProv.Mark.class, BlockState.class);
		assertEquals(true, call(m, pit, PIT_A, FluidProv.Mark.WROTE, AIR), "harvested while PLACING: the tile's retry skips it");
		assertEquals(false, call(m, pit, PIT_A, FluidProv.Mark.WROTE, LAVA));
		assertEquals(false, call(m, pit, PIT_A, null, AIR), "never written: the tile writes it");
	}

	// ------------------------------------------------------------------ §3.3 on the real adapter; mixed snapshots and a second crash

	@Test
	void place_aTakenWroteCellIsNeverRewrittenAndIsCountedH() {
		markWrote(PIT_A); // the tile wrote it, a player took it
		TxnEntry t = entry("tx-13", FluidTxns.WRITE, List.of(eff(0, "fluid.place", "W", data(0, 0, "pit"))));
		Effect e = t.effects().get(0);
		adapter(FluidTxns.WRITE_KIND, e).apply(t, e);
		assertEquals(AIR, w.get(PIT_A));
		assertNull(w.writes.get(PIT_A));
		assertEquals("0", w.receipt(0, 0, e.key(t.id)).get("n"));
		assertEquals("1", w.receipt(0, 0, e.key(t.id)).get("h"));
	}

	@Test
	void p2_7_mixedSnapshotsAndASecondCrashDuringRecovery() {
		List<JsonObject> es = new ArrayList<>();
		es.add(eff(0, "fluid.place", "W", data(0, 0, "pit")));
		es.add(eff(1, "fluid.place", "W", data(1, 0, "pit")));
		int i = 2;
		for (long ck : RegionFluids.forceChunks(st.body("pit"))) {
			es.add(eff(i++, "fluid.force", "W", data((int) (ck >> 32), (int) ck, "pit")));
		}
		TxnEntry t = entry("tx-14", FluidTxns.WRITE, es);
		// the live drive: every W applied
		recover(FluidTxns.WRITE_KIND, t);
		assertEquals(LAVA, w.get(PIT_A));
		assertEquals(LAVA, w.get(PIT_B));
		// chunk 0,0 saved; a player harvests its lava and that is saved too (the flake guard); chunk 1,0 lost at a bare crash
		w.save(0, 0);
		w.put(PIT_A, AIR);
		w.save(0, 0);
		w.lose(1, 0);
		w.lose(0, 0);
		assertEquals(AIR, w.get(PIT_B), "the lost chunk lost its lava, its mark and its receipt together");
		assertNull(w.mark(PIT_B, rec));
		// recovery 1 applies chunk 1,0's place, then a second bare crash loses it again before any save
		recover(FluidTxns.WRITE_KIND, t);
		assertEquals(LAVA, w.get(PIT_B));
		w.lose(1, 0);
		// recovery 2
		recover(FluidTxns.WRITE_KIND, t);
		w.saveAll();
		assertEquals(LAVA, w.get(PIT_B));
		assertEquals(FluidProv.Mark.WROTE, w.mark(PIT_B, rec));
		assertTrue(w.ticksIn(1, 0).contains(PIT_B), "the lost chunk's ticks came back with its W (P2-b, I6)");
		assertEquals(1, w.writes.get(PIT_A), "chunk 0,0's W was receipted on disk: never applied again, the harvest stays");
		assertEquals(AIR, w.get(PIT_A));
		assertEquals(FluidProv.Mark.WROTE, w.mark(PIT_A, rec));
		assertEquals(3, w.writes.get(PIT_B), "applied once per lost snapshot of its chunk");
		// conservation: 2 charged = 1 standing (refunded at removal) + 1 the player holds; the taken WROTE cell refunds 0
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}").getAsJsonObject();
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(2, sc[0] + 1, "refund 1 + held 1 == charged 2");
	}

	// ------------------------------------------------------------------ P1-3: in-flight v1 entries keep their adapters

	@Test
	void p1_3_aV1EntryKeepsItsLegacyAdapters() {
		Effect v1place = Effect.fromJson(eff(0, "fluid.place", "W", withBodies(data(0, 0, null), "pit", "pond")));
		Effect v1written = Effect.fromJson(eff(1, "fluid.written", "R", withBodies(data(0, 0, null), "pit", "pond")));
		assertNotSame(FluidTxns.FLUID_PLACE, FluidTxns.WRITE_KIND.adapter(v1place), "an 8cT-era place (bodies, the journal check) replays with its own adapter");
		assertNotSame(FluidTxns.FLUID_WRITTEN, FluidTxns.WRITE_KIND.adapter(v1written), "an 8cT-era written (it forced the bodies) replays with its own adapter");
		assertNotNull(FluidTxns.WRITE_KIND.adapter(v1place));
		assertNotNull(FluidTxns.WRITE_KIND.adapter(v1written));
	}

	// ------------------------------------------------------------------ P1-1: the legacy payment fallback

	@Test
	void p1_1_chargedAtAloneIsNoEvidenceOfPayment() {
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5}").getAsJsonObject(); // charged nothing: every body failed
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(0, sc[0], "no chargedBodies and no acknowledged charge: the never-written lava is not refunded (P1-1)");
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"charged\":{\"minecraft:lava_bucket\":1}}").getAsJsonObject();
		st.states.get("pit").before.put(PIT_A, "minecraft:air"); // (T5Fc (a)) the gate charged it: its befores captured
		sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(1, sc[0], "a main-era record: refunded up to what its acknowledged charge took");
	}

	@Test
	void p1_1_aChargeWritesItsPaidBodiesEvenWhenEmpty() {
		Method m = method(RegionFluids.class, "markCharged", JsonObject.class, JsonArray.class, long.class);
		JsonObject sv = JsonParser.parseString("{\"on\":true}").getAsJsonObject();
		call(m, sv, new JsonArray(), 7L);
		assertEquals(7L, sv.get("chargedAt").getAsLong());
		assertTrue(sv.get(RegionFluids.CHARGED_BODIES) instanceof JsonArray a && a.isEmpty(), "an explicit empty paid set: " + sv);
	}

	// ------------------------------------------------------------------ P1-4: an old drain finishes on its legacy path

	@Test
	void p1_4_aRecordNotYetAdoptedIsRefundedByTheLegacyRuleNeverAThrow() {
		st.prov = false;
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"chargedBodies\":[\"pit\"]}").getAsJsonObject();
		setStatic(RegionFluids.class, "testLegacyJournal", (FluidTxns.AdoptEvidence) p -> p == PIT_A ? Blocks.LAVA : null);
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(1, sc[0], "the tiles' journal wrote A (taken: 0), never B (paid, never delivered: 1)");
	}

	// ------------------------------------------------------------------ P2-5: adoption evidence is the body's expected block

	@Test
	void p2_5_adoptionCountsOnlyTheBodysOwnBlockAsWritten() {
		FluidTxns.testEvidence = e -> p -> p == PIT_A ? Blocks.AIR : p == PIT_B ? Blocks.LAVA : null; // a basin's air carve at A, the tile's lava at B
		TxnEntry t = entry("tx-15", FluidTxns.ADOPT, List.of(eff(0, "fluid.adopt", "W", data(0, 0, "pit")), eff(1, "fluid.adopt", "W", data(1, 0, "pit"))));
		recover(FluidTxns.ADOPT_KIND, t);
		assertNull(w.mark(PIT_A, rec), "an air carve is no fluid delivery: A stays unmarked (refunded when paid)");
		assertEquals(FluidProv.Mark.WROTE, w.mark(PIT_B, rec), "the tile's lava, now absent: harvested (N2 b)");
	}

	// ------------------------------------------------------------------ P2-6: a replayed force restarts the settling age

	@Test
	void p2_6_aReplayedForceRestartsTheSettle() {
		RegionFluids.BodyState bs = st.states.get("pit");
		bs.writtenAt = 50;
		w.time = 900;
		TxnEntry t = entry("tx-16", FluidTxns.WRITE, List.of(eff(0, "fluid.force", "W", data(0, 0, "pit"))));
		Effect e = t.effects().get(0);
		adapter(FluidTxns.WRITE_KIND, e).apply(t, e);
		Method m = method(RegionFluids.class, "settleBase", FluidWorld.class, RegionFluids.Regional.class, RegionFluids.Body.class, RegionFluids.BodyState.class);
		assertEquals(900L, call(m, w, st, st.body("pit"), bs), "the census counts the bound from the replayed force W, not the R's older writtenAt");
	}

	// ------------------------------------------------------------------ P2-7: the runtime's behaviour, not its classes

	@Test
	void p2_7_waterRefill_aBucketedPondCellIsNeverWrittenAgain() {
		markWrote(POND_A); // the tile wrote it; the player bucketed it (air)
		TxnEntry t = entry("tx-17", FluidTxns.WRITE, List.of(eff(0, "fluid.place", "W", data(0, 0, "pond")), eff(1, "fluid.place", "W", data(1, 0, "pond"))));
		recover(FluidTxns.WRITE_KIND, t);
		assertEquals(AIR, w.get(POND_A), "N3, I2: water too");
		assertNull(w.writes.get(POND_A));
		assertEquals(WATER, w.get(POND_B), "the never-written cell across the border is written");
		assertEquals(FluidProv.Mark.WROTE, w.mark(POND_B, rec));
		assertEquals("1", w.receipt(0, 0, t.effects().get(0).key(t.id)).get("h"));
	}

	@Test
	void p2_7_forceInW_theTicksAreScheduledByEachChunksWAndOnlyInIt() {
		RegionFluids.Body pit = st.body("pit");
		List<JsonObject> es = new ArrayList<>();
		int i = 0;
		for (long ck : RegionFluids.forceChunks(pit)) {
			es.add(eff(i++, "fluid.force", "W", data((int) (ck >> 32), (int) ck, "pit")));
		}
		TxnEntry t = entry("tx-18", FluidTxns.WRITE, es);
		Effect first = t.effects().get(0);
		adapter(FluidTxns.WRITE_KIND, first).apply(t, first);
		int cx = first.data().getAsJsonArray("chunks").get(0).getAsJsonArray().get(0).getAsInt();
		int cz = first.data().getAsJsonArray("chunks").get(0).getAsJsonArray().get(1).getAsInt();
		for (var c : w.live.entrySet()) {
			long key = c.getKey();
			boolean own = key == MemFluidWorld.ck(cx, cz);
			assertEquals(own, !c.getValue().ticks.isEmpty() || !own && false, "ticks only in the W's own chunk " + cx + "," + cz + " (I6)");
			for (long p : c.getValue().ticks) {
				assertEquals(key, RegionFluids.chunkKey(p));
			}
		}
		assertEquals("force", w.receipt(cx, cz, first.key(t.id)).get("op"));
		recover(FluidTxns.WRITE_KIND, t);
		assertTrue(w.ticksIn(0, 0).contains(PIT_A) && w.ticksIn(1, 0).contains(PIT_B), "every cell ticked by its own chunk's W");
	}
}
