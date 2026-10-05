package dev.larattalabs.architect.journal;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Stats;
import dev.larattalabs.architect.journal.Journal.Undo;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedSet;
import java.util.TreeMap;
import java.util.function.Function;

/**
 * The journal's rules one chunk section at a time (docs/CONTRACT.md "Phase 4e contract", "Per-section planning"), pure. A
 * stack is per position, so undoing entries over the positions of one 16x16x16 section needs only the entries that have
 * cells in that section; the plan for whole entries is the union of the per-section plans, with hand-down {@code order}
 * numbered on across the sections in section order. This is what lets a road that spans a village be removed without
 * loading anything outside its own sections. {@code JournalSectionTest} checks it equals whole-entry planning.
 */
public final class Sections {
	private Sections() {
	}

	/** The packed section key of a position ({@code SectionPos.asLong} of its section). */
	public static long key(long pos) {
		return key(Journal.x(pos) >> 4, Journal.y(pos) >> 4, Journal.z(pos) >> 4);
	}

	/** {@code SectionPos.asLong(sx, sy, sz)}: 22 bits x, 20 bits y, 22 bits z. */
	public static long key(int sx, int sy, int sz) {
		long l = 0L;
		l |= ((long) sx & 4194303L) << 42;
		l |= ((long) sy & 1048575L);
		return l | ((long) sz & 4194303L) << 20;
	}

	public static int sx(long key) {
		return (int) (key << 0 >> 42);
	}

	public static int sy(long key) {
		return (int) (key << 44 >> 44);
	}

	public static int sz(long key) {
		return (int) (key << 22 >> 42);
	}

	/** A position's 12-bit index within its section ({@code y << 8 | z << 4 | x}). */
	public static int index(long pos) {
		return (Journal.y(pos) & 15) << 8 | (Journal.z(pos) & 15) << 4 | Journal.x(pos) & 15;
	}

	/** The position of index {@code i} in section {@code key}. */
	public static long pos(long key, int i) {
		return Journal.pos(sx(key) << 4 | i & 15, sy(key) << 4 | i >> 8 & 15, sz(key) << 4 | i >> 4 & 15);
	}

	/** The 512x512 region (column) of a section: {@code (sx >> 5, sz >> 5)} packed like a chunk position. */
	public static long region(long key) {
		return region(sx(key) >> 5, sz(key) >> 5);
	}

	public static long region(int rx, int rz) {
		return (long) rx & 0xFFFFFFFFL | ((long) rz & 0xFFFFFFFFL) << 32;
	}

	public static int rx(long region) {
		return (int) region;
	}

	public static int rz(long region) {
		return (int) (region >>> 32);
	}

	/** An entry's cells by section (ascending keys), each as the entry with only those cells (its undo record sliced too). */
	public static TreeMap<Long, Entry> slice(Entry e) {
		TreeMap<Long, List<Cell>> by = new TreeMap<>();
		for (Cell c : e.cells()) {
			by.computeIfAbsent(key(c.pos()), k -> new ArrayList<>()).add(c);
		}
		TreeMap<Long, Entry> out = new TreeMap<>();
		for (var t : by.entrySet()) {
			Entry s = e.withCells(t.getValue());
			if (e.undo() != null) {
				s = s.status() == Journal.Status.UNDONE ? sliceUndo(s, e.undo(), t.getKey()) : s;
			}
			out.put(t.getKey(), s);
		}
		return out;
	}

	private static Entry sliceUndo(Entry s, Undo u, long section) {
		Map<Long, Value> written = new LinkedHashMap<>();
		u.written().forEach((p, v) -> {
			if (key(p) == section) {
				written.put(p, v);
			}
		});
		List<HandDown> handed = u.handed().stream().filter(h -> key(h.pos()) == section).toList();
		return s.undone(new Undo(u.group(), u.at(), written, handed));
	}

	/**
	 * A plan made section by section: the writes in section order; for every entry the plan changed, its changed cells per
	 * section ({@code cells}: the full cell list of that entry in that section after the plan); the undone entries' undo
	 * records, merged; their stats, summed.
	 */
	public record Plan(List<Journal.Write> writes, Map<String, Map<Long, List<Cell>>> cells, Map<String, Undo> undos, Map<String, Stats> stats) {
	}

