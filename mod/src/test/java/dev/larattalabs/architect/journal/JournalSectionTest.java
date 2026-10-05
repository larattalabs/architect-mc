package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;

/** Per-section planning equals whole-entry planning (docs/CONTRACT.md "Phase 4e gate" 1). */
class JournalSectionTest {
	@Test
	void sectionKeysRoundTrip() {
		for (int[] p : new int[][] {{0, 0, 0}, {-1, -64, -1}, {15, 319, 16}, {-30000000, 64, 29999999}, {123456, -17, -98765}}) {
			long pos = Journal.pos(p[0], p[1], p[2]);
			long key = Sections.key(pos);
			assertEquals(p[0] >> 4, Sections.sx(key));
			assertEquals(p[1] >> 4, Sections.sy(key));
			assertEquals(p[2] >> 4, Sections.sz(key));
			assertEquals(pos, Sections.pos(key, Sections.index(pos)));
			long r = Sections.region(key);
			assertEquals(p[0] >> 9, Sections.rx(r));
			assertEquals(p[2] >> 9, Sections.rz(r));
		}
	}

	@Test
	void perSectionPlanningEqualsWholeEntryPlanning() {
		Random r = new Random(4410);
		int sectioned = 0;
		for (int f = 0; f < 500; f++) {
			JournalPropertyTest.Sim s = JournalPropertyTest.fixture(r, 2 + r.nextInt(5), r.nextBoolean());
			List<String> ids = new ArrayList<>(s.entries.keySet());
			List<String> subset = new ArrayList<>();
			for (String id : ids) {
				if (r.nextBoolean()) {
					subset.add(id);
				}
			}
			if (subset.isEmpty()) {
				subset.add(ids.get(0));
			}
			Journal.World w = (pos, after) -> s.at(pos).equals(after);
			Journal.UndoPlan whole = Journal.planUndo(s.entries.values(), subset, "g", 7L, w, Journal.Match.EQUAL);
			// slices per section
			Map<Long, List<Entry>> bySection = new TreeMap<>();
			for (Entry e : s.entries.values()) {
				Sections.slice(e).forEach((k, x) -> bySection.computeIfAbsent(k, kk -> new ArrayList<>()).add(x));
			}
			TreeSet<Long> sections = new TreeSet<>();
			for (String id : subset) {
				for (Cell c : s.entries.get(id).cells()) {
					sections.add(Sections.key(c.pos()));
				}
			}
			if (sections.size() > 1) {
				sectioned++;
			}
			Sections.Plan per = Sections.plan(sections, k -> (Collection<Entry>) bySection.getOrDefault(k, List.of()), subset, "g", 7L, w,
				Journal.Match.EQUAL);
			// the same writes (each position once, the same value and writer)
			assertEquals(writes(whole.writes()), writes(per.writes()), "fixture " + f);
			assertEquals(whole.writes().size(), per.writes().size());
			// the same stats
			assertEquals(whole.stats(), per.stats(), "fixture " + f);
			for (var t : whole.updated().entrySet()) {
				Entry e = t.getValue();
				if (subset.contains(t.getKey())) {
					Journal.Undo u = per.undos().get(t.getKey());
					assertEquals(e.undo().written(), u.written(), "written of " + t.getKey());
					assertEquals(handed(e.undo().handed()), handed(u.handed()), "hand-downs of " + t.getKey());
				} else {
					List<Cell> merged = new ArrayList<>();
					per.cells().getOrDefault(t.getKey(), Map.of()).values().forEach(merged::addAll);
					// sections the plan did not touch keep their cells
					for (Cell c : s.entries.get(t.getKey()).cells()) {
						if (!per.cells().getOrDefault(t.getKey(), Map.of()).containsKey(Sections.key(c.pos()))) {
							merged.add(c);
						}
					}
					assertEquals(byPos(e.cells()), byPos(merged), "cells of " + t.getKey());
				}
			}
			// nothing the whole plan left alone changed per section
			for (String id : per.cells().keySet()) {
				assertTrue(whole.updated().containsKey(id) || per.cells().get(id).entrySet().stream().allMatch(x -> byPos(x.getValue()).equals(
					byPos(Sections.slice(s.entries.get(id)).get(x.getKey()).cells()))), "entry " + id + " changed per section only");
			}
			// reactivation per section equals the whole
			Map<String, Entry> after = new HashMap<>(s.entries);
			after.putAll(whole.updated());
			Map<String, Entry> wholeBack = Journal.reactivate(after.values(), "g");
			Map<Long, List<Entry>> slicedAfter = new TreeMap<>();
			for (Entry e : after.values()) {
				Sections.slice(e).forEach((k, x) -> slicedAfter.computeIfAbsent(k, kk -> new ArrayList<>()).add(x));
			}
			Map<String, Map<Long, List<Cell>>> perBack = Sections.reactivate(new TreeSet<>(slicedAfter.keySet()),
				k -> (Collection<Entry>) slicedAfter.getOrDefault(k, List.of()), "g");
			for (var t : wholeBack.entrySet()) {
				if (subset.contains(t.getKey())) {
					continue;
				}
				List<Cell> merged = new ArrayList<>();
				Map<Long, List<Cell>> ps = perBack.getOrDefault(t.getKey(), Map.of());
				ps.values().forEach(merged::addAll);
				for (Cell c : after.get(t.getKey()).cells()) {
					if (!ps.containsKey(Sections.key(c.pos()))) {
						merged.add(c);
					}
				}
				assertEquals(byPos(t.getValue().cells()), byPos(merged), "reactivated cells of " + t.getKey());
			}
		}
		assertTrue(sectioned > 100, "fixtures spanning sections: " + sectioned);
	}

	private static Map<Long, String> writes(List<Journal.Write> ws) {
		Map<Long, String> m = new TreeMap<>();
		for (Journal.Write w : ws) {
			m.put(w.pos(), w.value() + " by " + w.by() + " " + w.policy());
		}
		return m;
	}

	/** Hand-downs by position, in their order at that position (the numbering itself may differ). */
	private static Map<Long, List<String>> handed(List<HandDown> hs) {
		Map<Long, List<String>> m = new TreeMap<>();
		hs.stream().sorted(Comparator.comparingInt(HandDown::order)).forEach(h -> m.computeIfAbsent(h.pos(), k -> new ArrayList<>())
			.add(h.to() + ":" + h.was() + "->" + h.now()));
		return m;
	}

	private static Map<Long, Cell> byPos(List<Cell> cs) {
		Map<Long, Cell> m = new TreeMap<>();
		cs.forEach(c -> m.put(c.pos(), c));
		return m;
	}
}
