package dev.larattalabs.architect.journal;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * One journal entry's cells in one chunk section (docs/CONTRACT.md "Phase 4e contract", "On disk"): ascending 12-bit
 * positions within the section ({@link Sections#index}), each cell's {@code before}, {@code after} (null: unknown) and layer;
 * for an undone entry, what its undo wrote per cell (null: nothing). Immutable: the arrays are never changed after
 * construction. Pure.
 */
public final class SectionCells {
	public final long key;
	final short[] idx;
	final Value[] before;
	final Value[] after;
	final long[] layer;
	final Value @Nullable [] written;
	/** 4096 bits: which positions of the section have a cell. */
	private final long[] mask;

	SectionCells(long key, short[] idx, Value[] before, Value[] after, long[] layer, Value @Nullable [] written) {
		this.key = key;
		this.idx = idx;
		this.before = before;
		this.after = after;
		this.layer = layer;
		this.written = written;
		this.mask = new long[64];
		for (short s : idx) {
			mask[s >> 6] |= 1L << (s & 63);
		}
	}

	/** The cells of one section (all of {@code cells} must lie in section {@code key}); {@code written}: an undo's writes, or null. */
	public static SectionCells of(long key, Collection<Cell> cells, @Nullable Map<Long, Value> written) {
		Cell[] cs = cells.toArray(new Cell[0]);
		Arrays.sort(cs, (a, b) -> Integer.compare(Sections.index(a.pos()), Sections.index(b.pos())));
		int n = cs.length;
		short[] idx = new short[n];
		Value[] b = new Value[n];
		Value[] a = new Value[n];
		long[] l = new long[n];
		Value[] w = written == null ? null : new Value[n];
		for (int i = 0; i < n; i++) {
			Cell c = cs[i];
			if (Sections.key(c.pos()) != key) {
				throw new IllegalArgumentException("cell " + c.pos() + " is not in section " + key);
			}
			idx[i] = (short) Sections.index(c.pos());
			if (i > 0 && idx[i] == idx[i - 1]) {
				throw new IllegalArgumentException("two cells at one position " + c.pos());
			}
			b[i] = c.before();
			a[i] = c.after();
			l[i] = c.layer();
			if (w != null) {
				w[i] = written.get(c.pos());
			}
		}
		return new SectionCells(key, idx, b, a, l, w);
	}

	public int size() {
		return idx.length;
	}

	/** Whether the section has a cell at index {@code i} (0..4095). */
	public boolean has(int i) {
		return (mask[i >> 6] & 1L << (i & 63)) != 0;
	}

	/** The 4096-bit mask of the positions that have a cell (a copy). */
	public long[] mask() {
		return mask.clone();
	}

	/** Whether any position of {@code other} (a 4096-bit mask) has a cell here. */
	public boolean intersects(long[] other) {
		for (int w = 0; w < 64; w++) {
			if ((mask[w] & other[w]) != 0) {
				return true;
			}
		}
		return false;
	}

	/** The array slot of index {@code i}, or -1. */
	public int find(int i) {
		return has(i) ? Arrays.binarySearch(idx, (short) i) : -1;
	}

	public int index(int k) {
		return idx[k];
	}

	public long pos(int k) {
		return Sections.pos(key, idx[k]);
	}

	public Value before(int k) {
		return before[k];
	}

	public @Nullable Value after(int k) {
		return after[k];
	}

	public long layer(int k) {
		return layer[k];
	}

	public @Nullable Value written(int k) {
		return written == null ? null : written[k];
	}

	public boolean hasUndo() {
		return written != null;
	}

	public Cell cell(int k) {
		return new Cell(pos(k), layer[k], before[k], after[k]);
	}

	/** The cells as journal cells (ascending index). */
	public List<Cell> cells() {
		List<Cell> out = new ArrayList<>(idx.length);
		for (int k = 0; k < idx.length; k++) {
			out.add(cell(k));
		}
		return out;
	}

	/** What the undo wrote, by position (empty without an undo record). */
	public Map<Long, Value> writtenMap() {
		java.util.LinkedHashMap<Long, Value> m = new java.util.LinkedHashMap<>();
		if (written != null) {
			for (int k = 0; k < idx.length; k++) {
				if (written[k] != null) {
					m.put(pos(k), written[k]);
				}
			}
		}
		return m;
	}

	/** The same cells with {@code w} as the undo record (null: none). */
	public SectionCells withWritten(@Nullable Map<Long, Value> w) {
		Value[] ws = null;
		if (w != null) {
			ws = new Value[idx.length];
			for (int k = 0; k < idx.length; k++) {
				ws[k] = w.get(pos(k));
			}
		}
		return new SectionCells(key, idx, before, after, layer, ws);
	}

	/** The same cells with every {@code after} from {@code a} (by position; absent: kept). */
	public SectionCells withAfter(Map<Long, Value> a) {
		Value[] as = after.clone();
		for (int k = 0; k < idx.length; k++) {
			Value v = a.get(pos(k));
			if (v != null) {
				as[k] = v;
			}
		}
		return new SectionCells(key, idx, before, as, layer, written);
	}

	/** Bytes this takes in memory, roughly (the cache's size estimate; values are shared). */
	long weight() {
		return 96L + idx.length * (2L + 8 + 8 + 8 + (written == null ? 0 : 8)) + 512;
	}
}
