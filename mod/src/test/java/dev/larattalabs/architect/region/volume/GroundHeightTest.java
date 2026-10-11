package dev.larattalabs.architect.region.volume;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.larattalabs.architect.api.Sample;
import dev.larattalabs.architect.api.VoxelClass;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * 6c slice 0c §4: {@code Volume.ground} derived from the classified cells (air, fluids, LOG, LEAVES and PLANT aren't ground;
 * OWNED, PLAYER and BLOCK_ENTITY are), and the ARVX bytes and sha unchanged by it (pinned from the encoder before §4).
 */
class GroundHeightTest {
	/** A 5 x 4 x 12 box at (100, 60, 200): soil up to y 63, a tree on column (2, 1), a pond on (0, 0), a roof on (4, 3). */
	static Object[] fixture() {
		int[] box = {100, 60, 200, 104, 71, 203};
		int w = 5;
		int d = 4;
		int h = 12;
		byte[] cells = new byte[w * d * h];
		for (int i = 0; i < w; i++) {
			for (int k = 0; k < d; k++) {
				int base = (i * d + k) * h;
				for (int y = 0; y < h; y++) {
					cells[base + y] = (byte) (y <= 3 ? VoxelClass.SOIL.ordinal() : VoxelClass.AIR.ordinal());
				}
			}
		}
		int tree = (2 * d + 1) * h;
		for (int y = 4; y <= 8; y++) {
			cells[tree + y] = (byte) VoxelClass.LOG.ordinal();
		}
		cells[tree + 9] = (byte) VoxelClass.LEAVES.ordinal();
		cells[tree + 10] = (byte) VoxelClass.LEAVES.ordinal();
		int pond = 0;
		cells[pond + 3] = (byte) VoxelClass.WATER.ordinal();
		cells[pond + 2] = (byte) VoxelClass.WATER.ordinal();
		cells[pond + 4] = (byte) VoxelClass.PLANT.ordinal(); // a lily pad
		int roof = (4 * d + 3) * h;
		for (int y = 4; y <= 7; y++) {
			cells[roof + y] = (byte) VoxelClass.PLAYER.ordinal();
		}
		cells[roof + 8] = (byte) VoxelClass.OWNED.ordinal();
		boolean[] missing = new boolean[w * d];
		missing[(1 * d + 2)] = true;
		int mb = (1 * d + 2) * h;
		java.util.Arrays.fill(cells, mb, mb + h, (byte) VoxelClass.MISSING.ordinal());
		return new Object[] {box, cells, missing};
	}

	@Test
	void groundSkipsTreesFluidsAndPlants() {
		Object[] f = fixture();
		VolumeSurvey.Encoded e = VolumeSurvey.encode((int[]) f[0], (byte[]) f[1], Map.of((4 * 4 + 3) * 12 + 8, "e1"), (boolean[]) f[2]);
		int[] g = e.ground();
		assertEquals(20, g.length);
		int w = 5;
		assertEquals(63, g[2 + 1 * w], "under the tree: the soil");
		assertEquals(61, g[0], "the pond: its bed");
		assertEquals(68, g[4 + 3 * w], "the roof (an OWNED cell on PLAYER blocks) is ground");
		assertEquals(Sample.MISSING, g[1 + 2 * w], "a missing column");
		assertEquals(63, g[3 + 0 * w]);
	}

	@Test
	void arvxBytesAndShaUnchanged() {
		Object[] f = fixture();
		VolumeSurvey.Encoded e = VolumeSurvey.encode((int[]) f[0], (byte[]) f[1], Map.of((4 * 4 + 3) * 12 + 8, "e1"), (boolean[]) f[2]);
		assertEquals(PINNED_SHA, e.sha());
	}

	/** {@code VolumeSurvey.encode} on {@link #fixture} at main (v0.12.0), before §4. */
	static final String PINNED_SHA = "5bd86a37b3622f7b295bbe8d5bf6daa46f6aa8abf1a09006dad6561516da3b0e";
}
