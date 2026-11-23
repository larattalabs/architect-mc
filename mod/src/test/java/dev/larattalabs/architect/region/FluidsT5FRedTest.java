package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.TxnKind;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T5Fa, failing first: CONTRACT T5F §2-§4, Steward's S1/S3/S4, the coordinator's answers and 8cS Q1-Q3, Noah's N1-N4) Units red on
 * dc814bb1 plus the T5Fa hooks commit: each names the runtime piece T5Fb/T5Fc must build and fails "not built: ..." until it exists. The
 * missing pieces are looked up by reflection, so this file compiles on the base; every one of them runs only with {@code -Dred.T5F=true}
 * (the ordinary build stays green). {@code reading_*} are premise checks (rule 5), green on the base, and always run.
 */
class FluidsT5FRedTest {
	@TempDir
	Path world;

	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	@AfterEach
	void reset() {
		RegionsImpl.dropLive("t5fu");
		RegionFluids.forget(null);
	}

	static void guard() {
		Assumptions.assumeTrue(Boolean.getBoolean("red.T5F"), "T5Fa red record: run with -Dred.T5F=true");
	}

	static Effect effect(String op, String cls) {
		JsonObject o = new JsonObject();
		o.addProperty("i", 0);
		o.addProperty("op", op);
		o.addProperty("class", cls);
		o.add("data", new JsonObject());
		return Effect.fromJson(o);
	}

	static Class<?> cls(String name, String what) {
		try {
			return Class.forName(name, true, FluidsT5FRedTest.class.getClassLoader());
		} catch (ClassNotFoundException e) {
			fail("not built: " + name + " (" + what + ")");
			return null;
		}
	}

	static Method method(Class<?> c, String name, String what, Class<?>... args) {
		try {
			Method m = c.getDeclaredMethod(name, args);
			m.setAccessible(true);
			return m;
		} catch (NoSuchMethodException e) {
			fail("not built: " + c.getSimpleName() + "." + name + " (" + what + ")");
			return null;
		}
	}

	static Object call(Method m, Object self, Object... args) {
		try {
			return m.invoke(self, args);
		} catch (ReflectiveOperationException e) {
			throw new AssertionError(m + ": " + e.getCause(), e);
		}
	}

	/** The kinds FluidTxns declares (static TxnKind fields), by name. */
	static Map<String, TxnKind> kinds() {
		Map<String, TxnKind> out = new java.util.TreeMap<>();
		for (Field f : FluidTxns.class.getDeclaredFields()) {
			if (Modifier.isStatic(f.getModifiers()) && TxnKind.class.isAssignableFrom(f.getType())) {
				try {
					f.setAccessible(true);
					TxnKind k = (TxnKind) f.get(null);
					out.put(k.name(), k);
				} catch (IllegalAccessException e) {
					throw new AssertionError(e);
				}
			}
		}
		return out;
	}

	static TxnKind kind(String name, String what) {
		TxnKind k = kinds().get(name);
		if (k == null) {
			fail("not built: txn kind " + name + " (" + what + "); FluidTxns declares " + kinds().keySet());
		}
		return k;
	}

	@SuppressWarnings({"unchecked", "rawtypes"})
	static Object mark(Class<?> prov, String name) {
		Class<?> m = null;
		for (Class<?> c : prov.getDeclaredClasses()) {
			if (c.getSimpleName().equals("Mark") && c.isEnum()) {
				m = c;
			}
		}
		if (m == null) {
			fail("not built: FluidProv.Mark (WROTE, CLEARED)");
		}
		return Enum.valueOf((Class) m, name);
	}

	// ------------------------------------------------------------------ I1 / §3: the per-cell provenance (N1)

