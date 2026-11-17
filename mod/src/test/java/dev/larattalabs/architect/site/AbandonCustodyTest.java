package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (Slice LC3 round 4, the GPT review of f6a982f6) {@code /architect removal abandon}'s custody return: durable as one step before any record
 * changes (P1), idempotent across a crash inside its save, and the provided items settled by FK-b's rule (P2). In game: lc3-undo's abandon
 * crash cases AB1-AB4 (tools/lib/gatem5lc3.mjs).
 */
class AbandonCustodyTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static final String FLINT = "minecraft:flint";
	static final String SLAB = "minecraft:petrified_oak_slab";

	/**
	 * A crash model of one filled member's custody across the abandon's steps. Disk: the containers (hold the items), the ledger's custody,
	 * the member's pending record, the stalled removal. The restart: with the record still there the abandon (or a retry) runs again and the
	 * return is idempotent, so the items exist once if they are in the containers or the saved custody; with the record gone, a custody left
	 * in the saved ledger names no site (Fills.atStart's siteOfKey finds none): stranded, never back in the world.
	 */
	static final class Model {
		boolean memContainers, memCustody = true;
		boolean diskContainers, diskCustody = true, diskRecord = true, diskStalled = true;

		void op(String o) {
			switch (o) {
				case "return" -> {
					memContainers = true;
					memCustody = false;
				}
				case "chunks" -> diskContainers = memContainers; // a save with the world: the chunks flushed first
				case "ledger" -> diskCustody = memCustody; // then the ledger
				case "release", "drop" -> diskRecord = false; // the journal's release and the sites file: durable at once
				case "leave" -> diskStalled = false;
				default -> {
				}
			}
		}

		/** How many times the items exist in the world (or come back to it) after the restart. */
		int once() {
			if (diskRecord) {
				return diskContainers || diskCustody ? 1 : 0;
			}
			return diskContainers ? 1 : 0;
		}
	}

	/** Whether a crash after every prefix of {@code ops} (and the end) leaves the items once. */
	static boolean crashSafe(List<String> ops) {
		for (int k = 0; k <= ops.size(); k++) {
			Model m = new Model();
			for (String o : ops.subList(0, k)) {
				m.op(o);
			}
			if (m.once() != 1) {
				return false;
			}
		}
		return true;
	}

	/** The steps {@link Groups#abandonSteps} takes for one filled member, a save expanded into its chunk and ledger writes. */
	static List<String> recorded(boolean saveOk, List<String> kills) throws Exception {
		List<String> ops = new ArrayList<>();
		boolean done = Groups.abandonSteps(List.of("lot_b"), new Groups.AbandonIo() {
			@Override
			public boolean returnCustody(String id) {
				ops.add("return");
				return true;
			}

			@Override
			public boolean saveConfirmed() {
				ops.add("chunks");
				if (saveOk) {
					ops.add("ledger");
				}
				return saveOk;
			}

			@Override
			public void kill(String point) {
				kills.add(point);
			}

			@Override
			public void release(String id) {
				ops.add("release");
			}

			@Override
			public void dropRecords(List<String> ids) {
				ops.add("drop");
			}

			@Override
			public void leave() {
				ops.add("leave");
			}
		});
		assertEquals(saveOk, done);
		return ops;
	}

	@Test
	void abandonSavesTheReturnedCustodyDurablyBeforeAnyRecordChanges() throws Exception {
		List<String> kills = new ArrayList<>();
		List<String> ops = recorded(true, kills);
		assertEquals(List.of("return", "chunks", "ledger", "release", "drop", "leave"), ops);
		assertEquals(List.of("AB1", "AB3", "AB4"), kills, "the gate's kill points (AB2 sits inside the save)");
		assertTrue(crashSafe(ops), "a crash at any step leaves the custody once");
		// f6a982f6's order: the containers written back and the records dropped, the ledger saved only later with the world
		assertFalse(crashSafe(List.of("return", "release", "drop", "leave", "chunks", "ledger")), "the old order strands the custody");
		// a save that is not confirmed stops before any record changes: still stalled, re-runnable
		List<String> failed = recorded(false, new ArrayList<>());
		assertEquals(List.of("return", "chunks"), failed);
		assertTrue(crashSafe(failed));
	}

	/** A container's slots as item ids (no item components in units). */
	static final class Fake implements Fills.Slots {
		final String[] item;
		final int[] n;

		Fake(int size) {
			item = new String[size];
			n = new int[size];
		}

		Fake put(int k, String it, int c) {
			item[k] = it;
			n[k] = c;
			return this;
		}

		@Override
		public int size() {
			return item.length;
		}

		@Override
		public String item(int k) {
			return item[k];
		}

		@Override
		public int count(int k) {
			return n[k];
		}

		@Override
		public void set(int k, String it, int c) {
			item[k] = it;
			n[k] = it == null ? 0 : c;
		}
	}

	@Test
	void theBilledReturnIsIdempotentAndCreditsWhatFindsNoSlot() {
		Fills.Box box = new Fills.Box(0, 0, 0, List.of(new Fills.Stack(0, FLINT, 18), new Fills.Stack(1, SLAB, 1, true)));
		Fake c = new Fake(5);
		List<Fills.Slots> cs = new ArrayList<>();
		cs.add(c);
		boolean[] t = new boolean[1];
		Map<String, Integer> left = Fills.returnBilled(List.of(box), cs, Map.of(FLINT, 18), t);
		assertTrue(left.isEmpty());
		assertTrue(t[0]);
		assertEquals(18, c.count(0));
		assertNull(c.item(1), "a provided slot is never written back");
		// a crash after the save's chunk writes, before its ledger write: the custody again, the items already there; never twice
		t[0] = false;
		assertTrue(Fills.returnBilled(List.of(box), cs, Map.of(FLINT, 18), t).isEmpty());
		assertFalse(t[0]);
		assertEquals(18, c.count(0));
		// no container (swapped or restored away): all of it left, credited to the stockpile by the caller (a ledger change, never a drop)
		List<Fills.Slots> none = new ArrayList<>();
		none.add(null);
		assertEquals(Map.of(FLINT, 18), Fills.returnBilled(List.of(box), none, Map.of(FLINT, 18), new boolean[1]));
		// a slot holding something else: left too
		assertEquals(Map.of(FLINT, 18), Fills.returnBilled(List.of(box), List.of(new Fake(5).put(0, "minecraft:dirt", 3)), Map.of(FLINT, 18), new boolean[1]));
	}

	@Test
	void anAbandonedMembersProvidedItemsAreDestroyedNeverLeftUnguarded() {
		// (GPT P2) with its record dropped FillGuard guards nothing there, so no provided stack may stay in its containers
		Fills.Box box = new Fills.Box(0, 0, 0, List.of(new Fills.Stack(0, FLINT, 18), new Fills.Stack(1, SLAB, 1, true), new Fills.Stack(2, SLAB, 1, true)));
		Fake c = new Fake(5).put(0, FLINT, 18).put(1, SLAB, 1).put(3, SLAB, 2);
		boolean[] t = new boolean[1];
		assertEquals(3, Fills.stripProvided(List.of(box), List.of(c), t));
		assertTrue(t[0]);
		for (int i = 1; i < 5; i++) {
			assertNull(c.item(i));
		}
		assertEquals(18, c.count(0), "billed items stay");
		Fills.Box plain = new Fills.Box(0, 0, 0, List.of(new Fills.Stack(0, FLINT, 18)));
		assertEquals(0, Fills.stripProvided(List.of(plain), List.of(new Fake(5).put(1, SLAB, 1)), new boolean[1]), "a box that declares none: vanilla");
	}

	@Test
	void aRetryTakesCustodyAgainOnlyWhenNoneIsHeldAndAStockpileThatFailedToLoadRefuses() {
		assertTrue(Groups.needsRetake(Map.of(), Map.of()));
		assertFalse(Groups.needsRetake(Map.of(FLINT, 18), Map.of()));
		assertFalse(Groups.needsRetake(Map.of(), Map.of(SLAB, 4)));
		Groups.Removal r = new Groups.Removal("g8", null, null, false);
		assertNull(Groups.abandonRefusal(r, false, "g8", null, false));
		assertTrue(Groups.abandonRefusal(r, false, "g8", null, true).contains("stockpiles failed to load"));
	}
}
