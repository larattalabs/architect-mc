package dev.larattalabs.architect.placed;

import it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.shorts.Short2ShortOpenHashMap;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import java.util.function.IntConsumer;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;
import org.jspecify.annotations.Nullable;

/**
 * One chunk's player-placed cells (docs/CONTRACT.md "Phase 6c slice PT" §1): the Fabric data attachment
 * {@code architect_mc:placed}, saved inside the chunk's own NBT. Per chunk a palette of placer UUIDs (at most 254; the 255th
 * distinct placer in one chunk records as unknown, index {@link #UNKNOWN}) and a palette of build ids (cell build index 0 =
 * incidental); per touched section the cells, each with a placer index and a build index ({@link #value}).
 *
 * <p>In memory a section is sparse (an open-addressed {@code short -> short} map) up to {@link #DENSE_AT} - 1 cells and dense
 * (a 4096-bit mask and a {@code short[4096]}) from {@link #DENSE_AT}. On disk (JournalNbt v2's rule): at most 256 cells as
 * {@code p} (2 bytes per cell, the 12-bit local position, ascending), more as {@code m} (64 longs); then in the same order
 * {@code o} (1 byte per cell, the placer index; omitted when the chunk has one placer) and {@code b} (1 byte per cell, the build
 * index; omitted when uniform, {@code bu} then holds it). Every access is synchronized on this object: the chunk is saved from a
 * copy taken on the server thread, but the codec may run elsewhere.
 */
public final class PlacedChunk {
	public static final int DENSE_AT = 257;
	/** The placer index of an unknown placer (the 255th distinct placer of a chunk). */
	public static final int UNKNOWN = 0xFF;
	static final int MAX_PLACERS = 254;
	static final int MAX_BUILDS = 255;
	public static final UUID NIL = new UUID(0L, 0L);

	private final List<UUID> placers = new ArrayList<>();
	/** Build palette: cell build index i (1..255) is {@code builds.get(i - 1)}. */
	private final List<String> builds = new ArrayList<>();
	private final Int2ObjectOpenHashMap<Sec> sections = new Int2ObjectOpenHashMap<>();
	private int cells;

	/** One section's cells. */
	static final class Sec {
		@Nullable Short2ShortOpenHashMap sparse = new Short2ShortOpenHashMap();
		long @Nullable [] mask;
		short @Nullable [] vals;
		int size;

		Sec() {
			sparse.defaultReturnValue((short) -1);
		}

		int get(int i) {
			if (sparse != null) {
				return sparse.containsKey((short) i) ? sparse.get((short) i) & 0xFFFF : -1;
			}
			return (mask[i >> 6] & 1L << (i & 63)) != 0 ? vals[i] & 0xFFFF : -1;
		}

		/** Returns whether the cell was new. */
		boolean put(int i, int v) {
			if (sparse != null) {
				boolean fresh = !sparse.containsKey((short) i);
				sparse.put((short) i, (short) v);
				if (fresh) {
					size++;
					if (size >= DENSE_AT) {
						dense();
					}
				}
				return fresh;
			}
			boolean fresh = (mask[i >> 6] & 1L << (i & 63)) == 0;
			mask[i >> 6] |= 1L << (i & 63);
			vals[i] = (short) v;
			if (fresh) {
				size++;
			}
			return fresh;
		}

		boolean remove(int i) {
			if (sparse != null) {
				if (!sparse.containsKey((short) i)) {
					return false;
				}
				sparse.remove((short) i);
				size--;
				return true;
			}
			if ((mask[i >> 6] & 1L << (i & 63)) == 0) {
				return false;
			}
			mask[i >> 6] &= ~(1L << (i & 63));
			vals[i] = 0;
			size--;
			if (size <= 128) {
				sparsen();
			}
			return true;
		}

		private void dense() {
			long[] m = new long[64];
			short[] v = new short[4096];
			for (var e : sparse.short2ShortEntrySet()) {
				int i = e.getShortKey() & 0xFFF;
				m[i >> 6] |= 1L << (i & 63);
				v[i] = e.getShortValue();
			}
			mask = m;
			vals = v;
			sparse = null;
		}

