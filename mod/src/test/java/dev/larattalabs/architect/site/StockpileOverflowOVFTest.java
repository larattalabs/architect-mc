package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.StockLedger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.junit.jupiter.api.Test;

/**
 * Slice OVF: a keyed refund's overflow is paid exactly once across any crash. Before, {@code Stockpiles.credit} dropped what didn't fit
 * as item entities before {@code saveCredit} wrote the ledger: a crash at CS1 (the chunks, with the entities, on disk; the ledger not)
 * left the refund pending in the saved ledger and the start booked it again, overflow and all. Now a keyed credit never overflows: all of
 * it enters the stock (past capacity if need be), so the key and the items land in the one ledger write. Each case models the disk as
 * the saved ledger (its JSON) plus the item entities a saved chunk holds, and counts items in = items out. Each failed on main.
 */
class StockpileOverflowOVFTest {
	static final String PLANKS = "minecraft:oak_planks", FLINT = "minecraft:flint", LAVA = "minecraft:lava_bucket", BARS = "minecraft:iron_bars";
	static final ToIntFunction<String> MAX = id -> id.endsWith("bucket") ? 16 : 64;
	/** A full stockpile: no room for anything new. */
	static final int FULL = 0;
	static final String KEY = "site:s1@100", KEY_B = "site:s2@200";
	static final Map<String, Integer> REFUND = Map.of(PLANKS, 80, FLINT, 18);

	/** What a saved world holds: the ledger file and the item entities in its saved chunks. */
	record Disk(JsonObject ledger, Map<String, Integer> entities) {
		StockLedger load() {
			return StockLedger.fromJson(JsonParser.parseString(ledger.toString()).getAsJsonObject());
		}
	}

