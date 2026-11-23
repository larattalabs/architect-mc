package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.TxnEntry;
import java.lang.reflect.Method;
import java.nio.file.Path;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.IronBarsBlock;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T5F fix round 2: the fix-check of 50d2ddaa, P1-a, P1-b, P2-c, P2-d, P2-e) On {@link MemFluidWorld} through the real adapters and
 * the runtime's own predicates and factories (the rollback scope, the tile's skip, the force-time scan, the legacy writer).
 */
class FluidsT5FFix2Test {
	// chunk 0,0 and 1,0: a pond (3 cells, two in chunk 0,0), two lava pits (pitA delivered, pitB uncontained), two grates (gA, gB), a decor pond
	static final String IR = "{\"parts\":[{\"id\":\"w\",\"stage\":\"fluids\",\"ops\":["
		+ "{\"op\":\"fluid\",\"id\":\"pond\",\"part\":\"p\",\"fluid\":\"water\",\"level\":63,\"cells\":[[14,1,63,63],[15,1,63,63],[16,1,63,63]],\"shell\":[],\"settleTicks\":35},"
		+ "{\"op\":\"fluid\",\"id\":\"pitA\",\"part\":\"a\",\"fluid\":\"lava\",\"level\":60,\"cells\":[[3,5,60,60]],\"shell\":[],\"settleTicks\":80},"
		+ "{\"op\":\"fluid\",\"id\":\"pitB\",\"part\":\"b\",\"fluid\":\"lava\",\"level\":60,\"cells\":[[6,5,60,60]],\"shell\":[],\"settleTicks\":80},"
		+ "{\"op\":\"fluid\",\"id\":\"gA\",\"part\":\"c\",\"fluid\":\"water\",\"level\":63,\"cells\":[[3,9,63,63]],\"grate\":[[3,9,63,63]],\"shell\":[],\"settleTicks\":35},"
		+ "{\"op\":\"fluid\",\"id\":\"gB\",\"part\":\"d\",\"fluid\":\"water\",\"level\":63,\"cells\":[[6,9,63,63]],\"grate\":[[6,9,63,63]],\"shell\":[],\"settleTicks\":35},"
		+ "{\"op\":\"fluid\",\"id\":\"deco\",\"part\":\"e\",\"fluid\":\"water\",\"level\":63,\"cells\":[[3,12,63,63],[4,12,63,63]],"
		+ "\"decor\":[{\"state\":\"minecraft:seagrass\",\"cells\":[[4,12,63,63]]}],\"shell\":[],\"settleTicks\":35}]}]}";
	static final long POND_0 = BlockPos.asLong(14, 63, 1), POND_1 = BlockPos.asLong(15, 63, 1);
	static final long PIT_A = BlockPos.asLong(3, 60, 5), PIT_B = BlockPos.asLong(6, 60, 5);
	static final long G_A = BlockPos.asLong(3, 63, 9), G_B = BlockPos.asLong(6, 63, 9);
	static final long DECO_W = BlockPos.asLong(3, 63, 12), DECO_D = BlockPos.asLong(4, 63, 12);