	@Test
	void i1_fluidProvIsAPersistentChunkAttachment() throws ReflectiveOperationException {
		// (T5Fb) read without initializing the store's class: its init registers the attachment, which needs Fabric's mixins (a unit has none)
		Class<?> p = cls("dev.larattalabs.architect.region.FluidProv", "§3.1: architect_mc:fluid_prov, the only write evidence for a fluid cell (N1)");
		assertEquals("architect_mc:fluid_prov", p.getDeclaredField("ID").get(null), "the attachment's id");
		Class<?> store = Class.forName("dev.larattalabs.architect.region.FluidProv$Store", false, FluidsT5FRedTest.class.getClassLoader());
		Field t = store.getDeclaredField("TYPE");
		assertTrue(Modifier.isStatic(t.getModifiers()) && t.getType().getName().endsWith("AttachmentType"), "a static AttachmentType (registered like TestMove.RECEIPTS)");
	}

	@Test
	void i1_cellIndexIsTheContractsPacking() {
		Class<?> p = cls("dev.larattalabs.architect.region.FluidProv", "§3.1");
		Method ci = method(p, "cellIndex", "§3.1: (y - minY) << 8 | lz << 4 | lx", int.class, int.class, int.class, int.class);
		assertEquals((70 - -64) << 8 | 9 << 4 | 3, call(ci, null, -64, 35, 70, -23)); // x 35 -> lx 3, z -23 -> lz 9
		assertEquals(0, call(ci, null, -64, 16, -64, 32));
	}

	@Test
	void i2_theReadTableOfSection33() {
		Class<?> p = cls("dev.larattalabs.architect.region.FluidProv", "§3.3");
		Class<?> m = mark(p, "WROTE").getClass();
		Method read = method(p, "read", "§3.3: one function for the write, the drain and the census -> {write, take, refund}", m, boolean.class,
			boolean.class);
		// rows: (mark, open, ours) -> write, take, refund
		Object[][] rows = {
			{null, true, false, true, false, 1}, // none, open: write; refund 1 (paid, never delivered: P1-1)
			{null, false, false, false, false, 1}, // none, not open: never written (held uncontained); refund 1
			{mark(p, "CLEARED"), true, false, true, false, 1}, // the stage's own clear: written again
			{mark(p, "WROTE"), false, true, false, true, 1}, // standing: no-op; taken by the drain, scooped
			{mark(p, "WROTE"), true, false, false, false, 0}, // harvested: never written again (I2, N3), refund 0 (A)
			{mark(p, "WROTE"), false, false, false, false, 0}, // replaced (obsidian, a foreign block): never, 0
		};
		for (Object[] r : rows) {
			Object cell = call(read, null, r[0], r[1], r[2]);
			String at = "mark " + r[0] + " open " + r[1] + " ours " + r[2];
			assertEquals(r[3], call(method(cell.getClass(), "write", "the row's write"), cell), at + ": write");
			assertEquals(r[4], call(method(cell.getClass(), "take", "the row's drain take"), cell), at + ": take");
			assertEquals(r[5], call(method(cell.getClass(), "refund", "the row's refund on a charged body"), cell), at + ": refund");
		}
	}

	@Test
	void n2_adoptionOfARecordBuiltBeforeT5F() {
		Class<?> p = cls("dev.larattalabs.architect.region.FluidProv", "§4.7 fluid.adopt");
		Method adopt = method(p, "adopt", "N2: (our fluid stands, a tile journal entry is ACTIVE) -> Mark or null", boolean.class, boolean.class);
		assertEquals(mark(p, "WROTE"), call(adopt, null, true, false), "N2 (a): our fluid stands -> WROTE");
		assertEquals(mark(p, "WROTE"), call(adopt, null, false, true), "N2 (b): absent with an ACTIVE entry -> WROTE (harvested: never mints)");
		assertNull(call(adopt, null, false, false), "N2 (c): absent with no entry -> unmarked");
		Method paid = method(p, "mainEraPaid", "N2: a record charged on main (chargedAt) counts every lava and grate body as paid", JsonObject.class);
		JsonObject surv = JsonParser.parseString("{\"charged\":true,\"chargedAt\":1234}").getAsJsonObject();
		assertEquals(true, call(paid, null, surv));
		assertEquals(false, call(paid, null, new JsonObject()));
	}

	// ------------------------------------------------------------------ I3/I4: receipts bound to their mutation, per chunk

