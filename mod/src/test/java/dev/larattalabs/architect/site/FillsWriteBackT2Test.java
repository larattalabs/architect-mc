package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;

/**
 * (slice T2, the Fills custody residual) A custody write-back crashed with each store at any version it reached: the chunk (the slots and
 * their receipts), its item entities (the legacy drop) and the ledger (custody, stock, credited keys). The ledger is published only over
 * durable chunks (saveWithWorld and the barrier save the chunks first), so "ledger saved" implies "chunk saved". After the restart the
 * write-back runs again (the custody is still held when the ledger was not saved), then everything is saved. Items in == items out.
 * <p>Failing first: the legacy flow (drop what has no slot, no receipts) pays twice when the chunk was saved and the ledger was not; the
 * flow as built (chunk receipts, the rest keyed into the stock) is exact in every case.
 */
class FillsWriteBackT2Test {
	static final String KEY = "site:s1@100";
	/** Two declared chests: the first declares 10 planks in slot 0 and 5 cobblestone in slot 1; the second 7 planks in slot 0. */
	static final List<List<Fills.Stack>> DECLS = List.of(List.of(new Fills.Stack(0, "minecraft:oak_planks", 10), new Fills.Stack(1, "minecraft:cobblestone", 5)),
		List.of(new Fills.Stack(0, "minecraft:oak_planks", 7)));
	/** The custody: more planks than the slots take (4 have no slot), and slot 1 of the first chest occupied by a player's dirt. */
	static final Map<String, Integer> CUSTODY = Map.of("minecraft:oak_planks", 21, "minecraft:cobblestone", 5);

	/** The stores. Each a copy, so a "persisted" version is a snapshot. */
	static final class World {
		List<Map<Integer, Fills.Stack>> slots = new ArrayList<>(); // per cell
		Set<String> receipts = new LinkedHashSet<>();
		Map<String, Integer> drops = new TreeMap<>();
		Map<String, Integer> custody = new TreeMap<>(CUSTODY);
		Map<String, Integer> stock = new TreeMap<>();
		Set<String> credited = new LinkedHashSet<>();

		World() {
			slots.add(new HashMap<>(Map.of(1, new Fills.Stack(1, "minecraft:dirt", 3))));
			slots.add(new HashMap<>());
		}

		World copy() {
			World w = new World();
			w.slots = new ArrayList<>();
			slots.forEach(m -> w.slots.add(new HashMap<>(m)));
			w.receipts = new LinkedHashSet<>(receipts);
			w.drops = new TreeMap<>(drops);
			w.custody = new TreeMap<>(custody);
			w.stock = new TreeMap<>(stock);
			w.credited = new LinkedHashSet<>(credited);
			return w;
		}

		/** Billed items in the game: the custody's items wherever they are (the player's dirt excluded). */
		Map<String, Integer> total() {
			Map<String, Integer> t = new TreeMap<>();
			slots.forEach(m -> m.values().forEach(st -> {
				if (!st.item().equals("minecraft:dirt")) {
					t.merge(st.item(), st.count(), Integer::sum);
				}
			}));
			drops.forEach((k, v) -> t.merge(k, v, Integer::sum));
			custody.forEach((k, v) -> t.merge(k, v, Integer::sum));
			stock.forEach((k, v) -> t.merge(k, v, Integer::sum));
			t.values().removeIf(v -> v == 0);
			return t;
		}
	}

	static List<FillsWriteBack.Cell> cells(World w, String wb, boolean receipts) {
		List<FillsWriteBack.Cell> c = new ArrayList<>();
		for (int i = 0; i < w.slots.size(); i++) {
			Map<Integer, Fills.Stack> rc = receipts ? FillsWriteBack.parse(new ArrayList<>(w.receipts), wb, i, 64, 0) : null;
			c.add(new FillsWriteBack.Cell(true, 27, new HashSet<>(w.slots.get(i).keySet()), rc));
		}
		return c;
	}

	/** Fills.writeBack as built: the plan over the receipts, the writes with their receipts, the rest keyed into the stock. */
	static void asBuilt(World w) {
		if (w.custody.isEmpty()) {
			return;
		}
		String wb = FillsWriteBack.key(KEY, w.credited);
		FillsWriteBack.Plan p = FillsWriteBack.plan(w.custody, DECLS, List.of(true, true), cells(w, wb, true));
		w.custody.clear();
		for (int i = 0; i < p.writes().size(); i++) {
			if (!p.writes().get(i).isEmpty()) {
				w.slots.get(i).putAll(p.writes().get(i));
				w.receipts.add(FillsWriteBack.receipt(wb, i, 64, 0, p.writes().get(i)));
			}
		}
		if (w.credited.add(wb)) {
			p.stock().forEach((k, v) -> w.stock.merge(k, v, Integer::sum));
		}
	}