		private void sparsen() {
			Short2ShortOpenHashMap s = new Short2ShortOpenHashMap();
			s.defaultReturnValue((short) -1);
			forEach(i -> s.put((short) i, vals[i]));
			sparse = s;
			mask = null;
			vals = null;
		}

		/** Each cell's index, ascending. */
		void forEach(IntConsumer c) {
			if (sparse != null) {
				short[] ks = sparse.keySet().toShortArray();
				Arrays.sort(ks);
				for (short k : ks) {
					c.accept(k & 0xFFF);
				}
				return;
			}
			for (int w = 0; w < 64; w++) {
				long b = mask[w];
				while (b != 0) {
					c.accept(w * 64 + Long.numberOfTrailingZeros(b));
					b &= b - 1;
				}
			}
		}

		long heapBytes() {
			return sparse != null ? 48L + (long) Math.max(16, Integer.highestOneBit(Math.max(1, size) * 4 / 3) * 2) * 4 : 64L * 8 + 4096L * 2 + 48;
		}
	}

	/** A cell's packed value: placer index (high byte) and build index (low byte). */
	public static int value(int placer, int build) {
		return (placer & 0xFF) << 8 | build & 0xFF;
	}

	public static int placerOf(int v) {
		return v >> 8 & 0xFF;
	}

	public static int buildOf(int v) {
		return v & 0xFF;
	}

	/** The 12-bit index of (x, y, z) within its section. */
	public static int index(int x, int y, int z) {
		return (y & 15) << 8 | (z & 15) << 4 | x & 15;
	}

	// ------------------------------------------------------------------ reads

	/** The cell's packed value, or -1 when it is not tracked. */
	public synchronized int get(int x, int y, int z) {
		Sec s = sections.get(y >> 4);
		return s == null ? -1 : s.get(index(x, y, z));
	}

	public synchronized boolean isEmpty() {
		return cells == 0;
	}

	public synchronized int size() {
		return cells;
	}

	/** The UUID of a placer index ({@link #NIL} for {@link #UNKNOWN} or an index past the palette). */
	public synchronized UUID placer(int idx) {
		return idx >= 0 && idx < placers.size() ? placers.get(idx) : NIL;
	}

	/** The build id of a build index (null for 0, incidental). */
	public synchronized @Nullable String build(int idx) {
		return idx <= 0 || idx > builds.size() ? null : builds.get(idx - 1);
	}

	/** The touched section Ys. */
	public synchronized int[] sectionYs() {
		int[] ys = sections.keySet().toIntArray();
		Arrays.sort(ys);
		return ys;
	}

	/** The cells of one section as (index, value) pairs, ascending by index. */
	public synchronized int[] cells(int sy) {
		Sec s = sections.get(sy);
		if (s == null) {
			return new int[0];
		}
		int[] out = new int[s.size * 2];
		int[] k = {0};
		s.forEach(i -> {
			out[k[0]++] = i;
			out[k[0]++] = s.get(i);
		});
		return out;
	}

	public synchronized long heapBytes() {
		long n = 64 + placers.size() * 32L + builds.size() * 48L;
		for (Sec s : sections.values()) {
			n += s.heapBytes();
		}
		return n;
	}

	// ------------------------------------------------------------------ writes (server thread; the caller marks the chunk unsaved)

	/** The palette index of {@code placer}, adding it (the 255th distinct placer is {@link #UNKNOWN}). */
	public synchronized int placerIndex(UUID placer) {
		int i = placers.indexOf(placer);
		if (i >= 0) {
			return i;
		}
		if (placers.size() >= MAX_PLACERS) {
			return UNKNOWN;
		}
		placers.add(placer);
		return placers.size() - 1;
	}

	/** The palette index of build {@code id} (0 for null), adding it; 0 when the palette is full (the cell stays incidental). */
	public synchronized int buildIndex(@Nullable String id) {
		if (id == null) {
			return 0;
		}
		int i = builds.indexOf(id);
		if (i >= 0) {
			return i + 1;
		}
		compactBuilds();
		if (builds.size() >= MAX_BUILDS) {
			return 0;
		}
		builds.add(id);
		return builds.size();
	}

