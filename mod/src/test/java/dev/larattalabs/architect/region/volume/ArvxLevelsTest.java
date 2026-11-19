package dev.larattalabs.architect.region.volume;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.VoxelClass;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 8c slice VS: ARVX version 4 (slice WM's layout, kit/lib/region/volume.mjs: version 3 with each fluid run as (u8 code, u8 level, varint
 * length); levels 1-7 flowing, 8-15 falling, 0 otherwise). The cross-language fixture is the kit's, {@code kit/test/fixtures/wm/levels.bin}
 * (raw ARVX) and {@code levels.json}: the mod's decoder reads every cell's code and level as the kit wrote them, and the sampler's encoder
 * writes the same bytes from the same cells.
 */
class ArvxLevelsTest {
	static final Path KIT = Path.of("../kit/test/fixtures/wm");

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static byte[] raw() throws Exception {
		return Files.readAllBytes(KIT.resolve("levels.bin"));
	}

	/** The decoded volume's columns again through the sampler's encoder (VolumeSurvey.encode), with levels. */
	static VolumeSurvey.Encoded reencode(Arvx.Decoded d) {
		int[] box = d.box();
		int w = box[3] - box[0] + 1, dp = box[5] - box[2] + 1, h = box[4] - box[1] + 1;
		byte[] cells = new byte[w * dp * h];
		int[] blocks = new int[w * dp * h];
		byte[] fluids = new byte[w * dp * h];
		byte[] levels = new byte[w * dp * h];
		boolean[] missing = new boolean[w * dp];
		List<String> palette = new ArrayList<>(d.blockPalette());
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < dp; k++) {
				int c = i * dp + k;
				for (int y = 0; y < h; y++) {
					int x = box[0] + i, yy = box[1] + y, z = box[2] + k;
					int cls = d.classAt(x, yy, z);
					if (cls == VoxelClass.MISSING.ordinal()) {
						missing[c] = true;
						break;
					}
					cells[c * h + y] = (byte) cls;
					blocks[c * h + y] = palette.indexOf(d.blockAt(x, yy, z));
					fluids[c * h + y] = (byte) d.fluidAt(x, yy, z);
					levels[c * h + y] = (byte) d.levelAt(x, yy, z);
				}
			}
		}
		return VolumeSurvey.encode(box, cells, Map.of(), missing, blocks, palette, fluids, levels);
	}

	@Test
	void theKitsFixtureDecodesCellForCell() throws Exception {
		Arvx.Decoded d = Arvx.decode(raw());
		JsonObject exp = JsonParser.parseString(Files.readString(KIT.resolve("levels.json"))).getAsJsonObject();
		assertEquals(Arvx.VERSION_LEVELS, exp.get("version").getAsInt());
		assertEquals(exp.get("sha").getAsString(), Arvx.sha256(raw()));
		int n = 0;
		for (JsonElement e : exp.getAsJsonArray("cells")) {
			JsonArray c = e.getAsJsonArray();
			int x = c.get(0).getAsInt(), y = c.get(1).getAsInt(), z = c.get(2).getAsInt();
			if (d.classAt(x, y, z) == VoxelClass.MISSING.ordinal()) {
				continue;
			}
			assertEquals(c.get(3).getAsString(), Arvx.FLUID_CODES.get(d.fluidAt(x, y, z)), "fluid code at " + x + " " + y + " " + z);
			assertEquals(c.get(4).getAsInt(), d.levelAt(x, y, z), "level at " + x + " " + y + " " + z);
			n++;
		}
		assertEquals(exp.getAsJsonArray("cells").size() > 0, n > 0);
	}

	@Test
	void theSamplersEncoderWritesTheKitsBytes() throws Exception {
		Arvx.Decoded d = Arvx.decode(raw());
		assertEquals(0, d.owners().size(), "the fixture has no owned cell (the re-encode passes no owners)");
		assertArrayEquals(raw(), reencode(d).raw(), "the sampler's encoder writes the kit's version-4 bytes");
	}

	@Test
	void theEncoderRefusesShapesThatDontFit() throws Exception {
		assertThrows(IllegalArgumentException.class, () -> new Arvx.Encoder(new int[] {0, 0, 0, 0, 0, 0}, true, false, true), "levels need fluids");
		Arvx.Encoder e = new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true, true);
		assertThrows(IllegalStateException.class, () -> e.column(new byte[2], null, new int[2], new byte[2]), "a version-4 column needs its levels");
		Arvx.Encoder e2 = new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true, true);
		assertThrows(IllegalArgumentException.class, () -> e2.column(new byte[2], null, new int[2], new byte[] {2, 2}, new byte[] {9, 9}), "a flowing cell's level is 1-7");
		Arvx.Encoder e3 = new Arvx.Encoder(new int[] {0, 0, 0, 0, 1, 0}, true, true);
		assertThrows(IllegalStateException.class, () -> e3.column(new byte[2], null, new int[2], new byte[2], new byte[2]));
		assertEquals(-1, Arvx.decode(ArvxFluidsTest.fixture().raw()).levelAt(21, 63, 5), "a version-3 volume has no level layer");
	}

	@Test
	void theSamplersLevelKeepsEachCodesRange() {
		assertEquals(0, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState()));
		assertEquals(5, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 5)));
		assertEquals(8, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 8)));
		assertEquals(12, VolumeSurvey.levelOf(Blocks.WATER.defaultBlockState().setValue(LiquidBlock.LEVEL, 12)));
		assertEquals(3, VolumeSurvey.levelOf(Blocks.LAVA.defaultBlockState().setValue(LiquidBlock.LEVEL, 11)), "falling lava keeps its distance (code lava_flowing: 1-7)");
		assertEquals(0, VolumeSurvey.levelOf(Blocks.OAK_SLAB.defaultBlockState().setValue(net.minecraft.world.level.block.SlabBlock.WATERLOGGED, true)), "a waterlogged block: 0");
		assertEquals(0, VolumeSurvey.levelOf(Blocks.STONE.defaultBlockState()));
	}
}