	static StockLedger paid() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(PLANKS, 80, FLINT, 18), 99, MAX);
		consume(l, KEY, PLANKS, 80);
		consume(l, KEY, FLINT, 18);
		l.giveBack(Map.of(PLANKS, 50, FLINT, 4), 99, MAX);
		consume(l, KEY_B, PLANKS, 50);
		consume(l, KEY_B, FLINT, 4);
		return l;
	}

	static void consume(StockLedger l, String key, String item, int n) {
		assertTrue(l.consume(item, n, 99, MAX, new TreeMap<>()));
		l.pay(key, item, n);
	}

	static Disk save(StockLedger l, Map<String, Integer> entities) {
		return new Disk(JsonParser.parseString(l.toJson().toString()).getAsJsonObject(), new TreeMap<>(entities));
	}

	static Map<String, Integer> plus(Map<String, Integer> a, Map<String, Integer> b) {
		Map<String, Integer> o = new TreeMap<>(a);
		b.forEach((k, v) -> o.merge(k, v, Integer::sum));
		o.values().removeIf(v -> v == 0);
		return o;
	}

	static Map<String, Integer> minus(Map<String, Integer> a, Map<String, Integer> b) {
		Map<String, Integer> o = new TreeMap<>(a);
		b.forEach((k, v) -> o.merge(k, -v, Integer::sum));
		o.values().removeIf(v -> v == 0);
		return o;
	}

	/** What the owner holds: the stock plus the item entities lying in the world. */
	static Map<String, Integer> held(StockLedger l, Map<String, Integer> entities) {
		return plus(l.stock(), entities);
	}

	/**
	 * The keyed credit as Stockpiles.credit runs it: the ledger's credit, then its overflow dropped as entities (into the live world), then
	 * saveCredit. Returns the entities it dropped.
	 */
	static Map<String, Integer> credit(StockLedger l, String key, Map<String, Integer> items, Map<String, Integer> world) {
		StockLedger.Credit c = l.credit(key, items, FULL, MAX);
		c.overflow().forEach((k, v) -> world.merge(k, v, Integer::sum));
		return c.overflow();
	}

	@Test
	void aKeyedCreditIntoAFullStockpileNeverOverflows() {
		StockLedger l = paid();
		Map<String, Integer> before = l.stock();
		StockLedger.Credit c = l.credit(KEY, REFUND, FULL, MAX);
		assertTrue(c.overflow().isEmpty(), "nothing overflows: was " + c.overflow());
		assertEquals(REFUND, c.returned(), "all of it returned, past capacity");
		assertTrue(l.refundOverflow().isEmpty());
		assertEquals(plus(before, REFUND), l.stock());
		assertTrue(l.identityHolds());
		assertTrue(l.usedStacks(MAX) > FULL && l.room(PLANKS, FULL, MAX) == 0, "over capacity: nothing new enters until it fits");
		// a delta's refund and a non-target key the same (custody included)
		StockLedger d = paid();
		assertTrue(d.credit("delta:e1:s1", Map.of(PLANKS, 10), FULL, MAX).overflow().isEmpty());
		d.holdCustody("fluid:f1", Map.of(FLINT, 3));
		StockLedger.Credit f = d.credit("fluid:f1", Map.of(), FULL, MAX);
		assertEquals(Map.of(FLINT, 3), f.returned());
		assertTrue(f.overflow().isEmpty() && d.identityHolds());
		// an unkeyed give-back (a swap's old block) still overflows as before (out of scope)
		assertFalse(paid().giveBack(Map.of(PLANKS, 5), FULL, MAX).overflow().isEmpty());
	}

	/** K0 / K1 / CS1 / K2: a crash at every point of the keyed credit's handoff. */
	@Test
	void aCrashAtEveryPointPaysTheRefundOnce() {
		for (String at : new String[] {"K0", "K1", "CS1", "K2"}) {
			StockLedger l = paid();
			l.holdPending(KEY, REFUND, 1L); // (J2) saved before the removal's commit
			Map<String, Integer> world = new TreeMap<>();
			Disk disk = save(l, world);
			Map<String, Integer> start = held(disk.load(), disk.entities());
			if (!at.equals("K0")) {
				credit(l, KEY, REFUND, world);
				if (at.equals("CS1")) {
					disk = new Disk(disk.ledger(), world); // the chunks (with any entity) saved, the ledger not
				} else if (at.equals("K2")) {
					disk = save(l, world);
				}
			}
			// the start: settlePendingCredits books what the saved ledger still holds pending (the site settled removed)
			StockLedger r = disk.load();
			Map<String, Integer> w = new TreeMap<>(disk.entities());
			if (r.pendingKeys().contains(KEY)) {
				credit(r, KEY, r.pendingItems(KEY), w);
			}
			assertTrue(r.credited(KEY), at);
			assertEquals(plus(start, REFUND), held(r, w), at + ": the refund paid once (stock + entities)");
			assertTrue(w.isEmpty(), at + ": no item entity");
		}
	}

	/** A refused save (SS), then the start; and a second crash inside the start's own settle save. */
	@Test
	void aRefusedSaveAndASecondCrashDuringRecoveryPayOnce() {
		StockLedger l = paid();
		l.holdPending(KEY, REFUND, 1L);
		Map<String, Integer> world = new TreeMap<>();
		Disk disk = save(l, world);
		Map<String, Integer> start = held(disk.load(), world);
		credit(l, KEY, REFUND, world); // its save refused: the disk keeps the pending ledger
		// first start: booked, then a crash inside its settle save after the chunks
		StockLedger r1 = disk.load();
		Map<String, Integer> w1 = new TreeMap<>(disk.entities());
		credit(r1, KEY, r1.pendingItems(KEY), w1);
		disk = new Disk(disk.ledger(), w1);
		// second start: booked again from the same pending, saved
		StockLedger r2 = disk.load();
		Map<String, Integer> w2 = new TreeMap<>(disk.entities());
		credit(r2, KEY, r2.pendingItems(KEY), w2);
		disk = save(r2, w2);
		StockLedger r3 = disk.load();
		assertTrue(r3.pendingKeys().isEmpty() && r3.credited(KEY));
		assertEquals(plus(start, REFUND), held(r3, disk.entities()), "paid once across a refusal and two crashes");
		assertTrue(disk.entities().isEmpty());
	}

	/** A second debt B booked in memory (its save refused) while A recovers: B's key and its stock are in the same ledger write. */
	@Test
	void anUnsavedSecondDebtDuringRecoveryIsNeverPaidOnDisk() {
		StockLedger l = paid();
		l.holdPending(KEY, REFUND, 1L);
		Disk disk = save(l, Map.of());
		Map<String, Integer> start = held(disk.load(), Map.of());
		StockLedger r = disk.load();
		Map<String, Integer> w = new TreeMap<>();
		credit(r, KEY, r.pendingItems(KEY), w); // A settles at the start
		credit(r, KEY_B, Map.of(PLANKS, 50, FLINT, 4), w); // B: its removal's save refused (the world write and the ledger both lost)
		disk = new Disk(disk.ledger(), w); // a crash inside the settle save after its chunks
		StockLedger again = disk.load();
		assertFalse(again.credited(KEY_B), "B never on disk");
		assertTrue(disk.entities().isEmpty(), "and nothing of it lies in the saved chunks");
		Map<String, Integer> w2 = new TreeMap<>();
		credit(again, KEY, again.pendingItems(KEY), w2);
		assertEquals(plus(start, REFUND), held(again, w2), "A once, B not at all (its removal never committed)");
	}

	/** Dissolving a stockpile whose stock is over capacity: all of it goes out (nothing owed is erased). */
	@Test
	void dissolvingAPileOverCapacityPaysOutAllOfIt() {
		StockLedger l = paid();
		l.credit(KEY, REFUND, FULL, MAX);
		Map<String, Integer> stock = l.stock();
		Map<String, Integer> toPlayer = new TreeMap<>(), toGround = new TreeMap<>();
		Map<String, Integer> out = Stockpiles.dissolveLedger(l, (item, n) -> item.equals(PLANKS) ? 30 : 0, toPlayer, toGround);
		assertEquals(stock, out);
		assertEquals(stock, plus(toPlayer, toGround), "the player's share and the ground's: the whole stock");
		assertTrue(l.stock().isEmpty() && l.identityHolds());
		StockLedger g = paid();
		g.credit(KEY, REFUND, FULL, MAX);
		Map<String, Integer> s2 = g.stock(), ground = new TreeMap<>();
		Stockpiles.dissolveLedger(g, null, new TreeMap<>(), ground);
		assertEquals(s2, ground);
	}

	/** A player takes the excess between crashes: the Take (ledger saved first) and nothing on the ground to pick up twice. */
	@Test
	void aPlayerTakingTheExcessBetweenCrashesKeepsItemsInEqualOut() {
		StockLedger l = paid();
		l.holdPending(KEY, REFUND, 1L);
		Disk disk = save(l, Map.of());
		Map<String, Integer> start = held(disk.load(), Map.of());
		StockLedger r = disk.load();
		Map<String, Integer> w = new TreeMap<>();
		credit(r, KEY, r.pendingItems(KEY), w); // first start books it; a crash inside its save after the chunks
		disk = new Disk(disk.ledger(), w);
		assertTrue(disk.entities().isEmpty(), "nothing for a player to collect");
		StockLedger r2 = disk.load();
		Map<String, Integer> w2 = new TreeMap<>(disk.entities());
		credit(r2, KEY, r2.pendingItems(KEY), w2);
		int took = r2.withdraw(PLANKS, 40); // the player's Take (Stockpiles.withdraw: credit, the ledger saved before the player)
		Map<String, Integer> player = Map.of(PLANKS, took);
		disk = save(r2, w2);
		StockLedger r3 = disk.load();
		assertEquals(plus(start, REFUND), plus(held(r3, disk.entities()), player), "stock + entities + the player = once");
	}

	/** The keyed region charge (a lava bucket's empty bucket) and scoop into a full stockpile: stocked, once across a crash. */
	@Test
	void aKeyedRegionChargeAndScoopNeverOverflow() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(LAVA, 2, "minecraft:bucket", 3), 99, MAX);
		Disk disk = save(l, Map.of());
		Map<String, Integer> over = new TreeMap<>();
		assertTrue(l.chargeOnce("region:r1@1:bodies", Map.of(LAVA, 2), 1, FULL, MAX, over));
		assertTrue(over.isEmpty(), "the charge's empty buckets enter the stock: was " + over);
		assertEquals(5, l.stock("minecraft:bucket"));
		// a crash before the charge's save: replayed once from the saved ledger
		StockLedger r = disk.load();
		assertTrue(r.chargeOnce("region:r1@1:bodies", Map.of(LAVA, 2), 1, FULL, MAX, over) && over.isEmpty());
		assertFalse(r.chargeOnce("region:r1@1:bodies", Map.of(LAVA, 2), 1, FULL, MAX, over), "once");
		assertEquals(Map.of("minecraft:bucket", 5), r.stock());
		StockLedger.Credit c = Stockpiles.scoopInto(r, "region:r1@1:fluids", 2, 3, FULL, MAX, over);
		assertTrue(over.isEmpty() && c.overflow().isEmpty(), "the scoop's lava buckets and bars too");
		assertEquals(Map.of(LAVA, 2, BARS, 3), c.returned());
		assertTrue(r.identityHolds());
		// an unkeyed consume's bucket still overflows (the feed's pay: out of scope)
		StockLedger u = new StockLedger();
		u.giveBack(Map.of(LAVA, 1), 99, MAX);
		Map<String, Integer> o2 = new TreeMap<>();
		u.consume(LAVA, 1, FULL, MAX, o2);
		assertEquals(Map.of("minecraft:bucket", 1), o2);
	}

	/** Adoption into a pile a refund left over capacity drops the adopted crate's stock (as for any full pile): booked, identity holds. */
	@Test
	void adoptionIntoAPileOverCapacityDropsWhatCameIn() {
		StockLedger l = paid();
		l.credit(KEY, REFUND, FULL, MAX);
		Map<String, Integer> before = l.stock();
		Map<String, Integer> dropped = l.adopt("adopt:c1@0", Map.of(FLINT, 10), Map.of(), 1, MAX);
		assertEquals(Map.of(FLINT, 10), dropped);
		assertEquals(before, l.stock());
		assertTrue(l.identityHolds());
	}

	/** A forced crate removal on a pile a refund left over capacity drops the least stock within the capacity left (the existing rule). */
	@Test
	void aForcedCrateRemovalOverCapacityDropsWithinTheCapacityLeft() {
		StockLedger l = paid();
		l.credit(KEY, REFUND, FULL, MAX);
		Map<String, Integer> drop = Stockpiles.excess(l, 1, MAX);
		drop.forEach(l::drop);
		assertTrue(l.usedStacks(MAX) <= 1 && l.identityHolds(), "within the capacity left: " + l.stock());
		assertEquals(plus(drop, l.stock()), minus(plus(paid().stock(), REFUND), Map.of()), "dropped + left = the stock before");
	}

	/** The over-capacity state is visible: the pile's count line says so, and a player's refused insert gets the message (hoppers silent). */
	@Test
	void theOverCapacityStateIsVisible() throws Exception {
		assertEquals("27 of 27 stacks", Stockpiles.capacityLabel(27, 27));
		assertEquals("31 of 27 stacks · over capacity", Stockpiles.capacityLabel(31, 27));
		assertEquals("This stockpile is over capacity: use or take stock first", Stockpiles.OVER_CAPACITY);
		String b = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		int ins = b.indexOf("public static int insertFromInventory(ServerPlayer player, String id)");
		int thr = b.indexOf("throw new Sites.SiteException(Stockpiles.OVER_CAPACITY);", ins);
		assertTrue(ins > 0 && thr > ins && thr < b.indexOf("Site s = requireBuilding(id);", ins), "a player's insert into a pile over capacity is refused with the message");
		String cb = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/survival/CrateBlockEntity.java"));
		assertFalse(cb.contains("OVER_CAPACITY"), "a hopper's refusal stays silent (canPlaceItem false)");
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		assertTrue(sp.contains("o.addProperty(\"overCapacity\", overCapacity(srv, p));"), "the pile's view carries the state");
		String screen = Files.readString(Path.of("src/client/java/dev/larattalabs/architect/client/survival/CrateScreen.java"));
		assertTrue(screen.contains("Stockpiles.capacityLabel("), "the stockpile panel shows the label");
	}

	// ------------------------------------------------------------------ the GPT review's fix round (OVF NOT SAFE)

	/** Round 4 finding 2: a caller never settles a record from an unsaved in-memory charge (RegionFluids, MechCharges). */
	@Test
	void aBookedChargeIsSettledOnlyFromALedgerOnDisk() throws Exception {
		String rf = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/region/RegionFluids.java"));
		int gate = rf.indexOf("booked.ledger().charged(chargeKey(l)) != null && !dev.larattalabs.architect.site.Stockpiles.ledgerOnDisk(s)");
		int settle = rf.indexOf("settleBooked(l, booked.ledger(), level.getGameTime())");
		assertTrue(gate > 0 && settle > gate, "the fluids' booked charge waits for a confirmed save before it is settled");
		String mc = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/MechCharges.java"));
		int g2 = mc.indexOf("if (booked != null && !Stockpiles.ledgerOnDisk(srv)) {");
		int s2 = mc.indexOf("settle(e, booked, now);");
		assertTrue(g2 > 0 && s2 > g2, "a mechanism's booked charge too");
		String atStart = body(mc, "public static void settleBooked(MinecraftServer srv) {");
		assertTrue(atStart.indexOf("Stockpiles.ledgerOnDisk(srv)") < atStart.indexOf("RegionFluids.settleBooked("), "and the start's");
		java.lang.reflect.Field lf = Stockpiles.class.getDeclaredField("loadFailed");
		lf.setAccessible(true);
		boolean wasUnsaved = Stockpiles.unsaved;
		try {
			Stockpiles.unsaved = false;
			assertTrue(Stockpiles.ledgerOnDisk(null));
			lf.set(null, true);
			Stockpiles.unsaved = true;
			assertFalse(Stockpiles.ledgerOnDisk(null), "not on disk: the caller waits");
		} finally {
			lf.set(null, false);
			Stockpiles.unsaved = wasUnsaved;
		}
	}

	/** Finding 2: a keyed booking's retry never trusts an unsaved in-memory key: it saves first (and throws while nothing can be saved). */
	@Test
	void aKeyedRetryAfterARefusedSaveSavesFirst() throws Exception {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String scoop = body(sp, "public static Map<String, Integer> scoop(");
		int early = scoop.indexOf("if (p.ledger.credited(key)) {");
		assertTrue(early > 0 && scoop.indexOf("saveConfirmed(srv);", early) > early && scoop.indexOf("saveConfirmed(srv);", early) < scoop.indexOf("return Map.of();", early),
			"the scoop's retry saves before it returns");
		assertTrue(scoop.contains("saveConfirmed(srv); // (OVF) the caller persists the drain"), "the scoop's booking is confirmed on disk");
		String charge = body(sp, "public static boolean charge(MinecraftServer srv, @Nullable String owner, Map<String, Integer> items, @Nullable String key, int rid) {");
		int ce = charge.indexOf("if (key != null && p.ledger.charged(key) != null) {");
		assertTrue(ce > 0 && charge.indexOf("saveConfirmed(srv);", ce) < charge.indexOf("return true;", ce), "a keyed charge's retry saves before it returns");
		assertTrue(charge.contains("saveConfirmed(srv); // (OVF) keyed"), "a keyed charge is confirmed on disk");
		// saveConfirmed: nothing unsaved passes; a session that can't save throws (the caller's drained/charged record is never written)
		java.lang.reflect.Field lf = Stockpiles.class.getDeclaredField("loadFailed");
		lf.setAccessible(true);
		boolean wasUnsaved = Stockpiles.unsaved;
		try {
			Stockpiles.unsaved = false;
			Stockpiles.saveConfirmed(null);
			lf.set(null, true);
			Stockpiles.unsaved = true;
			assertThrows(IllegalStateException.class, () -> Stockpiles.saveConfirmed(null));
		} finally {
			lf.set(null, false);
			Stockpiles.unsaved = wasUnsaved;
		}
	}

	/** Should-fix 3: over capacity, an active build's missing item still goes in (up to its need); a paused-only need and the rest are refused. */
	@Test
	void anActiveBuildNeverDeadlocksOverCapacity() {
		String STONE = "minecraft:stone";
		StockLedger l = new StockLedger();
		// the review's case: refunds left 500 stacks of planks in a 432-stack (16 crate) pile; two active targets need stone supports first
		l.holdCustody("fluid:f9", Map.of(PLANKS, 500 * 64));
		l.credit("fluid:f9", Map.of(), 432, MAX);
		assertTrue(l.usedStacks(MAX) > 432);
		dev.larattalabs.architect.survival.Equivalents eq = dev.larattalabs.architect.survival.Equivalents.bundled();
		ToIntFunction<String> all = it -> it.equals(STONE) ? 20 : it.equals(PLANKS) ? 500 * 64 : it.equals(FLINT) ? 5 : 0;
		ToIntFunction<String> active = it -> it.equals(STONE) ? 20 : it.equals(PLANKS) ? 500 * 64 : 0; // the flint: a paused target's only
		assertEquals(null, l.accept(STONE, all, eq, 432, MAX, false), "the old rule: refused, the build deadlocks");
		int in = 0;
		while (l.accept(STONE, all, active, eq, 432, MAX, true) != null) {
			in++;
		}
		assertEquals(20, in, "the active builds' stone goes in, up to what they miss");
		assertEquals(null, l.accept(FLINT, all, active, eq, 432, MAX, false), "a paused target's need waits");
		assertEquals(null, l.accept("minecraft:dirt", all, active, eq, 432, MAX, false), "nothing else");
		assertTrue(l.identityHolds());
	}

	/** No keyed path drops overflow before (or after) its save. */
	@Test
	void noKeyedPathDropsOverflow() throws Exception {
		String s = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String credit = body(s, "static StockLedger.Credit credit(MinecraftServer srv, Pile p, String key, Map<String, Integer> items, BlockPos fallback) {");
		assertFalse(credit.contains("dropOverflow"), "credit");
		String scoop = body(s, "public static Map<String, Integer> scoop(");
		assertFalse(scoop.contains("dropOverflow"), "scoop");
		String charge = s.substring(s.indexOf("p.ledger.chargeOnce(key, items, rid"), s.indexOf("} else {", s.indexOf("p.ledger.chargeOnce(key, items, rid")));
		assertFalse(charge.contains("dropOverflow"), "the keyed charge");
	}

	private static String body(String s, String head) {
		int at = s.indexOf(head);
		assertTrue(at >= 0, head);
		int end = s.indexOf("\n\t}\n", at);
		return s.substring(at, end);
	}
}
