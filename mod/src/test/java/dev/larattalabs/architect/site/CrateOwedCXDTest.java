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
import org.junit.jupiter.api.Test;

/**
 * Slice CXD (docs/CONTRACT.md "Slice CXD"): a crate's stock a removal takes is paid exactly once (or stays in the crate) across a crash at
 * every step. A two-store simulation (the chunk with the crate and the dropped items, the stockpiles file with the owed record; each
 * saved as the code saves it, with an autosave anywhere before the crash) killed at each step, then the restart's resolution (the real
 * {@link CrateOwed#resolve} table), counting the stock: crate + items on the ground. Main's flow (the stock carried, no record) is shown
 * red at the same points. The world half is gated in game (cxd-crash).
 */
class CrateOwedCXDTest {
	static final int S = 40; // the crate's stock

	/** One side of the world: in memory or on disk. */
	static final class World {
		boolean crate = true; // the crate block stands (its cell not restored)
		int stock = S; // the crate's stock
		boolean marked; // the CxdTaken marker
		int ground; // items on the ground (entities)
		boolean record; // the owed record open (the stockpiles file)
		int recordItems;
		boolean committed; // the removal's undo committed (the journal: durable at once)
		int queue; // main: crate stock carried in the group queue file

		World copy() {
			World w = new World();
			w.crate = crate;
			w.stock = stock;
			w.marked = marked;
			w.ground = ground;
			w.record = record;
			w.recordItems = recordItems;
			w.committed = committed;
			w.queue = queue;
			return w;
		}

		int items() {
			return (crate ? stock : 0) + ground;
		}
	}

	/** The two stores: memory and disk. The chunk (crate + ground) and the file (record, queue) are saved separately. */
	static final class Sim {
		final World mem = new World();
		final World disk = new World();

		void chunks() {
			disk.crate = mem.crate;
			disk.stock = mem.stock;
			disk.marked = mem.marked;
			disk.ground = mem.ground;
		}

		void ledger() {
			disk.record = mem.record;
			disk.recordItems = mem.recordItems;
		}

		void queue() {
			disk.queue = mem.queue;
		}

		void commit() {
			mem.committed = true;
			disk.committed = true;
		}
	}

	/** A step of a flow; {@code kill}: the sim's step count to halt after (-1: none), {@code autosaveAt}: the step an autosave follows. */
	interface Flow {
		void run(Sim s, Runnable[] step);
	}

	/** The CXD flow of a crate site's removal (Sites.removeDetailed / a group member), as built; each sub-step is a kill point. */
	static List<Runnable> cxdSteps(Sim s) {
		List<Runnable> st = new ArrayList<>();
		st.add(() -> { // capture (CXD1 after it)
			s.mem.record = true;
			s.mem.recordItems = s.mem.stock;
		});
		st.add(() -> s.chunks()); // saveConfirmed: saveWithWorld = chunks flushed ...
		st.add(() -> s.ledger()); // ... then the ledger (CXD2 after it)
		st.add(() -> { // the take (CXD3 after it)
			s.mem.stock = 0;
			s.mem.marked = true;
		});
		st.add(() -> s.commit()); // the removal's commit
		st.add(() -> s.mem.crate = false); // the undo's write restores the crate cell (an own crate's CRATE entry; CXD4 after it)
		st.add(() -> s.mem.record = false); // settle (rule 17): the record closed ...
		st.add(() -> s.ledger()); // ... and that ledger written, confirmed (CXDS after it: the accepted loss window)
		st.add(() -> { // then the stock dropped, the cell restored (in memory)
			s.mem.ground += s.mem.recordItems;
			s.mem.crate = false;
		});
		st.add(() -> s.chunks()); // then the players and the chunks
		return st;
	}

	/** Main's group flow: R1 takes the stock and restores the cell; the queue carries it (saved before the commit); the member drops it. */
	static List<Runnable> mainSteps(Sim s) {
		List<Runnable> st = new ArrayList<>();
		st.add(() -> { // R1: prepareDeconstruct takes the stock, the cell restored, decItems carries it
			s.mem.queue = s.mem.stock;
			s.mem.stock = 0;
			s.mem.crate = false;
		});
		st.add(() -> s.queue()); // the pre-save: the queue file holds the stock
		st.add(() -> s.commit());
		st.add(() -> { // the member's restore written: decItems dropped
			s.mem.ground += s.mem.queue;
			s.mem.queue = 0;
		});
		st.add(() -> s.queue()); // the queue saved without it
		st.add(() -> s.chunks());
		return st;
	}

	/** The restart: CXD's resolution of an open record ({@link CrateOwed#resolve}); a resumed group removal for main. */
	static void restartCxd(World d) {
		if (!d.record) {
			return;
		}
		CrateState st = !d.crate ? CrateState.ABSENT : d.marked ? CrateState.MARKED : CrateState.PRESENT;
		Outcome o = CrateOwed.resolve(!d.committed, st);
		if (o.putBack()) {
			d.stock += d.recordItems;
			d.marked = false;
		}
		if (o.dropRecord()) {
			d.ground += d.recordItems;
		}
		if (o.dropCrateStock() && d.crate) {
			d.ground += d.stock;
			d.stock = 0;
		}
		if (o.restoreCell()) {
			d.crate = false;
		}
		d.record = false;
	}

	static void restartMain(World d) {
		if (d.committed && d.queue > 0) {
			d.ground += d.queue; // the resumed removal drops its decItems
			d.queue = 0;
		}
		// an orphan crate left standing gives back what it holds (openCrate): counted as items already (World.items)
	}

