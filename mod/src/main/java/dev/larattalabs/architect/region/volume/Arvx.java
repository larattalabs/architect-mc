package dev.larattalabs.architect.region.volume;

import dev.larattalabs.architect.api.VoxelClass;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * ARVX, the 3D volume encoding (kit/REGIONS.md "ARVX"), little-endian:
 * <pre>
 * "ARVX" u8 version=1 u8 0 0 0
 * i32 minX, minY, minZ, maxX, maxY, maxZ                      (inclusive)
 * columns, x-major (for x, for z): runs bottom-up from minY: (u8 class, varint length)...   (lengths sum to the height)
 * varint ownerCount, then ownerCount x (varint byteLength + UTF-8 entry id)
 * varint ownedRuns, then per OWNED run in file order: varint ownerIndex
 * </pre>
 * The file on disk is the gzip of these bytes; the volume's sha is SHA-256 of the <b>uncompressed</b> bytes. Varints are
 * unsigned LEB128 (as {@code kit/lib/region/pack.mjs}). Pure: no Minecraft classes.
 */
public final class Arvx {
	public static final int VERSION = 1;
	private static final byte[] MAGIC = "ARVX".getBytes(StandardCharsets.US_ASCII);
	private static final int OWNED = VoxelClass.OWNED.ordinal();

	private Arvx() {
	}

	/**
	 * Writes a volume column by column ({@link #column}, x-major), then {@link #finish}. Owners are entry ids, numbered in the
	 * order they first appear.
	 */
	public static final class Encoder {
		final int[] box;
		final int height;
		final long columnsTotal;
		long columns;
		final Out out = new Out(1 << 16);
		final Map<String, Integer> owners = new LinkedHashMap<>();
		final Out ownedRuns = new Out(256);
		int ownedRunCount;
		final long[] counts = new long[VoxelClass.values().length];

		/** {@code box} = {minX, minY, minZ, maxX, maxY, maxZ}, inclusive. */
		public Encoder(int[] box) {
			if (box[3] < box[0] || box[4] < box[1] || box[5] < box[2]) {
				throw new IllegalArgumentException("empty box");
			}
			this.box = box.clone();
			this.height = box[4] - box[1] + 1;
			this.columnsTotal = (long) (box[3] - box[0] + 1) * (box[5] - box[2] + 1);
			out.bytes(MAGIC);
			out.u8(VERSION);
			out.u8(0);
			out.u8(0);
			out.u8(0);
			for (int v : box) {
				out.i32(v);
			}
		}

		/**
		 * The next column (x-major order), bottom-up from minY: {@code cls[i]} the class ordinal of cell {@code minY + i};
		 * {@code owner[i]} the owning entry id of an OWNED cell (ignored for other classes; may be null when there is none).
		 */
		public void column(byte[] cls, String[] owner) {
			if (cls.length != height) {
				throw new IllegalArgumentException("column of " + cls.length + " cells, the box is " + height + " high");
			}
			if (columns >= columnsTotal) {
				throw new IllegalStateException("more columns than the box holds");
			}
			columns++;
			int i = 0;
			while (i < height) {
				int c = cls[i] & 0xFF;
				String o = c == OWNED && owner != null ? owner[i] : null;
				int j = i + 1;
				while (j < height && (cls[j] & 0xFF) == c && (c != OWNED || java.util.Objects.equals(o, owner == null ? null : owner[j]))) {
					j++;
				}
				out.u8(c);
				out.varint(j - i);
				counts[c] += j - i;
				if (c == OWNED) {
					String id = o == null ? "" : o;
					Integer k = owners.get(id);
					if (k == null) {
						k = owners.size();
						owners.put(id, k);
					}
					ownedRuns.varint(k);
					ownedRunCount++;
				}
				i = j;
			}
		}

		/** A column of one class (MISSING for a column not read). */
		public void uniform(VoxelClass c) {
			if (columns >= columnsTotal) {
				throw new IllegalStateException("more columns than the box holds");
			}
			columns++;
			out.u8(c.ordinal());
			out.varint(height);
			counts[c.ordinal()] += height;
		}

		public long[] counts() {
			return counts.clone();
		}

		/** The uncompressed ARVX bytes (every column written). */
		public byte[] finish() {
			if (columns != columnsTotal) {
				throw new IllegalStateException(columns + " of " + columnsTotal + " columns written");
			}
			out.varint(owners.size());
			for (String id : owners.keySet()) {
				byte[] b = id.getBytes(StandardCharsets.UTF_8);
				out.varint(b.length);
				out.bytes(b);
			}
			out.varint(ownedRunCount);
			out.bytes(ownedRuns.result());
			return out.result();
		}
	}

	/** A decoded volume: per column (x-major) its runs as {class, length} pairs, the owners, and per OWNED run its owner. */
	public record Decoded(int[] box, List<int[][]> columns, List<String> owners, int[] ownedRuns) {
		public int width() {
			return box[3] - box[0] + 1;
		}

		public int depth() {
			return box[5] - box[2] + 1;
		}