	/** Records a cell; returns whether it changed. */
	public synchronized boolean put(int x, int y, int z, int value) {
		Sec s = sections.computeIfAbsent(y >> 4, k -> new Sec());
		int i = index(x, y, z);
		int old = s.get(i);
		if (old == value) {
			return false;
		}
		if (s.put(i, value)) {
			cells++;
		}
		return true;
	}

	/** Clears a cell; returns its old packed value, or -1 when it was not tracked. */
	public synchronized int remove(int x, int y, int z) {
		Sec s = sections.get(y >> 4);
		if (s == null) {
			return -1;
		}
		int i = index(x, y, z);
		int old = s.get(i);
		if (old < 0) {
			return -1;
		}
		s.remove(i);
		cells--;
		if (s.size == 0) {
			sections.remove(y >> 4);
		}
		return old;
	}

	/** Sets the build index of a tracked cell (the placer kept); no-op when untracked. */
	public synchronized boolean setBuild(int x, int y, int z, int buildIdx) {
		Sec s = sections.get(y >> 4);
		if (s == null) {
			return false;
		}
		int i = index(x, y, z);
		int old = s.get(i);
		if (old < 0 || buildOf(old) == buildIdx) {
			return false;
		}
		s.put(i, value(placerOf(old), buildIdx));
		return true;
	}

	/** Drops build palette entries no cell uses (so a long-lived chunk's palette doesn't fill). */
	private void compactBuilds() {
		if (builds.size() < MAX_BUILDS) {
			return;
		}
		boolean[] used = new boolean[builds.size() + 1];
		for (Sec s : sections.values()) {
			s.forEach(i -> used[buildOf(s.get(i))] = true);
		}
		int[] map = new int[builds.size() + 1];
		List<String> kept = new ArrayList<>();
		for (int i = 1; i <= builds.size(); i++) {
			if (used[i]) {
				kept.add(builds.get(i - 1));
				map[i] = kept.size();
			}
		}
		for (Sec s : sections.values()) {
			s.forEach(i -> {
				int v = s.get(i);
				s.put(i, value(placerOf(v), map[buildOf(v)]));
			});
		}
		builds.clear();
		builds.addAll(kept);
	}

	// ------------------------------------------------------------------ NBT

	/** The attachment's NBT (palettes compacted to the indexes in use). */
	public synchronized CompoundTag write() {
		CompoundTag t = new CompoundTag();
		t.putInt("v", 1);
		// compact both palettes to what the cells use, in first-use order (section Y ascending, index ascending)
		int[] ys = sections.keySet().toIntArray();
		Arrays.sort(ys);
		int[] pmap = new int[256];
		Arrays.fill(pmap, -1);
		int[] bmap = new int[256];
		Arrays.fill(bmap, -1);
		bmap[0] = 0;
		List<UUID> ps = new ArrayList<>();
		List<String> bs = new ArrayList<>();
		for (int y : ys) {
			Sec s = sections.get(y);
			s.forEach(i -> {
				int v = s.get(i);
				int p = placerOf(v);
				if (pmap[p] < 0) {
					if (p == UNKNOWN || p >= placers.size()) {
						pmap[p] = UNKNOWN;
					} else {
						pmap[p] = ps.size();
						ps.add(placers.get(p));
					}
				}
				int b = buildOf(v);
				if (bmap[b] < 0) {
					if (b > builds.size()) {
						bmap[b] = 0;
					} else {
						bs.add(builds.get(b - 1));
						bmap[b] = bs.size();
					}
				}
			});
		}
		ListTag pl = new ListTag();
		for (UUID u : ps) {
			pl.add(new IntArrayTag(uuidInts(u)));
		}
		t.put("placers", pl);
		ListTag bl = new ListTag();
		for (String b : bs) {
			bl.add(StringTag.valueOf(b));
		}
		t.put("builds", bl);
		boolean onePlacer = ps.size() <= 1 && pmap[UNKNOWN] < 0;
		ListTag secs = new ListTag();
		for (int y : ys) {
			Sec s = sections.get(y);
			int n = s.size;
			CompoundTag st = new CompoundTag();
			st.putInt("y", y);
			byte[] o = new byte[n];
			byte[] b = new byte[n];
			int[] k = {0};
			if (n > 256) {
				long[] m = new long[64];
				s.forEach(i -> m[i >> 6] |= 1L << (i & 63));
				st.putLongArray("m", m);
			} else {
				byte[] p = new byte[n * 2];
				int[] j = {0};
				s.forEach(i -> {
					p[j[0] * 2] = (byte) (i >> 8);
					p[j[0] * 2 + 1] = (byte) i;
					j[0]++;
				});
				st.putByteArray("p", p);
			}
			s.forEach(i -> {
				int v = s.get(i);
				o[k[0]] = (byte) pmap[placerOf(v)];
				b[k[0]] = (byte) bmap[buildOf(v)];
				k[0]++;
			});
			if (!onePlacer) {
				st.putByteArray("o", o);
			}
			boolean uniform = true;
			for (int q = 1; q < n; q++) {
				if (b[q] != b[0]) {
					uniform = false;
					break;
				}
			}
			if (uniform) {
				if (n > 0 && b[0] != 0) {
					st.putByte("bu", b[0]);
				}
			} else {
				st.putByteArray("b", b);
			}
			secs.add(st);
		}
		t.put("sections", secs);
		return t;
	}