	@TempDir
	Path world;
	RegionsImpl.Live l;
	RegionFluids.Regional st;
	MemFluidWorld w;
	String rec;
	BlockState WATER, LAVA, AIR;

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
		RegionRec r = new RegionRec("t5f2", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 40, 0, 31, 90, 31}, 1L);
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
		RegionsImpl.dropLive("t5f2");
		RegionFluids.forget(null);
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

	void mark(long p, FluidProv.Mark m) {
		var ms = w.marks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec);
		ms.put(w.index(p), m);
		w.putMarks(BlockPos.getX(p) >> 4, BlockPos.getZ(p) >> 4, rec, ms);
	}

	JsonObject data(int cx, int cz, String body, String... bodies) {
		JsonObject d = new JsonObject();
		d.addProperty("region", "t5f2");
		d.addProperty("rid", 0);
		d.addProperty("dim", "minecraft:overworld");
		d.addProperty("group", "g1");
		d.add("chunks", JsonParser.parseString("[[" + cx + "," + cz + "]]"));
		if (body != null) {
			d.addProperty("body", body);
		}
		if (bodies.length > 0) {
			com.google.gson.JsonArray a = new com.google.gson.JsonArray();
			for (String b : bodies) {
				a.add(b);
			}
			d.add("bodies", a);
		}
		return d;
	}

	// ------------------------------------------------------------------ P1-a: mixed paid and unpaid bodies in a legacy record

	@Test
	void p1a_aLegacyRecordNeverRefundsAnUnpaidBodyAfterAPaidDeliveryWasHarvested_lava() {
		// main era: one bucket charged for pitA (pitB failed containment, charged nothing); pitA delivered (WROTE) and harvested
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"charged\":{\"minecraft:lava_bucket\":1}}").getAsJsonObject();
		st.states.get("pitB").uncontained = true;
		st.states.get("pitB").state = "drained";
		mark(PIT_A, FluidProv.Mark.WROTE);
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(0, sc[0], "1 charged = 1 held by the player: pitB was never paid, pitA's delivery was taken (P1-a)");
	}

	@Test
	void p1a_theSameForBars() {
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"charged\":{\"minecraft:iron_bars\":1}}").getAsJsonObject();
		st.states.get("gB").uncontained = true;
		st.states.get("gB").state = "drained";
		mark(G_A, FluidProv.Mark.WROTE);
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(0, sc[1], "1 bar charged = 1 bar held: gB never paid");
	}

	@Test
	void p1a_aNeverDeliveredPaidCellIsStillRefunded() {
		l.rec().survival = JsonParser.parseString("{\"on\":true,\"chargedAt\":5,\"charged\":{\"minecraft:lava_bucket\":2}}").getAsJsonObject();
		mark(PIT_A, FluidProv.Mark.WROTE); // taken
		int[] sc = RegionFluids.scoopPlan(w, l, st, "g1", p -> true);
		assertEquals(1, sc[0], "2 charged: 1 taken (held), pitB never delivered: refunded 1");
		// per chunk, the sums add up to the whole (the drain plans its scoop chunk by chunk)
		int[] c0 = RegionFluids.scoopPlan(w, l, st, "g1", p -> RegionFluids.chunkKey(p) == RegionFluids.chunkKey(PIT_A));
		assertEquals(1, c0[0]);
	}

	// ------------------------------------------------------------------ P1-b: residual flow is not a delivered source

	@Test
	void p1b_aHarvestRefilledByFlowIsNeitherRolledBackAsOursNorDeliveredAgain() {
		RegionFluids.Body pit = st.body("pitA");
		w.put(PIT_A, LAVA); // the tile wrote it
		mark(PIT_A, FluidProv.Mark.WROTE);
		w.put(PIT_A, AIR); // the player buckets it while the tile is PLACING
		BlockState flow = LAVA.setValue(LiquidBlock.LEVEL, 2); // a neighbour's lava flows into the emptied cell
		w.put(PIT_A, flow);
		// a saved crash, then the tile's rollback (R's scope, the runtime's own factory) writes the cell's before back
		FluidProv.Scope sc = RegionFluids.scopeOf(rec, st);
		BlockState prev = w.get(PIT_A);
		boolean ok = w.set(PIT_A, AIR);
		if (FluidProv.clearsOnWrite(sc.ours().test(PIT_A, prev), ok, w.get(PIT_A) == AIR)) {
			mark(PIT_A, null);
		}
		assertEquals(FluidProv.Mark.WROTE, w.mark(PIT_A, rec), "flow is no delivered source: the rollback keeps WROTE");
		// the tile's retry: it writes only where the runtime's skip lets it
		w.put(PIT_A, flow);
		assertTrue(RegionFluids.tileSkips(pit, PIT_A, w.mark(PIT_A, rec), w.get(PIT_A)), "the tile never promotes flow at a WROTE cell into a source");
		// and the place W: never a second source
		TxnEntry t = FluidsT5FFixTest.entry("tx-21", FluidTxns.WRITE, List.of(FluidsT5FFixTest.eff(0, "fluid.place", "W", data(0, 0, "pitA"))));
		Effect e = t.effects().get(0);
		FluidTxns.WRITE_KIND.adapter(e).apply(t, e);
		assertFalse(w.get(PIT_A).getFluidState().isSource(), "no second source");
	}

	@Test
	void p1b_aStandingDeliveredSourceIsStillOurs() {
		FluidProv.Scope sc = RegionFluids.scopeOf(rec, st);
		assertTrue(sc.ours().test(PIT_A, LAVA));
		assertFalse(RegionFluids.tileSkips(st.body("pitA"), PIT_A, FluidProv.Mark.WROTE, LAVA));
		assertTrue(RegionFluids.tileSkips(st.body("pitA"), PIT_A, FluidProv.Mark.WROTE, AIR));
	}

	// ------------------------------------------------------------------ P2-c: the force time survives a second restart

	@Test
	void p2c_theLatestForceTimeIsReadBackFromItsReceipts() {
		RegionFluids.BodyState bs = st.states.get("pitA");
		bs.writtenAt = 50;
		bs.writeTxn = "tx-22";
		w.time = 900;
		TxnEntry t = FluidsT5FFixTest.entry("tx-22", FluidTxns.WRITE, List.of(FluidsT5FFixTest.eff(0, "fluid.force", "W", data(0, 0, "pitA"))));
		Effect e = t.effects().get(0);
		FluidTxns.WRITE_KIND.adapter(e).apply(t, e); // the replayed force (its chunk saved with it)
		w.saveAll();
		// a second restart: the record reloads (forcedAt -1), the force receipt probes APPLIED and is never applied again
		RegionFluids.forget(null);
		RegionFluids.Regional st2 = RegionFluids.of(l);
		RegionFluids.BodyState bs2 = st2.states.get("pitA");
		bs2.writtenAt = 50;
		bs2.writeTxn = "tx-22";
		assertEquals(-1L, bs2.forcedAt);
		Method m = method(RegionFluids.class, "settleBase", FluidWorld.class, RegionFluids.Regional.class, RegionFluids.Body.class, RegionFluids.BodyState.class);
		assertEquals(900L, call(m, w, st2, st2.body("pitA"), bs2), "the census counts from the force receipt's t, not writtenAt (P2-c)");
	}

	// ------------------------------------------------------------------ P2-d: the legacy writer is 8cT's whole writer

	@Test
	void p2d_theLegacyWriterWritesDecorAndJoinsTheGrate() {
		BlockState joinedBars = Blocks.IRON_BARS.defaultBlockState().setValue(IronBarsBlock.NORTH, true);
		MemFluidWorld jw = new MemFluidWorld() {
			@Override
			public BlockState joined(long p, BlockState now) {
				return now.is(Blocks.IRON_BARS) ? joinedBars : now;
			}
		};
		RegionFluids.writeBodyV1(jw, st.body("deco"), 0, 0, p -> false);
		assertEquals(WATER, jw.get(DECO_W));
		assertEquals(Blocks.SEAGRASS, jw.get(DECO_D).getBlock(), "8cT's decor pass");
		RegionFluids.writeBodyV1(jw, st.body("gA"), 0, 0, p -> false);
		assertEquals(joinedBars, jw.get(G_A), "8cT's grate joining pass");
	}

	// ------------------------------------------------------------------ P2-e: a partly refused clear still wakes the accepted cells' neighbours

	@Test
	void p2e_aPartlyRefusedClearSchedulesTheAcceptedCellsTicks() {
		w.put(POND_0, WATER);
		w.put(POND_1, WATER);
		st.states.get("pond").before.put(POND_0, "minecraft:air");
		mark(POND_0, FluidProv.Mark.WROTE);
		mark(POND_1, FluidProv.Mark.WROTE);
		w.refuse.add(POND_1);
		TxnEntry t = FluidsT5FFixTest.entry("tx-23", FluidTxns.WRITE, List.of(FluidsT5FFixTest.eff(0, "fluid.clear", "W", data(0, 0, null, "pond"))));
		Effect e = t.effects().get(0);
		assertThrows(RuntimeException.class, () -> FluidTxns.WRITE_KIND.adapter(e).apply(t, e));
		assertEquals(AIR, w.get(POND_0));
		assertEquals(FluidProv.Mark.CLEARED, w.mark(POND_0, rec));
		assertTrue(w.ticksIn(0, 0).contains(POND_1), "the accepted cell's fluid neighbour (the refused cell's water) got its tick before the hold (P2-e)");
	}

	// ------------------------------------------------------------------ the adoption journal filter

	@Test
	void adoptionEvidenceIsTheGroupsActiveFluidsTileEntriesOnly() {
		Method m = method(FluidTxns.TileEntries.class, "evidence", String.class, String.class, boolean.class, String.class, String.class);
		assertEquals(true, call(m, "g1", "g1", true, "fluids|s1|0,0", "fluids"));
		assertEquals(false, call(m, "g1", "g2", true, "fluids|s1|0,0", "fluids"), "another group");
		assertEquals(false, call(m, "g1", "g1", false, "fluids|s1|0,0", "fluids"), "not ACTIVE");
		assertEquals(false, call(m, "g1", "g1", true, "ground|s1|0,0", "fluids"), "a basin's carve (another stage)");
		assertEquals(false, call(m, "g1", "g1", true, null, "fluids"), "not a region tile");
		assertEquals(false, call(m, "g1", "g1", true, "fluids|s1|0,0", "rv2:fluids"), "another revision's fluids");
	}
}
