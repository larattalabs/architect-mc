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
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 6c slice H: ARVX version 3 (version 2 plus each cell's fluid code, docs/CONTRACT.md "Phase 6c slice H" §10). The cross-language fixture
 * {@code fluids.bin} / {@code fluids.json} is written by {@link VolumeSurvey#encode} (the sampler's encoder) and read by the kit's
 * decodeArvx (kit/test/h-core.test.mjs): one sha, the same classes, block ids and fluid codes. {@code -Darvx.write=true} rewrites it.
 */
class ArvxFluidsTest {
	static final Path DIR = Path.of("src/test/resources/arvx");

	/** A 3x4x2 box: stone and dirt, a water source pool, a flowing and a falling cell, a waterlogged slab, lava, a missing column. */
	static VolumeSurvey.Encoded fixture() {
		int[] box = {20, 60, 5, 22, 63, 6};
		int w = 3;
		int d = 2;
		int h = 4;
		byte[] cells = new byte[w * d * h];
		int[] blocks = new int[w * d * h];
		byte[] fluids = new byte[w * d * h];
		List<String> palette = List.of("minecraft:air", "minecraft:stone", "minecraft:dirt", "minecraft:water", "minecraft:oak_slab", "minecraft:lava");
		boolean[] missing = new boolean[w * d];
		for (int c = 0; c < w * d; c++) {
			int base = c * h;
			cells[base] = (byte) VoxelClass.ROCK.ordinal();
			blocks[base] = 1;
			cells[base + 1] = (byte) VoxelClass.SOIL.ordinal();
			blocks[base + 1] = 2;
		}
		// (20, 5): water sources at 62 and 63; (21, 5): flowing at 62, falling at 63; (21, 6): a waterlogged slab at 62; (22, 5): lava at 62
		int c0 = 0 * d;
		set(cells, blocks, fluids, c0 * h + 2, VoxelClass.WATER, 3, 1);
		set(cells, blocks, fluids, c0 * h + 3, VoxelClass.WATER, 3, 1);
		int c1 = 1 * d;
		set(cells, blocks, fluids, c1 * h + 2, VoxelClass.WATER, 3, 2);
		set(cells, blocks, fluids, c1 * h + 3, VoxelClass.WATER, 3, 3);
		int c2 = 1 * d + 1;
		set(cells, blocks, fluids, c2 * h + 2, VoxelClass.PLAYER, 4, 4);
		int c3 = 2 * d;
		set(cells, blocks, fluids, c3 * h + 2, VoxelClass.LAVA, 5, 5);
		missing[2 * d + 1] = true;
		return VolumeSurvey.encode(box, cells, Map.of(), missing, blocks, palette, fluids);
	}

	static void set(byte[] cells, int[] blocks, byte[] fluids, int i, VoxelClass c, int block, int fluid) {
		cells[i] = (byte) c.ordinal();
		blocks[i] = block;
		fluids[i] = (byte) fluid;
	}

	@Test
	void fixtureMatches() throws Exception {
		VolumeSurvey.Encoded e = fixture();
		Arvx.Decoded dec = Arvx.decode(e.raw());
		JsonObject exp = new JsonObject();
		exp.addProperty("name", "fluids");
		exp.addProperty("note", "ARVX version 3 fixture written by mod ArvxFluidsTest (-Darvx.write=true); fluids.bin = gzip(ARVX)");
		exp.addProperty("sha", e.sha());
		exp.addProperty("version", e.raw()[4]);
		JsonArray cells = new JsonArray();
		for (int x = 20; x <= 22; x++) {
			for (int z = 5; z <= 6; z++) {
				for (int y = 60; y <= 63; y++) {
					JsonArray c = new JsonArray();
					c.add(x);
					c.add(y);
					c.add(z);
					boolean miss = dec.classAt(x, y, z) == VoxelClass.MISSING.ordinal();
					c.add(VoxelClass.values()[dec.classAt(x, y, z)].name());
					c.add(miss ? null : dec.blockAt(x, y, z));
					c.add(miss ? null : Arvx.FLUID_CODES.get(dec.fluidAt(x, y, z)));
					cells.add(c);
				}
			}
		}
		exp.add("cells", cells);
		Path bin = DIR.resolve("fluids.bin");
		Path json = DIR.resolve("fluids.json");
		if (Boolean.getBoolean("arvx.write")) {
			Files.createDirectories(DIR);
			Files.write(bin, Arvx.gzip(e.raw()));
			Files.writeString(json, new GsonBuilder().setPrettyPrinting().serializeNulls().disableHtmlEscaping().create().toJson(exp) + "\n",
				StandardCharsets.UTF_8);
		}
		assertArrayEquals(Arvx.gunzip(Files.readAllBytes(bin)), e.raw(), "the encoder's output differs from the committed fixture");
		assertEquals(JsonParser.parseString(Files.readString(json)).getAsJsonObject(), JsonParser.parseString(new GsonBuilder().serializeNulls().create()
			.toJson(exp)).getAsJsonObject());
	}

	@Test
	void versionsAndFluids() {
		VolumeSurvey.Encoded e = fixture();
		assertEquals(Arvx.VERSION_FLUIDS, e.raw()[4]);
		Arvx.Decoded d = Arvx.decode(e.raw());
		assertEquals(1, d.fluidAt(20, 63, 5));
		assertEquals(3, d.fluidAt(21, 63, 5));
		assertEquals(4, d.fluidAt(21, 62, 6));
		assertEquals(5, d.fluidAt(22, 62, 5));
		assertEquals(0, d.fluidAt(20, 60, 5));
		assertEquals("minecraft:water", d.blockAt(21, 62, 5));
		// a version-2 volume answers no fluid; a version-3 encoder refuses a column without fluids, and needs blocks
		byte[] v2 = VolumeSurvey.encode(new int[] {0, 0, 0, 0, 1, 0}, new byte[2], Map.of(), new boolean[1], new int[2], List.of(Arvx.AIR)).raw();
		assertEquals(Arvx.VERSION_BLOCKS, v2[4]);
		assertEquals(-1, Arvx.decode(v2).fluidAt(0, 0, 0));
		assertThrows(IllegalStateException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true).column(new byte[2], null, new int[2]));
		assertThrows(IllegalArgumentException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, false, true));
	}
}
