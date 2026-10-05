package dev.larattalabs.architect.survival;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.Base64;
import java.util.BitSet;

/**
 * The compact forms a construction site's cell sets travel and rest in (pure):
 * <ul>
 * <li>a bitset over the queue (built cells, free cells) as {@code long[]} words, or as base64 in the site record;</li>
 * <li>a list of queue indexes (a tick's newly built cells: the {@code site_progress} delta, or the queue itself) as
 * zig-zag varints of the differences between consecutive values (small for cells next to each other).</li>
 * </ul>
 */
public final class CellBits {
	private CellBits() {
	}

	public static long[] words(BitSet bits) {
		return bits.toLongArray();
	}

	public static BitSet fromWords(long[] words) {
		return BitSet.valueOf(words);
	}

	/** Base64 of the bitset's little-endian bytes; "" for an empty set. */
	public static String base64(BitSet bits) {
		return Base64.getEncoder().withoutPadding().encodeToString(bits.toByteArray());
	}

	public static BitSet fromBase64(String s) {
		return s == null || s.isEmpty() ? new BitSet() : BitSet.valueOf(Base64.getDecoder().decode(s));
	}

	/** Delta + zig-zag varint bytes of {@code values} (any order; negative steps cost a little more). */
	public static byte[] encodeInts(int[] values) {
		ByteArrayOutputStream out = new ByteArrayOutputStream(values.length + 4);
		writeVar(out, values.length);
		int prev = 0;
		for (int v : values) {
			int d = v - prev;
			writeVar(out, (d << 1) ^ (d >> 31));
			prev = v;
		}
		return out.toByteArray();
	}

	public static int[] decodeInts(byte[] bytes) {
		int[] pos = {0};
		int n = readVar(bytes, pos);
		if (n < 0 || n > bytes.length * 8) {
			throw new IllegalArgumentException("bad length " + n);
		}
		int[] out = new int[n];
		int prev = 0;
		for (int i = 0; i < n; i++) {
			int z = readVar(bytes, pos);
			int d = (z >>> 1) ^ -(z & 1);
			prev += d;
			out[i] = prev;
		}
		return out;
	}

	public static String intsBase64(int[] values) {
		return Base64.getEncoder().withoutPadding().encodeToString(encodeInts(values));
	}

	public static int[] intsFromBase64(String s) {
		return s == null || s.isEmpty() ? new int[0] : decodeInts(Base64.getDecoder().decode(s));
	}

	/** Applies a delta: sets every index in {@code newlyBuilt} (indexes outside {@code 0..size-1} are ignored). Returns how many were new. */
	public static int apply(BitSet built, int[] newlyBuilt, int size) {
		int n = 0;
		for (int i : newlyBuilt) {
			if (i >= 0 && i < size && !built.get(i)) {
				built.set(i);
				n++;
			}
		}
		return n;
	}

	/** A tick's newly built cells, sorted (smaller deltas). */
	public static int[] batch(int[] collected, int count) {
		int[] a = Arrays.copyOf(collected, count);
		Arrays.sort(a);
		return a;
	}

	private static void writeVar(ByteArrayOutputStream out, int v) {
		while ((v & ~0x7F) != 0) {
			out.write((v & 0x7F) | 0x80);
			v >>>= 7;
		}
		out.write(v);
	}

	private static int readVar(byte[] b, int[] pos) {
		int v = 0;
		for (int shift = 0; shift < 35; shift += 7) {
			if (pos[0] >= b.length) {
				throw new IllegalArgumentException("truncated varint");
			}
			int x = b[pos[0]++] & 0xFF;
			v |= (x & 0x7F) << shift;
			if ((x & 0x80) == 0) {
				return v;
			}
		}
		throw new IllegalArgumentException("varint too long");
	}
}