	@Test
	void i3_receiptFieldsReader() {
		// (T5F) the pure reader lives in txn.Receipts (TestMove's class init registers its chunk attachment, which a unit can't);
		// TestMove.receiptFields(receipt, key) and receiptFields(ch, key) delegate to it
		Class<?> tm = dev.larattalabs.architect.txn.Receipts.class;
		Method rf = method(tm, "fields", "§4: the per-chunk receipt reader (TestMove.receiptFields(ch, key) reads through it)", String.class,
			String.class);
		@SuppressWarnings("unchecked")
		Map<String, String> f = (Map<String, String>) call(rf, null, "tx-5/2;op=drain;t=100;l=3,1;u=1,0;h=1", "tx-5/2");
		assertEquals("drain", f.get("op"));
		assertEquals("100", f.get("t"));
		assertEquals("3,1", f.get("l"));
		assertEquals("1,0", f.get("u"));
		assertEquals("1", f.get("h"));
		assertEquals(Map.of(), call(rf, null, "tx-5/2", "tx-5/2"), "an old exact-match receipt still probes (no fields)");
		assertNull(call(rf, null, "tx-5/20;op=drain;t=1", "tx-5/2"), "another effect's receipt never matches");
	}

	@Test
	void i4_drainPlansOneWPerBodyAndChunk() {
		
		method(FluidTxns.class, "drainEffects", "§4.3: the drain planned as one W per (body, chunk), reverse write order, each effect's data naming its chunk",
			List.class, List.class);
	}

	// ------------------------------------------------------------------ I5 / N4: the scoop its own txn, after the drain's EFFECTS_DONE

	@Test
	void i5_drainCarriesNoLedgerEffect() {
		
		assertNull(FluidTxns.DRAIN_KIND.adapter(effect("pile.scoop", "L")), "not built: fluid.drain still plans pile.scoop (L) with its Ws (P1-2c)");
	}

	@Test
	void i5_regionScoopIsItsOwnKind() {
		
		TxnKind k = kind("region.scoop", "§4.6 (N4): the scoop's own txn, begun after the drain's EFFECTS_DONE");
		assertNotNull(k.adapter(effect("pile.scoop", "L")), "region.scoop's L: pile.scoop");
	}

	// ------------------------------------------------------------------ I6: physics in W; the other kinds

	@Test
	void i6_writeHasClearPlaceAndForceWs() {
		for (String op : List.of("fluid.clear", "fluid.place", "fluid.force")) {
			assertNotNull(FluidTxns.WRITE_KIND.adapter(effect(op, "W")), "not built: fluid.write's " + op + " W (§4.2)");
		}
	}

	@Test
	void s45_adoptKind() {
		kind("fluid.adopt", "§4.7: the conversion of a record built before T5F (N2)");
	}

	@Test
	void s45_strayKind() {
		kind("fluid.stray", "§4.5: the budgeted stray pass, one txn per at most 8 chunks");
	}

	// ------------------------------------------------------------------ F: the deadline from the receipts, never a stored until

	@Test
	void f_aStoredUntilIsNeverRead() throws IOException {
		
		JsonObject ir = JsonParser.parseString(RegionFluidsTest.IR).getAsJsonObject();
		RegionRec rec = new RegionRec("t5fu", "p1", "sha", "steward", new JsonObject(), "minecraft:overworld", new int[] {0, 60, 0, 15, 90, 15}, 1L);
		RegionsImpl.Live l = new RegionsImpl.Live(rec, Ir.lenient(ir, rec.claim), world);
		JsonObject old = new JsonObject();
		old.addProperty("phase", "settling");
		old.addProperty("removal", "drained");
		old.addProperty("until", 987_654L);
		RegionStore.writeJson(RegionStore.region(world, "t5fu").resolve("fluids.json"), old);
		RegionFluids.Regional st = new RegionFluids.Regional(RegionFluids.bodiesOf(l.ir().json()));
		RegionFluids.load(l, st);
		try {
			Field u = RegionFluids.Regional.class.getDeclaredField("until");
			u.setAccessible(true);
			assertFalse(u.getLong(st) == 987_654L, "not built: the settle deadline still read from fluids.json's until (F; §4.4: max(receipt t) + bound)");
		} catch (NoSuchFieldException e) {
			// T5F dropped the field: nothing stored can be read
		} catch (IllegalAccessException e) {
			throw new AssertionError(e);
		}
	}

