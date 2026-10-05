package dev.larattalabs.architect.placement;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The composite preview's mesh and rules (docs/CONTRACT.md "4c review folded in" item 6). */
class CompositeMeshTest {
	private static final int STONE = 0xFF707070;

	/** A solid box of {@code sx*sy*sz} stone cells. */
	private static GhostModel.Cells box(int sx, int sy, int sz) {
		int n = sx * sy * sz;
		int[] xyz = new int[n * 3];
		int[] argb = new int[n];
		int i = 0;
		for (int y = 0; y < sy; y++) {
			for (int z = 0; z < sz; z++) {
				for (int x = 0; x < sx; x++) {
					xyz[i * 3] = x;
					xyz[i * 3 + 1] = y;
					xyz[i * 3 + 2] = z;
					argb[i++] = STONE;
				}
			}
		}
		return new GhostModel.Cells(sx, sy, sz, 1, xyz, argb);
	}

	@Test
	void oneCellPerStyle() {
		GhostModel one = GhostModel.of(box(1, 1, 1), 0);
		CompositeMesh g = CompositeMesh.build(one, CompositeMesh.Style.GHOST);
		assertEquals(6, g.quads);
		assertEquals(72, g.xyz.length);
		assertEquals(1, g.cells);
		assertEquals(0x5A, g.argb[0] >>> 24);
		CompositeMesh r = CompositeMesh.build(one, CompositeMesh.Style.REMOVED);
		assertEquals(30, r.quads, "REMOVED: a faint fill and a 4-bar frame per face");
		int frames = 0;
		for (int c : r.argb) {
			if (c == CompositeMesh.outlineColor(CompositeMesh.Style.REMOVED)) {
				frames++;
			}
		}
		assertEquals(24, frames);
		// inflated per style, relative to the origin
		float min = Float.MAX_VALUE;
		for (float v : g.xyz) {
			min = Math.min(min, v);
		}
		assertEquals(-0.005f, min, 1e-6);
	}

	@Test
	void exposedFacesOnly() {
		CompositeMesh m = CompositeMesh.build(GhostModel.of(box(4, 3, 5), 0), CompositeMesh.Style.MASSING);
		assertEquals(2 * (4 * 3 + 4 * 5 + 3 * 5), m.quads, "a solid box draws only its surface");
		assertEquals(60, m.cells);
		// rotation swaps x and z
		CompositeMesh r = CompositeMesh.build(GhostModel.of(box(4, 3, 5), 1), CompositeMesh.Style.MASSING);
		assertEquals(5, r.sizeX);
		assertEquals(4, r.sizeZ);
	}

	@Test
	void stylesAreDistinct() {
		Set<Integer> fills = new HashSet<>();
		Set<Integer> outlines = new HashSet<>();
		for (CompositeMesh.Style s : CompositeMesh.Style.values()) {
			fills.add(CompositeMesh.tint(s, STONE));
			outlines.add(CompositeMesh.outlineColor(s));
		}
		assertEquals(5, fills.size());
		assertEquals(5, outlines.size());
		int added = CompositeMesh.tint(CompositeMesh.Style.ADDED, STONE);
		assertTrue(((added >> 8) & 0xFF) > ((added >> 16) & 0xFF), "ADDED reads green");
		int removed = CompositeMesh.outlineColor(CompositeMesh.Style.REMOVED);
		assertTrue(((removed >> 16) & 0xFF) > 200 && ((removed >> 8) & 0xFF) < 80, "REMOVED outlines are red");
	}

	@Test
	void onlyCellsInTemplateCoordinates() {
		GhostModel.Cells c = box(3, 1, 1);
		// make the middle cell air: listed, it is drawn in the given colour
		c.argb()[1] = 0;
		Set<Long> only = Set.of(CompositeMesh.cellKey(1, 0, 0), CompositeMesh.cellKey(2, 0, 0));
		GhostModel.Cells f = CompositeMesh.filter(c, only, 0xFFB0B0B0);
		assertEquals(2, f.count());
		assertEquals(0xFFB0B0B0, f.argb()[0]);
		CompositeMesh m = CompositeMesh.build(GhostModel.of(f, 0), CompositeMesh.Style.CHANGED);
		assertEquals(2, m.cells);
		assertEquals(10, m.quads, "two touching cells: 10 exposed faces");
		assertEquals(3, m.sizeX, "the layer keeps the template's box");
		// a rotated layer still selects by template coordinates: cell (2,0,0) of a 3x1x1 template turned once lands at z 2
		GhostModel turned = GhostModel.of(CompositeMesh.filter(box(3, 1, 1), Set.of(CompositeMesh.cellKey(2, 0, 0)), 0), 1);
		assertEquals(1, turned.count());
		assertEquals(0, turned.x(0));
		assertEquals(2, turned.z(0));
		assertTrue(CompositeMesh.filter(c, null, 0) == c, "null = every cell");
	}

	@Test
	void capAndDistance() {
		assertArrayEquals(new boolean[] {false, true, false}, CompositeMesh.overCap(new int[] {150_000, 60_000, 40_000}, 200_000),
			"a layer that would pass the cap is an outline; a later smaller one still fits");
		assertArrayEquals(new boolean[] {false, false}, CompositeMesh.overCap(new int[] {100_000, 100_000}, 200_000), "exactly the cap fits");
		assertArrayEquals(new boolean[] {true}, CompositeMesh.overCap(new int[] {200_001}, 200_000));
		assertEquals(0, CompositeMesh.distanceToBox(5, 5, 5, 0, 0, 0, 10, 10, 10), 1e-9);
		assertEquals(5, CompositeMesh.distanceToBox(15, 5, 5, 0, 0, 0, 10, 10, 10), 1e-9);
		assertFalse(CompositeMesh.tooFar(160));
		assertTrue(CompositeMesh.tooFar(160.5));
		assertArrayEquals(new int[] {100, 120, 133}, CompositeMesh.row(new int[] {16, 9, 12}, 4, 100));
		CompositeMesh outline = CompositeMesh.outlineOnly(CompositeMesh.Style.GHOST, 3, 4, 5, 60);
		assertFalse(outline.hasCells());
		assertTrue(CompositeMesh.outlineOnly(CompositeMesh.Style.GHOST, 1, 1, 1, 0).hasCells(), "an empty layer has nothing to lose");
	}
}