	/** The legacy flow (before T2): the same slot rule with no receipts; what has no slot dropped as item entities. */
	static void legacy(World w) {
		if (w.custody.isEmpty()) {
			return;
		}
		FillsWriteBack.Plan p = FillsWriteBack.plan(w.custody, DECLS, List.of(true, true), cells(w, "unused", false));
		w.custody.clear();
		for (int i = 0; i < p.writes().size(); i++) {
			w.slots.get(i).putAll(p.writes().get(i));
		}
		p.stock().forEach((k, v) -> w.drops.merge(k, v, Integer::sum));
	}

	/** The persisted world after a crash: each store at its version before or after the write-back (ledger saved implies chunk saved). */
	static World crashed(World before, World after, boolean chunk, boolean entities, boolean ledger) {
		World w = before.copy();
		if (chunk) {
			w.slots = after.copy().slots;
			w.receipts = new LinkedHashSet<>(after.receipts);
		}
		if (entities) {
			w.drops = new TreeMap<>(after.drops);
		}
		if (ledger) {
			w.custody = new TreeMap<>(after.custody);
			w.stock = new TreeMap<>(after.stock);
			w.credited = new LinkedHashSet<>(after.credited);
		}
		return w;
	}

	/** Every crash combination; answers the ones whose items in != items out. */
	static List<String> run(java.util.function.Consumer<World> flow) {
		List<String> bad = new ArrayList<>();
		for (int m = 0; m < 8; m++) {
			boolean chunk = (m & 1) != 0, entities = (m & 2) != 0, ledger = (m & 4) != 0;
			if (ledger && !chunk) {
				continue; // never: the ledger is published over durable chunks
			}
			World before = new World();
			World after = before.copy();
			flow.accept(after);
			World w = crashed(before, after, chunk, entities, ledger);
			flow.accept(w); // the restart's write-back (Fills.atStart): the custody still held when the ledger was not saved
			flow.accept(w); // and once more (a second restart): nothing new
			if (!w.total().equals(new TreeMap<>(CUSTODY))) {
				bad.add("chunk " + chunk + ", entities " + entities + ", ledger " + ledger + ": " + w.total());
			}
		}
		return bad;
	}

	@Test
	void theLegacyFlowPaysTwiceWhenTheChunkWasSavedAndTheLedgerNot() {
		List<String> bad = run(FillsWriteBackT2Test::legacy);
		assertFalse(bad.isEmpty(), "the legacy flow is red");
		assertTrue(bad.stream().anyMatch(b -> b.startsWith("chunk true, entities true, ledger false")), bad.toString());
		assertTrue(bad.stream().anyMatch(b -> b.startsWith("chunk true, entities false, ledger false")), bad.toString()); // the slots again
	}

	@Test
	void asBuiltEveryCrashIsExact() {
		assertEquals(List.of(), run(FillsWriteBackT2Test::asBuilt));
	}

	@Test
	void nothingDropsAndTheRestIsKeyedIntoTheStock() {
		World w = new World();
		asBuilt(w);
		assertTrue(w.drops.isEmpty());
		assertEquals(Map.of("minecraft:oak_planks", 4, "minecraft:cobblestone", 5), w.stock); // slot 1 occupied: the cobblestone too
		assertEquals(Set.of("wb:" + KEY + "#0"), w.credited);
		assertEquals(10, w.slots.get(0).get(0).count());
		assertEquals(7, w.slots.get(1).get(0).count());
	}

	@Test
	void aLaterWriteBackOfTheSameSiteGetsItsOwnKey() {
		World w = new World();
		asBuilt(w);
		w.slots.get(0).clear();
		w.slots.get(1).clear();
		w.receipts.clear(); // pruned once the ledger was durable
		w.custody.putAll(Map.of("minecraft:oak_planks", 2)); // a second removal took custody again and ended unwritten
		asBuilt(w);
		assertTrue(w.credited.contains("wb:" + KEY + "#1"));
		assertEquals(2, w.slots.get(0).get(0).count());
	}

	@Test
	void receiptsRoundTrip() {
		Map<Integer, Fills.Stack> wr = new java.util.LinkedHashMap<>();
		wr.put(0, new Fills.Stack(0, "minecraft:oak_planks", 10));
		wr.put(3, new Fills.Stack(3, "minecraft:torch", 2, true));
		String r = FillsWriteBack.receipt("wb:k#0", 1, 64, -2, wr);
		Map<Integer, Fills.Stack> back = FillsWriteBack.parse(List.of("other", r), "wb:k#0", 1, 64, -2);
		assertNotNull(back);
		assertEquals(wr, back);
		assertEquals(null, FillsWriteBack.parse(List.of(r), "wb:k#1", 1, 64, -2));
		assertEquals(null, FillsWriteBack.parse(List.of(r), "wb:k#0", 1, 64, -3));
	}
}
