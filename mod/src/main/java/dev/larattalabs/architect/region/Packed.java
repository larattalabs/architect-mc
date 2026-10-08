package dev.larattalabs.architect.region;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.GZIPInputStream;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.state.BlockState;

/**
 * A packed tile ({@code ARTL}, kit/REGIONS.md "Packed tiles"): the cells the kit's evaluator wrote for one tile, decoded off
 * the server thread. Cells come in the order of the payload (sections by (sx, sz, sy), positions ascending within a section).
 */
public final class Packed {
	public static final int IF_NATURAL = 0;
	public static final int IF_SOLID_NATURAL = 1;
	public static final int IF_AIR_OR_FLUID = 2;
	public static final int ALWAYS_OURS = 3;
	private static final byte[] MAGIC = "ARTL".getBytes(StandardCharsets.US_ASCII);

	/** Decoded cells: positions ({@link BlockPos#asLong}), state index into {@code states}, cond (0-3), walk. */
	public record Tile(long[] pos, int[] state, byte[] cond, boolean[] walk, List<BlockState> states, List<String> stateIds, String sha) {
		public int size() {
			return pos.length;
		}
	}

	private Packed() {
	}

	public static byte[] gunzip(byte[] gz) throws IOException {
		try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(gz), 1 << 16)) {
			return in.readAllBytes();
		}
	}

	public static String sha256(byte[] a) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(a));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	/** Decodes an uncompressed payload; block states are parsed with vanilla's parser (unknown ones throw). */
	public static Tile decode(byte[] a) {
		R r = new R(a);
		for (byte m : MAGIC) {
			if (r.u8() != (m & 0xff)) {
				throw new IllegalArgumentException("not an ARTL payload");
			}
		}
		int ver = r.u8();
		if (ver != 1) {
			throw new IllegalArgumentException("ARTL version " + ver);
		}
		r.p += 3;
		int sections = (int) r.varint();
		List<long[]> posChunks = new ArrayList<>();
		List<int[]> stChunks = new ArrayList<>();
		List<byte[]> condChunks = new ArrayList<>();
		List<boolean[]> walkChunks = new ArrayList<>();
		List<String> ids = new ArrayList<>();
		java.util.Map<String, Integer> idIndex = new java.util.HashMap<>();
		int total = 0;
		for (int s = 0; s < sections; s++) {
			int sx = r.zigzag();
			int sy = r.zigzag();
			int sz = r.zigzag();
			int pal = (int) r.varint();
			int[] map = new int[pal];
			for (int k = 0; k < pal; k++) {
				int len = (int) r.varint();
				String id = new String(a, r.p, len, StandardCharsets.UTF_8);
				r.p += len;
				Integer at = idIndex.get(id);
				if (at == null) {
					at = ids.size();
					ids.add(id);
					idIndex.put(id, at);
				}
				map[k] = at;
			}
			int n = (int) r.varint();
			long[] ps = new long[n];
			byte[] cs = new byte[n];
			boolean[] ws = new boolean[n];
			int bx = sx << 4;
			int by = sy << 4;
			int bz = sz << 4;
			int last = -1;
			for (int i = 0; i < n; i++) {
				int v = r.u16();
				int pos = v & 0xfff;
				if (pos <= last) {
					throw new IllegalArgumentException("ARTL positions not ascending in section " + sx + "," + sy + "," + sz);
				}
				last = pos;
				ps[i] = BlockPos.asLong(bx + (pos & 15), by + (pos >> 8 & 15), bz + (pos >> 4 & 15));
				cs[i] = (byte) (v >> 12 & 3);
				ws[i] = (v >> 14 & 1) != 0;
			}
			int[] st = new int[n];
			if (pal == 1) {
				java.util.Arrays.fill(st, map[0]);
			} else if (pal <= 256) {
				for (int i = 0; i < n; i++) {
					st[i] = map[r.u8()];
				}
			} else {
				for (int i = 0; i < n; i++) {
					st[i] = map[r.u16()];
				}
			}
			posChunks.add(ps);
			stChunks.add(st);
			condChunks.add(cs);
			walkChunks.add(ws);
			total += n;
		}
		if (r.p != a.length) {
			throw new IllegalArgumentException("ARTL trailing bytes: " + (a.length - r.p));
		}
		long[] pos = new long[total];
		int[] st = new int[total];
		byte[] cond = new byte[total];
		boolean[] walk = new boolean[total];
		int o = 0;
		for (int s = 0; s < posChunks.size(); s++) {
			int n = posChunks.get(s).length;
			System.arraycopy(posChunks.get(s), 0, pos, o, n);
			System.arraycopy(stChunks.get(s), 0, st, o, n);
			System.arraycopy(condChunks.get(s), 0, cond, o, n);
			System.arraycopy(walkChunks.get(s), 0, walk, o, n);
			o += n;
		}
		List<BlockState> states = new ArrayList<>(ids.size());
		for (String id : ids) {
			states.add(parse(id));
		}
		return new Tile(pos, st, cond, walk, states, ids, sha256(a));
	}

	public static BlockState parse(String id) {
		try {
			return BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, id, false).blockState();
		} catch (CommandSyntaxException e) {
			throw new IllegalArgumentException("unknown block state " + id + ": " + e.getMessage());
		}
	}

	/** Reassembles gzip frames (in seq order) and checks the sha of the payload. */
	public static byte[] payload(List<byte[]> frames, String sha) throws IOException {
		ByteArrayOutputStream out = new ByteArrayOutputStream();
		for (byte[] f : frames) {
			out.write(f);
		}
		byte[] p = gunzip(out.toByteArray());
		String got = sha256(p);
		if (!got.equals(sha)) {
			throw new IOException("tile sha " + got + " != " + sha);
		}
		return p;
	}

	private static final class R {
		final byte[] a;
		int p;

		R(byte[] a) {
			this.a = a;
		}

		int u8() {
			return a[p++] & 0xff;
		}

		int u16() {
			int v = (a[p] & 0xff) | (a[p + 1] & 0xff) << 8;
			p += 2;
			return v;
		}

		long varint() {
			long v = 0;
			int shift = 0;
			while (true) {
				int b = u8();
				v |= (long) (b & 0x7f) << shift;
				if ((b & 0x80) == 0) {
					return v;
				}
				shift += 7;
				if (shift > 63) {
					throw new IllegalArgumentException("bad varint");
				}
			}
		}

		int zigzag() {
			long v = varint();
			return (int) ((v >>> 1) ^ -(v & 1));
		}
	}
}