	// ------------------------------------------------------------------ Steward S1 / 8cS Q3: "reached (k of n)"

	@Test
	void s1q3_killPointLineNamesProgress() {
		Class<?> kp = dev.larattalabs.architect.txn.KillPoints.class; // (a T4 file: T5Fb adds it after T4 merges)
		method(kp, "step", "S1: a named step with its progress over the named effect's (body, chunk) Ws", String.class, boolean.class, String.class,
			int.class, int.class);
		Method line = method(kp, "reachedLine", "S1/Q3: the log line's text", String.class, int.class, int.class);
		assertEquals("kill point TX:fluid.write:place+save reached (1 of 2)", call(line, null, "TX:fluid.write:place+save", 1, 2),
			"Q3: a pond across one chunk border halts at (1 of 2): n counts the place Ws only, never clear or force");
	}

	// ------------------------------------------------------------------ Steward S4 / 8cS Q2: the typed taken counts

	@Test
	void s4q2_removeResultFluidsTakenAndCells() {
		Class<?> rr = dev.larattalabs.architect.api.RemoveResult.class; // (a T4 file: T5Fc adds them after T4 merges)
		Method taken = method(rr, "fluidsTaken", "S4/Q2: nullable Map<Item,Integer>, what the refund would have paid for the taken cells (report only)");
		Method cells = method(rr, "fluidsTakenCells", "Q2: nullable Integer, Σh: our written cells found taken, water included (report only)");
		assertEquals(Map.class, taken.getReturnType());
		assertEquals(Integer.class, cells.getReturnType());
		Object old = new dev.larattalabs.architect.api.RemoveResult(true, List.of(), Map.of()); // an old constructor
		assertNull(call(taken, old), "an old constructor's fluidsTaken() is null");
		assertNull(call(cells, old), "an old constructor's fluidsTakenCells() is null");
	}

	// ------------------------------------------------------------------ 8cS Q1: the tombstone's final rows

	@Test
	void q1_tombstoneKeepsTheFinalFluidsRows() {
		
		// (Q1) a REMOVED tombstone keeps its last architect_mc:fluids rows, frozen as the removal's last txn wrote done (a capped removal's
		// foreign and foreignCount included); fluidsRemoval goes null, the rows do not. On dc814bb1 the tombstone (removed.json) keeps rows,
		// but stale: every body still reads its placement state (settled), never the removal's (row t5-tombstone). The seam: the rows
		// re-reported and frozen into the record at done, before the tombstone is written.
		method(RegionFluids.class, "freezeRows", "Q1: the final rows written into the record's ext at the removal's done (the tombstone keeps them)",
			RegionsImpl.Live.class, RegionFluids.Regional.class);
	}

	// ------------------------------------------------------------------ readings (rule 5): green on the base

	@Test
	void reading_i6i9_ticksAndAttachmentsShareOneChunkSnapshot() throws IOException {
		Class<?> scd = net.minecraft.world.level.chunk.storage.SerializableChunkData.class;
		List<String> comps = new ArrayList<>();
		for (var c : scd.getRecordComponents()) {
			comps.add(c.getName() + ":" + c.getType().getSimpleName());
		}
		assertTrue(comps.contains("packedTicks:PackedTicks"), "26.3's chunk snapshot carries the scheduled block and fluid ticks: " + comps);
		try (InputStream in = scd.getClassLoader().getResourceAsStream("net/fabricmc/fabric/mixin/attachment/SerializableChunkDataMixin.class")) {
			assertNotNull(in, "Fabric's data attachment mixin into SerializableChunkData is on the classpath");
			String bytes = new String(in.readAllBytes(), StandardCharsets.ISO_8859_1);
			assertTrue(bytes.contains("copyOf"), "Fabric writes a chunk's attachments in SerializableChunkData.copyOf: the same snapshot as its blocks and ticks");
		}
	}
}
