package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Sample;
import java.util.List;
import org.junit.jupiter.api.Test;

class SurveyGridTest {
	/** Height = x / 2 + 60, water where z < 4, a tree at (5, 5). */
	private static final SurveyGrid.Columns WORLD = new SurveyGrid.Columns() {
		@Override
		public SurveyGrid.Column column(int x, int z) {
			boolean water = z < 4;
			return new SurveyGrid.Column(60 + Math.floorDiv(x, 2), water ? 55 : 60 + Math.floorDiv(x, 2), water ? "minecraft:water" : "minecraft:grass_block",
				water, x == 5 && z == 5, true);
		}

		@Override
		public String biome(int x, int z) {
			return x < 16 ? "minecraft:plains" : "minecraft:forest";
		}
	};

	@Test
	void fullResolutionWithAMissingChunk() {
		// x 0..31 (chunks 0 and 1), z 0..15 (chunk 0): chunk 1 is not loaded
		SurveyGrid g = new SurveyGrid(0, 0, 31, 15, 1);
		assertEquals(1, g.resolution());
		assertEquals(List.of(SurveyGrid.key(0, 0), SurveyGrid.key(1, 0)), g.chunks());
		Sample s = g.sampleAll(k -> SurveyGrid.keyX(k) == 0, WORLD);
		assertEquals(32, s.width());
		assertEquals(16, s.depth());
		assertEquals(16 * 16, s.missing().cardinality());
		assertFalse(s.isMissing(15, 0));
		assertTrue(s.isMissing(16, 0));
		assertEquals(Sample.MISSING, s.height()[s.index(20, 3)]);
		assertEquals(67, s.height()[s.index(15, 8)]);
		assertTrue(s.water().get(s.index(3, 2)));
		assertFalse(s.water().get(s.index(3, 9)));
		assertTrue(s.tree().get(s.index(5, 5)));
		assertEquals("minecraft:grass_block", s.topBlock(3, 9));
		assertNull(s.topBlock(20, 9));
		assertEquals(1, s.missingChunks().size());
		assertEquals(1, s.missingChunks().get(0)[0]);
		// biomes per 4x4: 8 x 4 cells; those whose centre is in chunk 1 are missing
		assertEquals(8, s.biomeWidth());
		assertEquals(4, s.biomeDepth());
		assertEquals("minecraft:plains", s.biomeAt(2, 2));
		assertNull(s.biomeAt(20, 2));
		// slope: 1 step between columns 2k+1 and 2k+2, never across the missing edge
		assertEquals(1, s.slope()[s.index(1, 8)]);
		assertEquals(Sample.MISSING, s.slope()[s.index(16, 8)]);
		JsonObject j = s.toJson();
		assertTrue(j.getAsJsonArray("height").get(s.index(20, 3)).isJsonNull());
		assertEquals(67, j.getAsJsonArray("height").get(s.index(15, 8)).getAsInt());
		assertEquals(1, j.getAsJsonArray("missingChunks").size());
	}

	@Test
	void coarseResolutionPastTheLimit() {
		SurveyGrid g = new SurveyGrid(-10, -10, 290, 20, 1); // 301 wide: resolution 4
		assertEquals(4, g.resolution());
		Sample s = g.sampleAll(k -> true, WORLD);
		assertEquals(76, s.width()); // ceil(301 / 4)
		assertEquals(8, s.depth()); // ceil(31 / 4)
		assertEquals(0, s.missing().cardinality());
		assertEquals(-10, s.worldX(0));
		assertEquals(290, s.worldX(75));
		assertEquals(60 + Math.floorDiv(290, 2), s.height()[s.index(75, 0)]);
	}

	@Test
	void summaryGridIsAtMost64Wide() {
		SurveyGrid g = new SurveyGrid(0, 0, 199, 9, 1); // 200 x 10 columns
		Sample s = g.sampleAll(k -> SurveyGrid.keyX(k) != 3, WORLD);
		String sum = s.summary();
		List<String> grid = sum.lines().dropWhile(l -> !l.startsWith("height grid")).skip(1).toList();
		assertFalse(grid.isEmpty());
		for (String row : grid) {
			assertTrue(row.length() <= Sample.SUMMARY_GRID, row.length() + ": " + row);
		}
		assertTrue(grid.size() <= Sample.SUMMARY_GRID);
		assertTrue(sum.contains("?"), "the missing chunk shows as ?");
		assertTrue(sum.contains("~"), "water shows as ~");
	}

	@Test
	void nothingLoaded() {
		Sample s = new SurveyGrid(0, 0, 15, 15, 1).sampleAll(k -> false, WORLD);
		assertEquals(256, s.missing().cardinality());
		assertTrue(s.summary().contains("no loaded columns"));
	}
}
