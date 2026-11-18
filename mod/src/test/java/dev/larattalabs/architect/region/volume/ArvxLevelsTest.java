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
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 8c slice VS: ARVX version 4 (version 3 plus each cell's LiquidBlock level, docs/CONTRACT.md "Phase 8c" §2.1, slice 8cF's layout). The
 * cross-language fixture {@code levels.bin} / {@code levels.json} is written by {@link VolumeSurvey#encode} (the sampler's encoder); the
 * kit's decoder reads it (slice WM). {@code -Darvx.write=true} rewrites it. A version-4 volume is its version-3 twin byte for byte (the
 * version byte aside) with the level runs appended; the sampler records the raw LEVEL (falling 8..15 kept).
 */
class ArvxLevelsTest {
	static final Path DIR = Path.of("src/test/resources/arvx");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** ArvxFluidsTest's box with levels: the pool's sources 0, the flowing cell 3, the falling cell 8, a falling cell at 12, the rest 0. */
	static byte[] levels() {
		int w = 3, d = 2, h = 4;
		byte[] lv = new byte[w * d * h];
		lv[(1 * d) * h + 2] = 3;
		lv[(1 * d) * h + 3] = 8;
		lv[(2 * d) * h + 3] = 12; // (22, 63, 5): over the lava, a falling water cell at a raw LEVEL of 12 (8 + 4) as the sampler reads it
		return lv;
	}

	static VolumeSurvey.Encoded fixture() {
		VolumeSurvey.Encoded v3 = ArvxFluidsTest.fixture();
		Arvx.Decoded d3 = Arvx.decode(v3.raw());
		return reencode(d3, levels());
	}

	/** The version-3 fixture's columns again through the sampler's encoder, with levels. */
	static VolumeSurvey.Encoded reencode(Arvx.Decoded d3, byte[] lv) {
		int[] box = d3.box();
		int w = box[3] - box[0] + 1, d = box[5] - box[2] + 1, h = box[4] - box[1] + 1;
		byte[] cells = new byte[w * d * h];
		int[] blocks = new int[w * d * h];
		byte[] fluids = new byte[w * d * h];
		boolean[] missing = new boolean[w * d];
		List<String> palette = List.of("minecraft:air", "minecraft:stone", "minecraft:dirt", "minecraft:water", "minecraft:oak_slab", "minecraft:lava");
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < d; k++) {
				int c = i * d + k;
				for (int y = 0; y < h; y++) {
					int cls = d3.classAt(box[0] + i, box[1] + y, box[2] + k);
					if (cls == VoxelClass.MISSING.ordinal()) {
						missing[c] = true;
						break;
					}
					cells[c * h + y] = (byte) cls;
					blocks[c * h + y] = palette.indexOf(d3.blockAt(box[0] + i, box[1] + y, box[2] + k));
					fluids[c * h + y] = (byte) d3.fluidAt(box[0] + i, box[1] + y, box[2] + k);
				}
			}
		}
		return VolumeSurvey.encode(box, cells, Map.of(), missing, blocks, palette, fluids, lv);
	}

	@Test
	void fixtureMatches() throws Exception {
		VolumeSurvey.Encoded e = fixture();
		Arvx.Decoded dec = Arvx.decode(e.raw());
		JsonObject exp = new JsonObject();
		exp.addProperty("name", "levels");
		exp.addProperty("note", "ARVX version 4 fixture written by mod ArvxLevelsTest (-Darvx.write=true); levels.bin = gzip(ARVX); cells [x, y, z, class, block, fluid, level]");
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
					c.add(dec.levelAt(x, y, z));
					cells.add(c);
				}
			}
		}
		exp.add("cells", cells);
		Path bin = DIR.resolve("levels.bin");
		Path json = DIR.resolve("levels.json");
		if (Boolean.getBoolean("arvx.write")) {
			Files.createDirectories(DIR);
			Files.write(bin, Arvx.gzip(e.raw()));
			Files.writeString(json, new GsonBuilder().setPrettyPrinting().serializeNulls().disableHtmlEscaping().create().toJson(exp) + "\n", StandardCharsets.UTF_8);
		}
		assertArrayEquals(Arvx.gunzip(Files.readAllBytes(bin)), e.raw(), "the encoder's output differs from the committed fixture");
		assertEquals(JsonParser.parseString(Files.readString(json)).getAsJsonObject(), JsonParser.parseString(new GsonBuilder().serializeNulls().create().toJson(exp))
			.getAsJsonObject());
	}

	@Test
	void version4IsVersion3WithTheLevelRunsAppended() {
		byte[] v3 = ArvxFluidsTest.fixture().raw();
		byte[] v4 = fixture().raw();
		assertEquals(Arvx.VERSION_LEVELS, v4[4]);
		byte[] head = Arrays.copyOf(v4, v3.length);
		head[4] = (byte) Arvx.VERSION_FLUIDS;
		assertArrayEquals(v3, head, "a version-4 volume is its version-3 twin, then the level runs");
		Arvx.Decoded d = Arvx.decode(v4);
		assertEquals(3, d.levelAt(21, 62, 5));
		assertEquals(8, d.levelAt(21, 63, 5));
		assertEquals(12, d.levelAt(22, 63, 5));
		assertEquals(0, d.levelAt(20, 63, 5), "a source");
		assertEquals(0, d.levelAt(22, 62, 6), "a missing column reads 0");
		assertEquals(Arvx.decode(v3).fluidAt(21, 63, 5), d.fluidAt(21, 63, 5), "the fluid layer as version 3's");
		assertEquals(-1, Arvx.decode(v3).levelAt(21, 63, 5), "a version-3 volume has no level layer");
	}

	@Test
	void theEncoderRefusesShapesThatDontFit() {
		assertThrows(IllegalArgumentException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 0, 0}, true, false, true), "levels need fluids");
		Arvx.Encoder e = new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true, true);
		assertThrows(IllegalStateException.class, () -> e.column(new byte[2], null, new int[2], new byte[2]), "a version-4 column needs its levels");
		Arvx.Encoder e3 = new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true);
		assertThrows(IllegalStateException.class, () -> e3.column(new byte[2], null, new int[2], new byte[2], new byte[2]));
		byte[] bad = fixture().raw().clone();
		bad[bad.length - 2] = 16; // a level past 15
		assertThrows(IllegalArgumentException.class, () -> Arvx.decode(bad));
	}

	@Test
	void theSamplersLevelIsTheRawLiquidLevel() {
		assertEquals(0, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState()));
		assertEquals(5, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 5)));
		assertEquals(8, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 8)));
		assertEquals(0, VolumeSurvey.levelOf(Blocks.OAK_SLAB.defaultBlockState().setValue(net.minecraft.world.level.block.SlabBlock.WATERLOGGED, true)), "a waterlogged block: 0");
		assertEquals(0, VolumeSurvey.levelOf(Blocks.STONE.defaultBlockState()));
	}
}