		/** The class of a cell (world coordinates). */
		public int classAt(int x, int y, int z) {
			int[][] runs = columns.get((x - box[0]) * depth() + (z - box[2]));
			int at = y - box[1];
			for (int[] r : runs) {
				if (at < r[1]) {
					return r[0];
				}
				at -= r[1];
			}
			throw new IllegalArgumentException("outside the box");
		}
	}

	/** Decodes uncompressed ARVX bytes (checks the layout: every column's runs sum to the height). */
	public static Decoded decode(byte[] a) {
		In in = new In(a);
		for (byte m : MAGIC) {
			if (in.u8() != (m & 0xFF)) {
				throw new IllegalArgumentException("not ARVX");
			}
		}
		int ver = in.u8();
		if (ver != VERSION) {
			throw new IllegalArgumentException("ARVX version " + ver);
		}
		in.p += 3;
		int[] box = new int[6];
		for (int i = 0; i < 6; i++) {
			box[i] = in.i32();
		}
		int h = box[4] - box[1] + 1;
		long n = (long) (box[3] - box[0] + 1) * (box[5] - box[2] + 1);
		List<int[][]> cols = new ArrayList<>();
		int owned = 0;
		for (long c = 0; c < n; c++) {
			List<int[]> runs = new ArrayList<>();
			int sum = 0;
			while (sum < h) {
				int cls = in.u8();
				int len = (int) in.varint();
				if (len <= 0 || cls >= VoxelClass.values().length) {
					throw new IllegalArgumentException("bad run in column " + c);
				}
				runs.add(new int[] {cls, len});
				sum += len;
				owned += cls == OWNED ? 1 : 0;
			}
			if (sum != h) {
				throw new IllegalArgumentException("column " + c + " runs sum to " + sum + ", not " + h);
			}
			cols.add(runs.toArray(new int[0][]));
		}
		int oc = (int) in.varint();
		List<String> owners = new ArrayList<>();
		for (int i = 0; i < oc; i++) {
			int len = (int) in.varint();
			owners.add(new String(a, in.p, len, StandardCharsets.UTF_8));
			in.p += len;
		}
		int or = (int) in.varint();
		if (or != owned) {
			throw new IllegalArgumentException(or + " owned runs listed, " + owned + " in the columns");
		}
		int[] ownedRuns = new int[or];
		for (int i = 0; i < or; i++) {
			ownedRuns[i] = (int) in.varint();
		}
		if (in.p != a.length) {
			throw new IllegalArgumentException((a.length - in.p) + " trailing bytes");
		}
		return new Decoded(box, cols, owners, ownedRuns);
	}

	public static String sha256(byte[] a) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(a));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	public static byte[] gzip(byte[] a) {
		ByteArrayOutputStream bo = new ByteArrayOutputStream(Math.max(64, a.length / 4));
		try (GZIPOutputStream g = new GZIPOutputStream(bo, 1 << 16)) {
			g.write(a);
		} catch (IOException e) {
			throw new IllegalStateException(e);
		}
		return bo.toByteArray();
	}

	public static byte[] gunzip(byte[] gz) throws IOException {
		try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz), 1 << 16)) {
			return in.readAllBytes();
		}
	}

	/** A growable little-endian writer (varints as kit/lib/region/pack.mjs ByteWriter). */
	static final class Out {
		byte[] buf;
		int len;

		Out(int cap) {
			buf = new byte[cap];
		}

		void ensure(int n) {
			if (len + n > buf.length) {
				buf = java.util.Arrays.copyOf(buf, Math.max(buf.length * 2, len + n));
			}
		}

		void u8(int v) {
			ensure(1);
			buf[len++] = (byte) v;
		}

		void i32(int v) {
			ensure(4);
			buf[len++] = (byte) v;
			buf[len++] = (byte) (v >> 8);
			buf[len++] = (byte) (v >> 16);
			buf[len++] = (byte) (v >> 24);
		}

		void varint(long v) {
			if (v < 0 || v > 0xFFFFFFFFL) {
				throw new IllegalArgumentException("varint " + v);
			}
			ensure(5);
			while (v >= 128) {
				buf[len++] = (byte) (v & 127 | 128);
				v >>>= 7;
			}
			buf[len++] = (byte) v;
		}

		void bytes(byte[] b) {
			ensure(b.length);
			System.arraycopy(b, 0, buf, len, b.length);
			len += b.length;
		}

		byte[] result() {
			return java.util.Arrays.copyOf(buf, len);
		}
	}

	static final class In {
		final byte[] a;
		int p;

		In(byte[] a) {
			this.a = a;
		}

		int u8() {
			if (p >= a.length) {
				throw new IllegalArgumentException("ARVX: truncated");
			}
			return a[p++] & 0xFF;
		}

		int i32() {
			return u8() | u8() << 8 | u8() << 16 | u8() << 24;
		}

		long varint() {
			long v = 0;
			int shift = 0;
			int b;
			do {
				b = u8();
				v |= (long) (b & 127) << shift;
				shift += 7;
				if (shift > 35) {
					throw new IllegalArgumentException("ARVX: varint too long");
				}
			} while ((b & 128) != 0);
			return v;
		}
	}
}
