package dev.larattalabs.architect.region.volume;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * ARVX (kit/REGIONS.md "ARVX", gate item 1 "ARVX encoding equal to the JS decoder on fixture columns"). The fixtures in
 * {@code src/test/resources/arvx/} are {@code <name>.bin} (gzip of the encoder's ARVX bytes, the file format) and
 * {@code <name>.json} (the expected decode: box, per column its runs as [classOrdinal, length], owners, ownedRuns, the sha of
 * the uncompressed bytes and the counts per class). The kit's decoder test reads the same pair. This test encodes each JSON
 * and asserts the bytes equal the committed fixture, and decodes the fixture back to the JSON. {@code -Darvx.write=true}
 * (re)writes them.
 */
class ArvxTest {
	static final Path DIR = Path.of("src/test/resources/arvx");

	static int c(VoxelClass v) {
		return v.ordinal();
	}

	/** The fixture specs: name, box, columns as runs ({class, len} or {OWNED, len, ownerId}). */
	static List<Object[]> specs() {
		List<Object[]> out = new ArrayList<>();
		// simple: a 2x2 patch 8 high: rock, soil, air; water over sand; a missing column; a tree
		out.add(new Object[] {"simple", new int[] {0, 60, 0, 1, 67, 1}, new Object[][][] {
			{{c(VoxelClass.ROCK), 3}, {c(VoxelClass.SOIL), 1}, {c(VoxelClass.AIR), 4}},
			{{c(VoxelClass.LOOSE), 2}, {c(VoxelClass.WATER), 3}, {c(VoxelClass.AIR), 3}},
			{{c(VoxelClass.MISSING), 8}},
			{{c(VoxelClass.SOIL), 2}, {c(VoxelClass.LOG), 3}, {c(VoxelClass.LEAVES), 2}, {c(VoxelClass.AIR), 1}}}});
		// owned: owned runs of two entries, adjacent runs of different owners, an owner reused, player blocks and a block entity
		out.add(new Object[] {"owned", new int[] {-3, 0, 5, -2, 9, 6}, new Object[][][] {
			{{c(VoxelClass.ROCK), 2}, {c(VoxelClass.OWNED), 3, "e1"}, {c(VoxelClass.OWNED), 2, "e2"}, {c(VoxelClass.AIR), 3}},
			{{c(VoxelClass.PLAYER), 1}, {c(VoxelClass.BLOCK_ENTITY), 1}, {c(VoxelClass.OWNED), 4, "e1"}, {c(VoxelClass.AIR), 4}},
			{{c(VoxelClass.SNOW), 1}, {c(VoxelClass.ICE), 2}, {c(VoxelClass.LAVA), 1}, {c(VoxelClass.PLANT), 1}, {c(VoxelClass.AIR), 5}},
			{{c(VoxelClass.OWNED), 10, "region rg1 tile t:ground:terrain:0,0 é"}}}});
		// tall: negative y, runs longer than 127 (two-byte varints) and 16383 (three-byte)
		out.add(new Object[] {"tall", new int[] {100, -64, -200, 100, 16399, -198}, new Object[][][] {
			{{c(VoxelClass.ROCK), 130}, {c(VoxelClass.AIR), 16334}},
			{{c(VoxelClass.ROCK), 64}, {c(VoxelClass.WATER), 200}, {c(VoxelClass.AIR), 16200}},
			{{c(VoxelClass.AIR), 16464}}}});
		return out;
	}

	static byte[] encode(int[] box, Object[][][] cols) {
		Arvx.Encoder e = new Arvx.Encoder(box);
		int h = box[4] - box[1] + 1;
		for (Object[][] runs : cols) {
			byte[] cls = new byte[h];
			String[] own = new String[h];
			int y = 0;
			for (Object[] r : runs) {
				for (int k = 0; k < (int) r[1]; k++) {
					cls[y] = (byte) (int) r[0];
					own[y] = r.length > 2 ? (String) r[2] : null;
					y++;
				}
			}
			assertEquals(h, y);
			e.column(cls, own);
		}
		return e.finish();
	}

	static JsonObject expected(String name, byte[] raw) {
		Arvx.Decoded d = Arvx.decode(raw);
		JsonObject o = new JsonObject();
		o.addProperty("name", name);
		o.addProperty("note", "ARVX fixture written by mod ArvxTest (-Darvx.write=true); <name>.bin = gzip(ARVX), sha over the uncompressed bytes");
		JsonObject b = new JsonObject();
		String[] k = {"minX", "minY", "minZ", "maxX", "maxY", "maxZ"};
		for (int i = 0; i < 6; i++) {
			b.addProperty(k[i], d.box()[i]);
		}
		o.add("box", b);
		o.addProperty("sha", Arvx.sha256(raw));
		o.addProperty("bytes", raw.length);
		JsonArray cols = new JsonArray();
		for (int[][] runs : d.columns()) {
			JsonArray rs = new JsonArray();
			for (int[] r : runs) {
				JsonArray p = new JsonArray();
				p.add(r[0]);
				p.add(r[1]);
				rs.add(p);
			}
			cols.add(rs);
		}
		o.add("columns", cols);
		JsonArray ow = new JsonArray();
		d.owners().forEach(ow::add);
		o.add("owners", ow);
		JsonArray or = new JsonArray();
		for (int v : d.ownedRuns()) {
			or.add(v);
		}
		o.add("ownedRuns", or);
		JsonObject counts = new JsonObject();
		long[] cnt = new long[VoxelClass.values().length];
		for (int[][] runs : d.columns()) {
			for (int[] r : runs) {
				cnt[r[0]] += r[1];
			}
		}
		for (VoxelClass v : VoxelClass.values()) {
			counts.addProperty(v.name(), cnt[v.ordinal()]);
		}
		o.add("counts", counts);
		return o;
	}

	@Test
	void fixturesMatch() throws Exception {
		boolean write = Boolean.getBoolean("arvx.write");
		for (Object[] s : specs()) {
			String name = (String) s[0];
			byte[] raw = encode((int[]) s[1], (Object[][][]) s[2]);
			JsonObject exp = expected(name, raw);
			Path bin = DIR.resolve(name + ".bin");
			Path json = DIR.resolve(name + ".json");
			if (write) {
				Files.createDirectories(DIR);
				Files.write(bin, Arvx.gzip(raw));
				Files.writeString(json, new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(exp) + "\n", StandardCharsets.UTF_8);
			}
			byte[] fixture = Arvx.gunzip(Files.readAllBytes(bin));
			assertArrayEquals(fixture, raw, name + ": encoder output differs from the committed fixture");
			JsonObject committed = JsonParser.parseString(Files.readString(json)).getAsJsonObject();
			assertEquals(committed, exp, name + ": the decode differs from the committed JSON");
			assertEquals(committed.get("sha").getAsString(), Arvx.sha256(fixture));
		}
	}

	@Test
	void runsMergeAndOwnersSplit() {
		byte[] raw = encode(new int[] {0, 0, 0, 0, 3, 0}, new Object[][][] {{{c(VoxelClass.OWNED), 2, "a"}, {c(VoxelClass.OWNED), 2, "b"}}});
		Arvx.Decoded d = Arvx.decode(raw);
		assertEquals(2, d.columns().get(0).length);
		assertEquals(List.of("a", "b"), d.owners());
		assertArrayEquals(new int[] {0, 1}, d.ownedRuns());
		assertEquals(c(VoxelClass.OWNED), d.classAt(0, 3, 0));
		// same class twice merges into one run
		Arvx.Encoder e = new Arvx.Encoder(new int[] {0, 0, 0, 0, 3, 0});
		e.column(new byte[] {1, 1, 1, 0}, null);
		assertEquals(2, Arvx.decode(e.finish()).columns().get(0).length);
	}

	@Test
	void layoutErrors() {
		Arvx.Encoder e = new Arvx.Encoder(new int[] {0, 0, 0, 1, 3, 0});
		e.uniform(VoxelClass.AIR);
		assertThrows(IllegalStateException.class, e::finish);
		assertThrows(IllegalArgumentException.class, () -> e.column(new byte[3], null));
		byte[] ok = encode(new int[] {0, 0, 0, 0, 0, 0}, new Object[][][] {{{0, 1}}});
		byte[] bad = java.util.Arrays.copyOf(ok, ok.length + 1);
		assertThrows(IllegalArgumentException.class, () -> Arvx.decode(bad));
	}

	@Test
	void littleEndianHeader() {
		byte[] raw = encode(new int[] {-1, 2, 3, -1, 2, 3}, new Object[][][] {{{0, 1}}});
		assertEquals('A', raw[0]);
		assertEquals(1, raw[4]);
		assertEquals((byte) 0xFF, raw[8]); // minX = -1, LE
		assertEquals(2, raw[12]); // minY
	}
}