	/** Reads {@link #write} output; a malformed section is skipped. */
	public static PlacedChunk read(CompoundTag t) {
		PlacedChunk c = new PlacedChunk();
		for (Tag x : t.getListOrEmpty("placers")) {
			if (x instanceof IntArrayTag a && a.getAsIntArray().length == 4) {
				c.placers.add(uuid(a.getAsIntArray()));
			}
		}
		for (Tag x : t.getListOrEmpty("builds")) {
			c.builds.add(x.asString().orElse(""));
		}
		for (Tag x : t.getListOrEmpty("sections")) {
			if (!(x instanceof CompoundTag st)) {
				continue;
			}
			int y = st.getIntOr("y", 0);
			int[] idx;
			long[] m = st.getLongArray("m").orElse(null);
			if (m != null && m.length == 64) {
				int n = 0;
				for (long w : m) {
					n += Long.bitCount(w);
				}
				idx = new int[n];
				int k = 0;
				for (int w = 0; w < 64; w++) {
					long b = m[w];
					while (b != 0) {
						idx[k++] = w * 64 + Long.numberOfTrailingZeros(b);
						b &= b - 1;
					}
				}
			} else {
				byte[] p = st.getByteArray("p").orElse(new byte[0]);
				idx = new int[p.length / 2];
				for (int k = 0; k < idx.length; k++) {
					idx[k] = ((p[k * 2] & 0xFF) << 8 | p[k * 2 + 1] & 0xFF) & 0xFFF;
				}
			}
			byte[] o = st.getByteArray("o").orElse(null);
			byte[] b = st.getByteArray("b").orElse(null);
			int bu = st.getByteOr("bu", (byte) 0) & 0xFF;
			if (o != null && o.length != idx.length || b != null && b.length != idx.length) {
				continue;
			}
			Sec s = new Sec();
			for (int k = 0; k < idx.length; k++) {
				int pi = o == null ? 0 : o[k] & 0xFF;
				int bi = b == null ? bu : b[k] & 0xFF;
				if (s.put(idx[k], value(pi, bi))) {
					c.cells++;
				}
			}
			if (s.size > 0) {
				c.sections.put(y, s);
			}
		}
		return c;
	}

	static int[] uuidInts(UUID u) {
		long m = u.getMostSignificantBits();
		long l = u.getLeastSignificantBits();
		return new int[] {(int) (m >> 32), (int) m, (int) (l >> 32), (int) l};
	}

	static UUID uuid(int[] a) {
		return new UUID((long) a[0] << 32 | a[1] & 0xFFFFFFFFL, (long) a[2] << 32 | a[3] & 0xFFFFFFFFL);
	}
}
