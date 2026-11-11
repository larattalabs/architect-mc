package dev.larattalabs.architect.delta;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.Random;
import org.junit.jupiter.api.Test;

/** 6d FS-b: the lot's local box agrees with the footprint {@link SitePlanner#alignedMin} (the delta's own placement) gives a follower. */
class LotFrameTest {
	@Test
	void unrotateInvertsRotate() {
		for (int turns = 0; turns < 4; turns++) {
			for (int bx = -3; bx < 12; bx++) {
				for (int bz = -3; bz < 9; bz++) {
					int[] r = BlueprintTransform.rotateBlock(bx, bz, 9, 7, turns);
					assertArrayEquals(new int[] {bx, bz}, BlueprintTransform.unrotateBlock(r[0], r[1], 9, 7, turns));
				}
			}
		}
	}

	/** A follower's placed box (alignedMin, rotated size) lies in the lot's world box exactly when its frame box lies in the lot's local box. */
	@Test
	void localContainmentEqualsPlacedContainment() {
		Random rnd = new Random(7);
		int agree = 0;
		int inside = 0;
		for (int i = 0; i < 4000; i++) {
			int turns = i % 4;
			int asx = 5 + rnd.nextInt(8);
			int asz = 5 + rnd.nextInt(8);
			int bsx = 5 + rnd.nextInt(10);
			int bsz = 5 + rnd.nextInt(10);
			int[] oa = {rnd.nextInt(3), rnd.nextInt(3), rnd.nextInt(3)};
			int[] ob = {rnd.nextInt(3), rnd.nextInt(3), rnd.nextInt(3)};
			int[] minA = {rnd.nextInt(100) - 50, 60 + rnd.nextInt(5), rnd.nextInt(100) - 50};
			// the lot: around the standing box, a little bigger or smaller
			int rsx = BlueprintTransform.rotatedSizeX(asx, asz, turns);
			int rsz = BlueprintTransform.rotatedSizeZ(asx, asz, turns);
			Anchors.Bounds lot = new Anchors.Bounds(minA[0] - rnd.nextInt(3), minA[1], minA[2] - rnd.nextInt(3), minA[0] + rsx - 1 + rnd.nextInt(5) - 1, minA[1] + 20,
				minA[2] + rsz - 1 + rnd.nextInt(5) - 1);
			// the follower as the delta places it
			int[] minB = SitePlanner.alignedMin(minA, oa, asx, asz, ob, bsx, bsz, turns);
			int fx = BlueprintTransform.rotatedSizeX(bsx, bsz, turns);
			int fz = BlueprintTransform.rotatedSizeZ(bsx, bsz, turns);
			boolean placed = minB[0] >= lot.minX() && minB[0] + fx - 1 <= lot.maxX() && minB[2] >= lot.minZ() && minB[2] + fz - 1 <= lot.maxZ();
			// the helper's side: the lot's local box, the follower's frame box [oa - ob, oa - ob + size)
			int[] lb = LotFrame.localBox(lot, minA, asx, asz, turns);
			int x0 = oa[0] - ob[0];
			int z0 = oa[2] - ob[2];
			boolean local = x0 >= lb[0] && x0 + bsx - 1 <= lb[3] && z0 >= lb[2] && z0 + bsz - 1 <= lb[5];
			assertEquals(placed, local, "turns " + turns + " lot " + lot + " minB " + java.util.Arrays.toString(minB));
			agree++;
			if (placed) {
				inside++;
			}
		}
		// both outcomes are exercised
		assertEquals(4000, agree);
		org.junit.jupiter.api.Assertions.assertTrue(inside > 100 && inside < 3900, "inside " + inside);
	}
}