	/** Runs {@code steps} to step {@code kill} (exclusive end), an autosave (chunks + ledger + queue) after step {@code auto} (-1: none). */
	static World crash(java.util.function.Function<Sim, List<Runnable>> flow, int kill, int auto) {
		Sim s = new Sim();
		List<Runnable> st = flow.apply(s);
		for (int i = 0; i < kill; i++) {
			st.get(i).run();
			if (i == auto) {
				s.chunks();
				s.ledger();
				s.queue();
			}
		}
		return s.disk.copy();
	}

	@Test
	void theTable() {
		assertTrue(CrateOwed.resolve(true, CrateState.MARKED).putBack(), "standing, taken: put back");
		assertEquals(new Outcome(false, false, false, false), CrateOwed.resolve(true, CrateState.PRESENT), "standing, not taken: only closed");
		assertTrue(CrateOwed.resolve(true, CrateState.ABSENT).dropRecord(), "standing, the crate gone after the take: dropped once");
		Outcome gone = CrateOwed.resolve(false, CrateState.MARKED);
		assertTrue(gone.dropRecord() && gone.dropCrateStock() && gone.restoreCell() && !gone.putBack(), "removed, taken: the record's stock, the cell");
		Outcome gp = CrateOwed.resolve(false, CrateState.PRESENT);
		assertTrue(!gp.dropRecord() && gp.dropCrateStock() && gp.restoreCell(), "removed, not taken: the crate's own stock, the cell");
		assertTrue(CrateOwed.resolve(false, CrateState.ABSENT).dropRecord(), "removed, the cell restored: the record's stock");
	}

	/** Every kill point (CXD1..CXD4, inside both saves) with an autosave at any earlier step or none: once, never a dupe. */
	@Test
	void everyKillPointPaysOnce() {
		int n = cxdSteps(new Sim()).size();
		int cxds = n - 2; // killed after the closing ledger write (CXDS) or after the drop before its chunks: the accepted loss window
		for (int kill = 0; kill <= n; kill++) {
			for (int auto = -1; auto < kill; auto++) {
				if (auto >= cxds - 2 && auto <= cxds) {
					continue; // the settle's close, its ledger write and the drop run in one call: no autosave between them
				}
				World d = crash(CrateOwedCXDTest::cxdSteps, kill, auto);
				restartCxd(d);
				String at = "killed after step " + kill + ", autosave after " + auto;
				assertTrue(d.items() <= S, at + ": never a dupe (" + d.items() + ")");
				boolean window = (kill == cxds || kill == cxds + 1) && auto < cxds; // no autosave of the drop's chunks before the halt
				if (!window) {
					assertEquals(S, d.items(), at + ": paid once");
					assertFalse(d.crate && d.marked, at + ": no marked crate left standing");
				} // (in CXDS's window an empty marked crate can stand, its site gone: an orphan, taken away by a right-click)
			}
		}
	}

	/** A second crash during the restart's resolution: the disk is resolved again from the same table, once. */
	@Test
	void aSecondCrashDuringResolution() {
		int n = cxdSteps(new Sim()).size();
		for (int kill = 0; kill <= n; kill++) {
			World d = crash(CrateOwedCXDTest::cxdSteps, kill, -1);
			if (!d.record) {
				continue;
			}
			// the resolution's own saves: a put-back saves chunks then the ledger; a drop the ledger then the chunks. Killed between: the
			// first part on disk only
			World r = d.copy();
			restartCxd(r);
			boolean putBack = r.stock > d.stock;
			World half = d.copy();
			if (putBack) {
				half.stock = r.stock; // the chunk (crate restored) on disk, the record still open
				half.marked = r.marked;
			} else {
				half.record = false; // the ledger (record closed) on disk, the drop not: the loss window, never a dupe
			}
			restartCxd(half);
			assertTrue(half.items() <= S, "killed after " + kill + ", again mid-resolution: never a dupe");
			if (putBack) {
				assertEquals(S, half.items(), "killed after " + kill + ", again mid put-back: once");
			}
		}
	}

	/** Main (no record): the queue carried the stock while the chunk on disk still held the crate: paid twice (PSV final review 1). */
	@Test
	void mainDoublesWhatTheQueueCarries() {
		World d = crash(CrateOwedCXDTest::mainSteps, 3, -1); // the queue saved with the stock, committed, the chunk never saved
		restartMain(d);
		assertEquals(2 * S, d.items(), "main: the crate on disk and the queue's decItems: twice");
		World lost = crash(CrateOwedCXDTest::mainSteps, 1, 0); // R1 then an autosave: the chunk without the crate, the queue not saved
		restartMain(lost);
		assertEquals(0, lost.items(), "main: a stock taken and never recorded: lost");
	}

	/** A removal that ends before its commit (a refused save, a refused replan, Groups.end before its undo) puts the stock back. */
	@Test
	void aRefusedRemovalPutsBack() {
		for (int kill = 4; kill >= 1; kill--) { // after the take or earlier, never committed
			Sim s = new Sim();
			List<Runnable> st = cxdSteps(s);
			for (int i = 0; i < kill; i++) {
				st.get(i).run();
			}
			World m = s.mem;
			if (m.record) {
				restartCxd(m); // putBackSites: resolved as standing, in this session
			}
			assertEquals(S, m.stock, "ended after step " + kill + ": the crate holds its stock again");
			assertFalse(m.marked || m.record, "ended after step " + kill + ": no marker, no record");
		}
	}

	/** The group queue never carries a crate's stock: a member's decItems are its deconstruct's all(), without an owed stock. */
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
