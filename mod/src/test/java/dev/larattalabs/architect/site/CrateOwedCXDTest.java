package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.site.CrateOwed.CrateState;
import dev.larattalabs.architect.site.CrateOwed.Outcome;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * Slice CXD (docs/CONTRACT.md "Slice CXD", fix round): a crate's stock a removal takes is paid exactly once (or stays in the crate) across
 * a crash at every step, with no loss window. A crash simulator over the stores the code writes separately (the chunk with the crate,
 * the entity file with the drops, the stockpiles file with the owed record, the group queue), each saved as the code saves it, with an
 * autosave (chunks + ledger) at any tick boundary before the crash; then the restart (the real {@link CrateOwed#resolve} table, a tagged
 * drop found when its entities load). Counted: the crate's stock + tagged drops + the member's ordinary refunds + what the builder placed.
 * The flows before this round (the pre-fix order) are kept and shown red on the same points (failing-first).
 */
class CrateOwedCXDTest {
	static final int S = 40; // the crate's stock
	static final int R = 8; // the member's ordinary refunds (8 paid blocks standing)

	/** One side of the world: in memory or on disk. */
	static final class World {
		boolean crate = true; // the crate block stands
		int stock = S; // the crate's stock
		boolean marked; // its CxdTaken marker
		int tagged; // the record's tagged drop on the ground (the entity file)
		int ground; // other items on the ground (an untagged drop, the member's refunds)
		boolean record; // the owed record open (the stockpiles file)
		int recordItems;
		boolean committed; // the removal's undo committed (the journal: durable at once)
		boolean queued = true; // the member still in the group's queue (its restore and refunds to come)
		int placed; // the stock the builder consumed into blocks (a standing site that went on building)
		boolean built; // the site completed (its crate cell restored)

		World copy() {
			World w = new World();
			w.crate = crate;
			w.stock = stock;
			w.marked = marked;
			w.tagged = tagged;
			w.ground = ground;
			w.record = record;
			w.recordItems = recordItems;
			w.committed = committed;
			w.queued = queued;
			w.placed = placed;
			w.built = built;
			return w;
		}

		int items() {
			return (crate ? stock : 0) + tagged + ground + placed;
		}
	}

	/** Memory and disk; the chunk + entities, the ledger and the queue are three separate writes. */
	static final class Sim {
		final World mem = new World();
		final World disk = new World();
		boolean consumeWhileFenced; // the pre-fix: no fence, the builder consumes a crate whose record may be on disk

		void chunks() {
			disk.crate = mem.crate;
			disk.stock = mem.stock;
			disk.marked = mem.marked;
			disk.tagged = mem.tagged;
			disk.ground = mem.ground;
			disk.placed = mem.placed;
			disk.built = mem.built;
		}

		void ledger() {
			disk.record = mem.record;
			disk.recordItems = mem.recordItems;
		}

		void queue() {
			disk.queued = mem.queued;
		}

		void commit() {
			mem.committed = true;
			disk.committed = true;
		}

		/** T0's barrier: the players, the chunks, then the ledger (a crash between is a separate kill point). */
		void barrier(List<Step> st) {
			st.add(new Step("barrier: chunks", false, x -> x.chunks()));
			st.add(new Step("barrier: ledger", false, x -> x.ledger()));
		}
	}

	/** A step; {@code boundary}: a tick ends after it (an autosave may run there). */
	record Step(String what, boolean boundary, Consumer<Sim> run) {
	}

	/** The CXD group member's flow as built: capture, barrier, take, commit; settle FIRST (tagged drop, closed, barrier, the cell); then the restore and refunds. */
	static List<Step> cxd(Sim s) {
		List<Step> st = new ArrayList<>();
		st.add(new Step("capture", false, x -> {
			x.mem.record = true;
			x.mem.recordItems = x.mem.stock;
		}));
		s.barrier(st);
		st.add(new Step("take (CXD2->CXD3)", true, x -> {
			x.mem.stock = 0;
			x.mem.marked = true;
		}));
		st.add(new Step("commit", true, Sim::commit));
		st.add(new Step("settle: tagged drop, record closed (CXDS)", false, x -> {
			x.mem.tagged += x.mem.recordItems;
			x.mem.record = false;
		}));
		s.barrier(st);
		st.add(new Step("settle: the cell restored", true, x -> x.mem.crate = false));
		st.add(new Step("member: restore + its refunds", false, x -> x.mem.ground += R));
		st.add(new Step("its chunks saved, then the queue without the member (the refunds' own, pre-existing order)", true, x -> {
			x.chunks();
			x.mem.queued = false;
			x.queue();
		}));
		return st;
	}

	/** The pre-fix flow (1e8d53fe): the member's refunds first, then the settle, which records closed on disk before the drop (CXDS's loss). */
	static List<Step> prefix(Sim s) {
		List<Step> st = new ArrayList<>();
		st.add(new Step("capture", false, x -> {
			x.mem.record = true;
			x.mem.recordItems = x.mem.stock;
		}));
		s.barrier(st);
		st.add(new Step("take", true, x -> {
			x.mem.stock = 0;
			x.mem.marked = true;
		}));
		st.add(new Step("commit", true, Sim::commit));
		st.add(new Step("member: restore + its refunds", false, x -> x.mem.ground += R));
		st.add(new Step("settle: closed", false, x -> x.mem.record = false));
		s.barrier(st); // its barrier persists the refunds too, while the member is still queued
		st.add(new Step("settle: dropped", false, x -> {
			x.mem.ground += x.mem.recordItems;
			x.mem.crate = false;
		}));
		st.add(new Step("chunks", true, Sim::chunks));
		st.add(new Step("queue saved without the member", true, x -> {
			x.mem.queued = false;
			x.queue();
		}));
		return st;
	}

	/** The restart: the record resolved (a tagged drop on disk is found); a still-queued committed member resumes and is written again. */
	static void restart(World d, boolean cxd) {
		if (d.record) {
			boolean found = cxd && d.tagged > 0;
			CrateState st = !d.crate ? CrateState.ABSENT : d.marked ? CrateState.MARKED : CrateState.PRESENT;
			boolean stands = !d.committed;
			Outcome o = cxd ? CrateOwed.resolve(stands, st, found) : oldResolve(stands, st);
			if (o.putBack()) {
				d.stock += d.recordItems;
				d.marked = false;
			}
			if (o.retake() && d.crate) {
				d.recordItems = d.stock; // its stock into the record (marked), then dropped
				d.stock = 0;
				d.marked = true;
			}
			if (o.drop()) {
				if (cxd) {
					d.tagged += d.recordItems;
				} else {
					d.ground += d.recordItems;
				}
			}
			if (o.restoreCell()) {
				d.crate = false;
			}
			if (found && stands) {
				d.marked = false;
			}
			d.record = false;
		}
		if (d.committed && d.queued) {
			d.ground += cxd ? R : R; // the resumed member writes its restore and drops its refunds (decItems) again
			d.queued = false;
		}
	}

	/** The pre-fix table: drops paid the record and the crate's own stock (no retake, no found). */
	static Outcome oldResolve(boolean stands, CrateState c) {
		return switch (c) {
			case MARKED -> stands ? new Outcome(true, false, false, false) : new Outcome(false, false, true, true);
			case PRESENT -> stands ? new Outcome(false, false, false, false) : new Outcome(false, true, true, true);
			case ABSENT -> new Outcome(false, false, true, false);
		};
	}

	/** Runs {@code flow} to step {@code kill} (exclusive), an autosave (chunks + ledger) after the boundary step {@code auto} (-1: none). */
	static World crash(java.util.function.Function<Sim, List<Step>> flow, int kill, int auto) {
		Sim s = new Sim();
		List<Step> st = flow.apply(s);
		for (int i = 0; i < kill; i++) {
			st.get(i).run().accept(s);
			if (i == auto) {
				s.chunks();
				s.ledger();
			}
		}
		return s.disk.copy();
	}

	static List<int[]> points(java.util.function.Function<Sim, List<Step>> flow) {
		List<Step> st = flow.apply(new Sim());
		List<int[]> out = new ArrayList<>();
		for (int kill = 0; kill <= st.size(); kill++) {
			out.add(new int[] {kill, -1});
			for (int auto = 0; auto < kill; auto++) {
				if (st.get(auto).boundary()) {
					out.add(new int[] {kill, auto});
				}
			}
		}
		return out;
	}

	/** Whether the restart after a crash at a point reaches S + R exactly (the member's refunds counted once it was committed). */
	static int expected(World d) {
		return S + (d.committed ? R : 0);
	}

	@Test
	void theTable() {
		assertTrue(CrateOwed.resolve(true, CrateState.MARKED).putBack(), "standing, taken: put back");
		assertEquals(new Outcome(false, false, false, false), CrateOwed.resolve(true, CrateState.PRESENT), "standing, not taken: closed");
		assertTrue(CrateOwed.resolve(true, CrateState.ABSENT).drop(), "standing, the crate gone after the take: dropped once");
		Outcome gone = CrateOwed.resolve(false, CrateState.MARKED);
		assertTrue(gone.drop() && gone.restoreCell() && !gone.putBack() && !gone.retake(), "removed, taken: the record's stock, the cell");
		Outcome gp = CrateOwed.resolve(false, CrateState.PRESENT);
		assertTrue(gp.retake() && gp.drop() && gp.restoreCell(), "removed, not taken: retaken into the record first, then dropped");
		assertTrue(CrateOwed.resolve(false, CrateState.ABSENT).drop(), "removed, the cell restored: the record's stock");
		for (CrateState c : CrateState.values()) {
			for (boolean stands : new boolean[] {true, false}) {
				Outcome f = CrateOwed.resolve(stands, c, true);
				assertTrue(!f.drop() && !f.putBack() && !f.retake(), "its tagged drop found on disk: nothing paid again (" + c + ", stands " + stands + ")");
			}
		}
	}

	/** (P1-1, P1-4) Every kill point, every autosave at a tick boundary before it: crate + drops + refunds = S + R once, never a loss. */
	@Test
	void everyKillPointPaysOnceWithNoLossWindow() {
		for (int[] p : points(CrateOwedCXDTest::cxd)) {
			World d = crash(CrateOwedCXDTest::cxd, p[0], p[1]);
			restart(d, true);
			String at = "CXD flow killed after step " + p[0] + ", autosave after " + p[1];
			assertEquals(expected(d), d.items(), at + ": paid once (crate " + (d.crate ? d.stock : 0) + ", tagged " + d.tagged + ", ground " + d.ground + ")");
			assertFalse(d.crate && d.marked && d.stock == 0 && !d.record && !d.committed, at + ": no marked crate left on a standing site");
		}
	}

	/** The pre-fix flow, the same points: the member's refunds doubled (P1-1) and the stock lost at CXDS (P1-4) are found. */
	@Test
	void thePreFixFlowIsRedAtTheReviewPoints() {
		boolean doubled = false, lost = false;
		for (int[] p : points(CrateOwedCXDTest::prefix)) {
			World d = crash(CrateOwedCXDTest::prefix, p[0], p[1]);
			restart(d, false);
			doubled |= d.items() > expected(d);
			lost |= d.items() < expected(d);
		}
		assertTrue(doubled, "pre-fix: a crash after the settle's barrier saved the member's refunds while it was still queued doubles them");
		assertTrue(lost, "pre-fix: a crash after the closing ledger write and before the drop's chunks loses the stock");
	}

	/** A second crash during the restart's resolution: its own saves (barrier: chunks, then ledger) killed between; resolved again, once. */
	@Test
	void aSecondCrashDuringResolution() {
		for (int[] p : points(CrateOwedCXDTest::cxd)) {
			World d = crash(CrateOwedCXDTest::cxd, p[0], p[1]);
			World r = d.copy();
			restart(r, true);
			World half = d.copy(); // the resolution's chunks (the drop, the crate) on disk, its ledger (the record closed) not
			half.crate = r.crate;
			half.stock = r.stock;
			half.marked = r.marked;
			half.tagged = r.tagged;
			half.ground = r.ground;
			half.queued = r.queued;
			restart(half, true);
			assertEquals(expected(d), half.items(), "killed after " + p[0] + " (autosave " + p[1] + "), again mid-resolution: once");
		}
	}

	/**
	 * (P1-2, P1-4) Play after a failed barrier: the settle's barrier refused, the tagged drop is taken back (discarded) and the record reopens;
	 * the crate stays fenced (no consumption), the orphan right-click resolves the same record; the next barrier pays it once.
	 */
	@Test
	void aFailedBarrierTakesTheDropBackAndPlayGoesOn() {
		Sim s = new Sim();
		List<Step> st = cxd(s);
		for (int i = 0; i < 5; i++) {
			st.get(i).run().accept(s); // to the commit
		}
		// the settle: dropped (tagged) and closed in memory, the barrier's chunks written, its ledger refused (IN_DOUBT or REFUSED)
		s.mem.tagged += s.mem.recordItems;
		s.mem.record = false;
		s.chunks();
		s.mem.tagged -= s.mem.recordItems; // taken back: discarded
		s.mem.record = true;
		// play goes on: the group holds the member (nothing of it written); a fenced crate feeds nothing; an orphan click resolves the record
		assertEquals(S, s.mem.items() + (s.mem.record ? s.mem.recordItems : 0), "in memory: owed once (the record), nothing on the ground");
		World crashNow = s.disk.copy(); // a crash now: the tagged drop on disk, the record open on disk -> found, nothing again
		restart(crashNow, true);
		assertEquals(S + R, crashNow.items(), "a crash after the refused barrier: its drop found, paid once (and the member's refunds once)");
		s.mem.tagged += s.mem.recordItems; // the retry: dropped, closed, the barrier OK
		s.mem.record = false;
		s.chunks();
		s.ledger();
		World after = s.disk.copy();
		restart(after, true);
		assertEquals(S + R, after.items(), "the retry pays once");
	}

	/**
	 * (P1-3) A capture whose save was IN_DOUBT: possibly on disk. The pre-fix forgot it in memory and let the site build on (consume, complete)
	 * before the cancel was saved: a crash paid the consumed stock again. As built: kept open and fenced until a confirmed cancel.
	 */
	@Test
	void anInDoubtCaptureIsFencedUntilItsCancelIsConfirmed() {
		for (boolean fenced : new boolean[] {true, false}) {
			for (boolean landed : new boolean[] {true, false}) {
				Sim s = new Sim();
				s.mem.record = true;
				s.mem.recordItems = S;
				s.chunks();
				if (landed) {
					s.ledger(); // the IN_DOUBT write did reach the disk
				}
				s.mem.record = !fenced ? false : true; // pre-fix: dropped from memory at once; as built: kept, cancelled only when confirmed
				if (!fenced) {
					s.mem.placed = S; // it builds on: the stock consumed, the site completed (its crate cell restored)
					s.mem.stock = 0;
					s.mem.built = true;
					s.mem.crate = false;
					s.chunks(); // an autosave of the world, not yet of the cancel
				}
				World d = s.disk.copy();
				restart(d, true);
				if (fenced) {
					assertEquals(S, d.items(), "fenced (landed " + landed + "): nothing consumed until the cancel is confirmed; once");
				} else if (landed) {
					assertTrue(d.items() > S, "pre-fix (landed): the consumed stock paid again by the stale record (red)");
				}
			}
		}
	}

	/** A removal that ends before its commit (a refused save, Groups.end before its R2) puts the stock back. */
	@Test
	void aRefusedRemovalPutsBack() {
		for (int kill = 4; kill >= 1; kill--) {
			Sim s = new Sim();
			List<Step> st = cxd(s);
			for (int i = 0; i < kill; i++) {
				st.get(i).run().accept(s);
			}
			World m = s.mem;
			if (m.record) {
				restart(m, true); // putBackSites: resolved as standing, in this session
			}
			assertEquals(S, m.crate ? m.stock : 0, "ended after step " + kill + ": the crate holds its stock again");
			assertFalse(m.marked || m.record, "ended after step " + kill + ": no marker, no record");
		}
	}

	/** Source checks: the settle runs before a member's restore and refunds; the orphan click consults the records; no loss concession. */
	@Test
	void theSettleComesFirstAndTheOrphanClickConsultsTheRecords() throws Exception {
		String g = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java"));
		int st = g.indexOf("CrateOwed.settle(level, Builder.creditKey(s), null)");
		assertTrue(st > 0 && st < g.indexOf("Sites.finishGroupDeconstruct(level, s,", st), "Groups: the settle before the member's restore and refunds");
		String si = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Sites.java"));
		int ss = si.indexOf("CrateOwed.settle(level, Builder.creditKey(x), drops)");
		assertTrue(ss > 0 && ss < si.indexOf("SiteJournal.writeNow(level, x.id(), group)", ss), "removeDetailed: the settle before the restore");
		assertFalse(si.substring(si.indexOf("static Removed finishGroupDeconstruct(")).substring(0, 2000).contains("CrateOwed.settle("),
			"finishGroupDeconstruct no longer settles after the refunds");
		String b = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		int oc = b.indexOf("public static void openCrate(");
		int claim = b.indexOf("CrateOwed.claimOrphan(level, crate)", oc);
		assertTrue(claim > 0 && claim < b.indexOf("crate.ledger().takeStock()", oc), "the orphan click consults the owed records before it takes anything");
		String c = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/CrateOwed.java"));
		assertFalse(c.contains("Stockpiles.save();"), "no ledger-only write closes a record ahead of its drop");
	}

	@Test
	void theQueueCarriesNoCrateStock() throws Exception {
		var t = new dev.larattalabs.architect.survival.Refunds.Tally();
		var d = new Builder.Deconstruction(t, Map.of("minecraft:oak_planks", S), net.minecraft.core.BlockPos.ZERO, 0, 0, null, null, "crate:k");
		assertTrue(d.all().isEmpty(), "an owed stock is not in what drops with the deconstruct (nor in the queue's decItems)");
		assertEquals(S, d.reported().get("minecraft:oak_planks"), "it is still reported (the removal's refund)");
		var old = new Builder.Deconstruction(t, Map.of("minecraft:oak_planks", S), net.minecraft.core.BlockPos.ZERO, 0, 0);
		assertEquals(S, old.all().get("minecraft:oak_planks"), "an empty-record deconstruct (no owed key) drops as before");
		String g = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Groups.java"));
		assertTrue(g.contains("r.decItems.put(id, Map.copyOf(d.all()))") && g.contains("CrateOwed.commit(server)"), "Groups: decItems = all(); the commit");
		String b = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Builder.java"));
		int i = b.indexOf("CrateOwed.capture(");
		assertTrue(i > 0 && !b.substring(b.lastIndexOf("if (c.crate() != null) {", i), i).contains("takeStock"),
			"prepareDeconstruct never takes the stock before the record is saved");
	}

	/** The record's one store: stockpiles.json's crateOwed, written by a world with no stockpile too, read back as it was. */
	@Test
	void theRecordRoundTripsWithoutAStockpile() throws Exception {
		Path d = Files.createTempDirectory("cxd");
		Stockpiles.loadFrom(d);
		var rec = new CrateOwed.Rec("crate:s1@1,64,2/site:s1@5", "s1", "site:s1@5", "s1", "minecraft:overworld",
			new Construction.Crate(1, 64, 2, "{Name:\"minecraft:grass_block\"}", null), Map.of("minecraft:oak_planks", S));
		com.google.gson.JsonObject root = new com.google.gson.JsonObject();
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		a.add(rec.toJson());
		root.add("crateOwed", a);
		CrateOwed.read(root);
		Stockpiles.save();
		assertTrue(Files.isRegularFile(d.resolve("stockpiles.json")), "written with no stockpile (the early return keeps no file only when nothing is owed)");
		Stockpiles.loadFrom(d);
		assertEquals(List.of(rec), CrateOwed.open(), "read back as saved");
		CrateOwed.clear();
		Stockpiles.save();
		assertFalse(Files.readString(d.resolve("stockpiles.json")).contains("crateOwed"), "no record: no key (older builds read the file unchanged)");
	}
}
