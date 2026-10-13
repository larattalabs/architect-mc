package dev.larattalabs.architect.region.volume;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 6c slice B: ARVX version 2 (the cells' block ids after the owner table, kit/REGIONS.md "ARVX"). The fixture {@code blocks.bin} /
 * {@code blocks.json} is written by {@link VolumeSurvey#encode} (the sampler's encoder) and read by the kit's decodeArvx
 * (kit/test/brush-b.test.mjs): one sha, the same classes and block ids. {@code -Darvx.write=true} rewrites it.
 */
class ArvxBlocksTest {
	static final Path DIR = Path.of("src/test/resources/arvx");

	/** A 3x4x2 box: stone and dirt under air, a chest (BLOCK_ENTITY), an owned cell, a missing column. */
	static VolumeSurvey.Encoded fixture() {
		int[] box = {10, 60, -5, 12, 63, -4};
		int w = 3;
		int d = 2;
		int h = 4;
		byte[] cells = new byte[w * d * h];
		int[] blocks = new int[w * d * h];
		List<String> palette = List.of("minecraft:air", "minecraft:stone", "minecraft:dirt", "minecraft:chest", "minecraft:oak_planks");
		boolean[] missing = new boolean[w * d];
		Map<Integer, String> owners = new HashMap<>();
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < d; k++) {
				int c = i * d + k;
				int base = c * h;
				cells[base] = (byte) VoxelClass.ROCK.ordinal();
				blocks[base] = 1;
				cells[base + 1] = (byte) VoxelClass.SOIL.ordinal();
				blocks[base + 1] = 2;
				cells[base + 2] = (byte) VoxelClass.AIR.ordinal();
				cells[base + 3] = (byte) VoxelClass.AIR.ordinal();
			}
		}
		// a chest on column (11, -5), a planks cell an entry owns on (12, -4), column (10, -4) missing
		cells[(1 * d) * h + 2] = (byte) VoxelClass.BLOCK_ENTITY.ordinal();
		blocks[(1 * d) * h + 2] = 3;
		cells[(2 * d + 1) * h + 2] = (byte) VoxelClass.OWNED.ordinal();
		blocks[(2 * d + 1) * h + 2] = 4;
		owners.put((2 * d + 1) * h + 2, "e7");
		missing[0 * d + 1] = true;
		return VolumeSurvey.encode(box, cells, owners, missing, blocks, palette);
	}

	@Test
	void fixtureMatches() throws Exception {
		VolumeSurvey.Encoded e = fixture();
		Arvx.Decoded dec = Arvx.decode(e.raw());
		JsonObject exp = new JsonObject();
		exp.addProperty("name", "blocks");
		exp.addProperty("note", "ARVX version 2 fixture written by mod ArvxBlocksTest (-Darvx.write=true); blocks.bin = gzip(ARVX)");
		exp.addProperty("sha", e.sha());
		exp.addProperty("version", e.raw()[4]);
		JsonArray pal = new JsonArray();
		dec.blockPalette().forEach(pal::add);
		exp.add("palette", pal);
		JsonArray cells = new JsonArray();
		for (int x = 10; x <= 12; x++) {
			for (int z = -5; z <= -4; z++) {
				for (int y = 60; y <= 63; y++) {
					JsonArray c = new JsonArray();
					c.add(x);
					c.add(y);
					c.add(z);
					c.add(VoxelClass.values()[dec.classAt(x, y, z)].name());
					c.add(dec.classAt(x, y, z) == VoxelClass.MISSING.ordinal() ? null : dec.blockAt(x, y, z));
					cells.add(c);
				}
			}
		}
		exp.add("cells", cells);
		Path bin = DIR.resolve("blocks.bin");
		Path json = DIR.resolve("blocks.json");
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
	void versionsAndBlocks() {
		VolumeSurvey.Encoded e = fixture();
		assertEquals(Arvx.VERSION_BLOCKS, e.raw()[4]);
		Arvx.Decoded d = Arvx.decode(e.raw());
		assertEquals("minecraft:chest", d.blockAt(11, 62, -5));
		assertEquals("minecraft:stone", d.blockAt(12, 60, -4));
		assertEquals("minecraft:oak_planks", d.blockAt(12, 62, -4));
		assertEquals(List.of("e7"), d.owners());
		// the classes are version 1's: the same file without blocks decodes to the same classes
		byte[] v1 = VolumeSurvey.encode(new int[] {10, 60, -5, 12, 63, -4}, new byte[24], Map.of(), new boolean[6]).raw();
		assertEquals(Arvx.VERSION, v1[4]);
		assertNull(Arvx.decode(v1).blockAt(10, 60, -5));
		// a version-2 encoder refuses a column without blocks, and a version-1 encoder one with blocks
		assertThrows(IllegalStateException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true).column(new byte[2], null));
		assertThrows(IllegalStateException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}).column(new byte[2], null, new int[2]));
	}
}
