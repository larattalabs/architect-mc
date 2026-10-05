package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The journal's invariants over random fixtures (docs/CONTRACT.md "Phase 4e gate" 1): 2-6 entries, BOX and CELL, random
 * overlaps and random player edits, every removal order (sampled above 4 entries) and random group splits:
 * <ul>
 * <li>(i) with no player edits, undoing everything in any order gives back the original world;</li>
 * <li>(ii) undoing a subset never writes a cell owned by an entry outside the subset;</li>
 * <li>(iii) the final world after undoing everything is the same for every order, with edits included (see
 * {@link #boxUnderEditedCell}: the one configuration where (iii) and (iv) contradict each other is excluded);</li>
 * <li>(iv) a player edit on a cell that a CELL entry owns survives that entry's undo.</li>
 * </ul>
 */
class JournalPropertyTest {
	static final Value T = Value.of("minecraft:grass_block");
	static final Value[] PALETTE = {Value.of("minecraft:dirt_path"), Value.of("minecraft:spruce_planks"), Value.of("minecraft:oak_slab", "type", "bottom"),
		Value.of("minecraft:cobblestone"), Journal.AIR, Value.of("minecraft:stone_bricks")};
	static final Value EDIT = Value.of("minecraft:gold_block");
	static final Value EDIT2 = Value.of("minecraft:diamond_block");
	static final int FIXTURES = 400;

	/** A world and its journal, changed the way the server changes them. */
	static final class Sim {
		final Map<Long, Value> world = new HashMap<>();
		final Map<String, Entry> entries = new LinkedHashMap<>();
		/** Positions the player changed (after the change that came before). */
		final Set<Long> edited = new HashSet<>();
		long layer = 1;

		Value at(long p) {
			return world.getOrDefault(p, T);
		}

		Entry change(String id, Policy policy, Map<Long, Value> to) {
			List<Cell> cells = new ArrayList<>();
			long l = layer++;
			for (var t : to.entrySet()) {
				cells.add(new Cell(t.getKey(), l, at(t.getKey()), t.getValue()));
				world.put(t.getKey(), t.getValue());
			}
			Entry e = new Entry(id, policy == Policy.BOX ? "site" : "road", id, "minecraft:overworld", policy, l, Status.ACTIVE, cells, null, null);
			entries.put(id, e);
			return e;
		}

		Journal.UndoPlan undo(List<String> ids) {
			Journal.UndoPlan p = Journal.planUndo(entries.values(), ids, ids.get(0), 0L, (pos, after) -> at(pos).equals(after), Journal.Match.EQUAL);
			for (Journal.Write w : p.writes()) {
				world.put(w.pos(), w.value());
			}
			entries.putAll(p.updated());
			// released at the next world start (the undo reached the disk)
			ids.forEach(entries::remove);
			return p;
		}

		Sim copy() {
			Sim s = new Sim();
			s.world.putAll(world);
			s.entries.putAll(entries);
			s.edited.addAll(edited);
			s.layer = layer;
			return s;
		}

		/** The active entry on top at {@code pos}, or null. */
		String owner(long pos) {
			var st = Journal.stack(entries.values(), pos);
			return st.isEmpty() ? null : st.get(st.size() - 1).getKey().id();
		}
	}

	static final long[] POS = new long[12];

	static {
		int k = 0;
		// 12 cells across a section boundary (x 15 | 16) and two y levels
		for (int y = 64; y <= 65; y++) {
			for (int x = 14; x <= 16; x++) {
				for (int z = 0; z <= 1; z++) {
					POS[k++] = Journal.pos(x, y, z);
				}
			}
		}
	}

	/** A random fixture: n entries over random subsets of the cells, player edits in between when {@code edits}. */
	static Sim fixture(Random r, int n, boolean edits) {
		Sim s = new Sim();
		for (int i = 0; i < n; i++) {
			if (edits && r.nextInt(3) == 0) {
				edit(s, r);
			}
			Map<Long, Value> to = new LinkedHashMap<>();
			int cells = 1 + r.nextInt(POS.length);
			List<Long> ps = new ArrayList<>();
			for (long p : POS) {
				ps.add(p);
			}
			Collections.shuffle(ps, r);
			for (int c = 0; c < cells; c++) {
				to.put(ps.get(c), PALETTE[r.nextInt(PALETTE.length)]);
			}
			s.change("e" + i, r.nextBoolean() ? Policy.BOX : Policy.CELL, to);
		}
		if (edits && r.nextBoolean()) {
			edit(s, r);
		}
		return s;
	}

	static void edit(Sim s, Random r) {
		int n = 1 + r.nextInt(3);
		for (int i = 0; i < n; i++) {
			long p = POS[r.nextInt(POS.length)];
			s.world.put(p, r.nextBoolean() ? EDIT : EDIT2);
			s.edited.add(p);
		}
	}

	static List<List<String>> orders(List<String> ids, Random r) {
		List<List<String>> out = new ArrayList<>();
		if (ids.size() <= 4) {
			permute(new ArrayList<>(ids), 0, out);
		} else {
			for (int i = 0; i < 60; i++) {
				List<String> o = new ArrayList<>(ids);
				Collections.shuffle(o, r);
				out.add(o);
			}
		}
		return out;
	}

	static void permute(List<String> a, int k, List<List<String>> out) {
		if (k == a.size()) {
			out.add(List.copyOf(a));
			return;
		}
		for (int i = k; i < a.size(); i++) {
			Collections.swap(a, k, i);
			permute(a, k + 1, out);
			Collections.swap(a, k, i);
		}
	}

	/** A random split of {@code ids} into groups, in a random order. */
	static List<List<String>> split(List<String> ids, Random r) {
		List<String> shuffled = new ArrayList<>(ids);
		Collections.shuffle(shuffled, r);
		List<List<String>> groups = new ArrayList<>();
		for (String id : shuffled) {
			if (groups.isEmpty() || r.nextInt(3) == 0) {
				groups.add(new ArrayList<>());
			}
			groups.get(r.nextInt(groups.size())).add(id);
		}
		groups.removeIf(List::isEmpty);
		return groups;
	}

	static Map<Long, Value> undoAll(Sim base, List<List<String>> groups) {
		Sim s = base.copy();
		for (List<String> g : groups) {
			s.undo(g);
		}
		Map<Long, Value> out = new HashMap<>();
		for (long p : POS) {
			out.put(p, s.at(p));
		}
		return out;
	}

	static List<List<String>> singles(List<String> order) {
		return order.stream().map(List::of).toList();
	}

	@Test
	void i_withoutEditsEveryOrderAndEverySplitGivesTheOriginalWorldBack() {
		Random r = new Random(4401);
		for (int f = 0; f < FIXTURES; f++) {
			int n = 2 + r.nextInt(5);
			Sim s = fixture(r, n, false);
			List<String> ids = List.copyOf(s.entries.keySet());
			for (List<String> order : orders(ids, r)) {
				Map<Long, Value> end = undoAll(s, singles(order));
				for (long p : POS) {
					assertEquals(T, end.get(p), "fixture " + f + " order " + order + " at " + Journal.x(p) + "," + Journal.y(p) + "," + Journal.z(p));
				}
			}
			for (int k = 0; k < 8; k++) {
				List<List<String>> groups = split(ids, r);
				Map<Long, Value> end = undoAll(s, groups);
				for (long p : POS) {
					assertEquals(T, end.get(p), "fixture " + f + " split " + groups);
				}
			}
		}
	}

	@Test
	void ii_undoingASubsetNeverWritesACellOwnedByAnEntryOutsideIt() {
		Random r = new Random(4402);
		for (int f = 0; f < FIXTURES; f++) {
			Sim s = fixture(r, 2 + r.nextInt(5), r.nextBoolean());
			List<String> ids = List.copyOf(s.entries.keySet());
			for (int k = 0; k < 10; k++) {
				List<String> subset = new ArrayList<>();
				for (String id : ids) {
					if (r.nextBoolean()) {
						subset.add(id);
					}
				}
				if (subset.isEmpty()) {
					continue;
				}
				Sim c = s.copy();
				Journal.UndoPlan plan = c.undo(subset);
				for (Journal.Write w : plan.writes()) {
					String top = s.owner(w.pos());
					assertTrue(top != null && subset.contains(top), "fixture " + f + ": undoing " + subset + " wrote " + w + ", owned by " + top);
				}
			}
		}
	}

	@Test
	void iii_theFinalWorldIsTheSameForEveryOrderWithEdits() {
		Random r = new Random(4403);
		int checked = 0;
		int excluded = 0;
		for (int f = 0; f < FIXTURES * 2; f++) {
			Sim s = fixture(r, 2 + r.nextInt(5), true);
			if (boxUnderEditedCell(s)) {
				excluded++;
				continue;
			}
			checked++;
			List<String> ids = List.copyOf(s.entries.keySet());
			Map<Long, Value> first = null;
			for (List<String> order : orders(ids, r)) {
				Map<Long, Value> end = undoAll(s, singles(order));
				if (first == null) {
					first = end;
				} else {
					assertEquals(first, end, "fixture " + f + " order " + order);
				}
			}
			for (int k = 0; k < 8; k++) {
				List<List<String>> groups = split(ids, r);
				assertEquals(first, undoAll(s, groups), "fixture " + f + " split " + groups);
			}
		}
		assertTrue(checked > FIXTURES, "enough fixtures checked (" + checked + ", " + excluded + " excluded)");
	}

	/**
	 * The configuration where (iii) and (iv) contradict: a cell the player edited after a CELL entry covered a BOX entry's
	 * cell there. Undo the CELL entry first and (iv) keeps the edit, then the BOX entry restores its before; undo the BOX
	 * entry first and it hands down under the CELL entry, whose undo then keeps the edit (iv) for good. Recorded in
	 * docs/CONTRACT.md "Phase 4e as built".
	 */
	static boolean boxUnderEditedCell(Sim s) {
		for (long p : s.edited) {
			boolean box = false;
			for (var e : Journal.stack(s.entries.values(), p)) {
				if (e.getKey().policy() == Policy.BOX) {
					box = true;
				} else if (box) {
					return true;
				}
			}
		}
		return false;
	}

	@Test
	void theContradictionBetweenIiiAndIvIsReal() {
		// a BOX entry, a CELL entry over it, the player's block on top: the end depends on the order
		Sim s = new Sim();
		long p = POS[0];
		s.change("box", Policy.BOX, Map.of(p, PALETTE[1]));
		s.change("cell", Policy.CELL, Map.of(p, PALETTE[0]));
		s.world.put(p, EDIT);
		assertEquals(EDIT, undoAll(s, List.of(List.of("box"), List.of("cell"))).get(p), "box first: the cell entry keeps the player's block (iv)");
		assertEquals(T, undoAll(s, List.of(List.of("cell"), List.of("box"))).get(p), "cell first: the box entry restores its before");
	}

	@Test
	void iv_aPlayerEditOnACellACellEntryOwnsSurvivesItsUndo() {
		Random r = new Random(4404);
		int checked = 0;
		for (int f = 0; f < FIXTURES; f++) {
			Sim s = fixture(r, 2 + r.nextInt(5), r.nextBoolean());
			for (long p : POS) {
				String owner = s.owner(p);
				if (owner == null || s.entries.get(owner).policy() != Policy.CELL) {
					continue;
				}
				Sim c = s.copy();
				c.world.put(p, EDIT2);
				Journal.UndoPlan plan = c.undo(List.of(owner));
				assertEquals(EDIT2, c.at(p), "fixture " + f + ": " + owner + "'s undo kept the player's block");
				assertFalse(plan.writes().stream().anyMatch(w -> w.pos() == p));
				checked++;
			}
		}
		assertTrue(checked > 100, "checked " + checked);
	}
}