	/**
	 * Plans undoing {@code ids} together as {@code group}, one section at a time. {@code slices}: for a section key, every
	 * active entry with a cell in it (and every entry of {@code ids} with one), each holding only its cells in that section.
	 */
	public static Plan plan(SortedSet<Long> sections, Function<Long, Collection<Entry>> slices, Collection<String> ids, String group, long at,
		Journal.World world, Journal.Match match) {
		Set<String> undo = new HashSet<>(ids);
		List<Journal.Write> writes = new ArrayList<>();
		Map<String, Map<Long, List<Cell>>> cells = new LinkedHashMap<>();
		Map<String, Map<Long, Value>> written = new LinkedHashMap<>();
		Map<String, List<HandDown>> handed = new LinkedHashMap<>();
		Map<String, int[]> stats = new LinkedHashMap<>();
		for (String id : ids) {
			written.put(id, new LinkedHashMap<>());
			handed.put(id, new ArrayList<>());
			stats.put(id, new int[3]);
		}
		int offset = 0;
		for (long section : sections) {
			Collection<Entry> loaded = slices.apply(section);
			List<String> here = new ArrayList<>();
			for (Entry e : loaded) {
				if (undo.contains(e.id()) && !e.cells().isEmpty()) {
					here.add(e.id());
				}
			}
			if (here.isEmpty()) {
				continue;
			}
			Journal.UndoPlan p = Journal.planUndo(loaded, here, group, at, world, match);
			writes.addAll(p.writes());
			int top = -1;
			for (var t : p.updated().entrySet()) {
				Entry e = t.getValue();
				if (undo.contains(t.getKey())) {
					Undo u = e.undo();
					written.get(t.getKey()).putAll(u.written());
					for (HandDown h : u.handed()) {
						handed.get(t.getKey()).add(new HandDown(h.order() + offset, h.to(), h.pos(), h.was(), h.now()));
						top = Math.max(top, h.order());
					}
				} else {
					cells.computeIfAbsent(t.getKey(), k -> new TreeMap<>()).put(section, e.cells());
				}
			}
			offset += top + 1;
			p.stats().forEach((id, s) -> {
				int[] a = stats.get(id);
				a[0] += s.restored();
				a[1] += s.changed();
				a[2] += s.covered();
			});
		}
		Map<String, Undo> undos = new LinkedHashMap<>();
		Map<String, Stats> st = new LinkedHashMap<>();
		for (String id : ids) {
			undos.put(id, new Undo(group, at, written.get(id), handed.get(id)));
			int[] a = stats.get(id);
			st.put(id, new Stats(a[0], a[1], a[2]));
		}
		return new Plan(List.copyOf(writes), cells, undos, st);
	}

	/**
	 * {@link Journal#reactivate} one section at a time: {@code slices} gives, per section, the group's undone entries and the
	 * entries they handed to, sliced (undo records included). Returns, per changed entry that is not of the group, its
	 * cells per section; the group's entries themselves become ACTIVE again (the caller drops their undo records).
	 */
	public static Map<String, Map<Long, List<Cell>>> reactivate(SortedSet<Long> sections, Function<Long, Collection<Entry>> slices, String group) {
		Map<String, Map<Long, List<Cell>>> out = new LinkedHashMap<>();
		for (long section : sections) {
			Collection<Entry> loaded = slices.apply(section);
			Set<String> members = new HashSet<>();
			for (Entry e : loaded) {
				if (e.status() == Journal.Status.UNDONE && e.undo() != null && e.undo().group().equals(group)) {
					members.add(e.id());
				}
			}
			for (var t : Journal.reactivate(loaded, group).entrySet()) {
				if (!members.contains(t.getKey())) {
					out.computeIfAbsent(t.getKey(), k -> new TreeMap<>()).put(section, t.getValue().cells());
				}
			}
		}
		return out;
	}
}
