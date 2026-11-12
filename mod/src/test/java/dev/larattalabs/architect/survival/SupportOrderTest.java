package dev.larattalabs.architect.survival;

import static dev.larattalabs.architect.survival.BuildOrder.ATTACHABLE;
import static dev.larattalabs.architect.survival.BuildOrder.FULL;
import static dev.larattalabs.architect.survival.BuildOrder.PARTIAL;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;

/**
 * (7b slice SO) {@link BuildOrder#bySupport}: support distance first, ties by y, then today's rank; every prefix connected; attachables
 * after their support, gravity blocks after the cell under them, pairs together; unreachable cells last; the old order untouched.
 */
class SupportOrderTest {
	/** Cells on a grid: face neighbours among them, the cell below (gravity), anchors given. */
	record Grid(int[][] xyz, int[] y, int[][] neighbours, int[] belowOf) {
		static Grid of(int[][] xyz) {
			int n = xyz.length;
			Map<String, Integer> at = new HashMap<>();
			for (int i = 0; i < n; i++) {
				at.put(xyz[i][0] + "," + xyz[i][1] + "," + xyz[i][2], i);
			}
			int[] y = new int[n];
			int[][] nb = new int[n][];
			int[] below = new int[n];
			int[][] d = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
			for (int i = 0; i < n; i++) {
				y[i] = xyz[i][1];
				List<Integer> l = new ArrayList<>();
				for (int[] e : d) {
					Integer k = at.get((xyz[i][0] + e[0]) + "," + (xyz[i][1] + e[1]) + "," + (xyz[i][2] + e[2]));
					if (k != null) {
						l.add(k);
					}
				}
				nb[i] = l.stream().mapToInt(Integer::intValue).toArray();
				Integer b = at.get(xyz[i][0] + "," + (xyz[i][1] - 1) + "," + xyz[i][2]);
				below[i] = b == null ? -1 : b;
			}
			return new Grid(xyz, y, nb, below);
		}
	}

	static int[] none(int n) {
		int[] a = new int[n];
		Arrays.fill(a, -1);
		return a;
	}

	/** Every cell of the order is an anchor or has a face neighbour earlier in the order (among the reachable). */
	static void assertConnectedPrefixes(int[] order, boolean[] anchor, int[][] nb, int[] dist) {
		boolean[] done = new boolean[order.length];
		for (int k = 0; k < order.length; k++) {
			int i = order[k];
			boolean ok = anchor[i];
			for (int m : nb[i]) {
				ok |= done[m];
			}
			assertTrue(ok || dist[i] == BuildOrder.UNREACHED, "cell " + i + " at position " + k + " is connected when placed");
			done[i] = true;
		}
	}

	static int pos(int[] order, int cell) {
		return BuildOrderTest.pos(order, cell);
	}

	@Test
	void aHangingFloorStartsAtItsHangPointNotItsBottomRow() {
		// a ceiling anchor over a vertical chain (y 5..3) and a floor at y 2 (x 0..3): bottom-up would start mid-air at the floor
		int[][] xyz = {{0, 2, 0}, {1, 2, 0}, {2, 2, 0}, {3, 2, 0}, {0, 3, 0}, {0, 4, 0}, {0, 5, 0}};
		Grid g = Grid.of(xyz);
		boolean[] anchor = new boolean[7];
		anchor[6] = true; // the chain's top touches the overhang
		int[] kind = new int[7];
		int[] order = BuildOrder.bySupport(g.y(), kind, none(7), none(7), anchor, g.neighbours(), none(7));
		assertArrayEquals(new int[] {6, 5, 4, 0, 1, 2, 3}, order);
		int[] old = BuildOrder.order(g.y(), kind, none(7), none(7));
		assertEquals(0, old[0], "today's order starts with the floating floor (why SO exists)");
	}

	@Test
	void tiesByYThenKindThenIndex() {
		// two anchors at y 0 and y 1 (distance 0 both): y first; at equal distance and y, full before partial
		int[][] xyz = {{0, 1, 0}, {5, 0, 0}, {5, 0, 1}, {9, 0, 0}};
		Grid g = Grid.of(xyz);
		boolean[] anchor = {true, true, true, true};
		int[] kind = {FULL, PARTIAL, FULL, FULL};
		int[] order = BuildOrder.bySupport(g.y(), kind, none(4), none(4), anchor, g.neighbours(), none(4));
		assertArrayEquals(new int[] {2, 3, 1, 0}, order);
	}

	@Test
	void attachablesGravityAndPairs() {
		// a span: anchors at both ends (x 0 and x 4, y 0); a lantern (5) hangs under cell 2 at y -1; sand (6) on cell 3; a door (7, 8) on cell 1
		int[][] xyz = {{0, 0, 0}, {1, 0, 0}, {2, 0, 0}, {3, 0, 0}, {4, 0, 0}, {2, -1, 0}, {3, 1, 0}, {1, 1, 0}, {1, 2, 0}};
		Grid g = Grid.of(xyz);
		boolean[] anchor = {true, false, false, false, true, false, false, false, false};
		int[] kind = {FULL, FULL, FULL, FULL, FULL, ATTACHABLE, FULL, ATTACHABLE, ATTACHABLE};
		int[] support = {-1, -1, -1, -1, -1, 2, -1, 1, 7};
		int[] pair = {-1, -1, -1, -1, -1, -1, -1, -1, 7};
		int[] below = none(9);
		below[6] = 3; // sand over cell 3
		int[] order = BuildOrder.bySupport(g.y(), kind, support, pair, anchor, g.neighbours(), below);
		BuildOrderTest.assertPermutation(order, 9);
		assertConnectedPrefixes(order, anchor, g.neighbours(), BuildOrder.distances(anchor, g.neighbours()));
		assertTrue(pos(order, 5) > pos(order, 2), "the lantern after its beam");
		assertTrue(pos(order, 6) > pos(order, 3), "the sand after the cell under it");
		assertEquals(pos(order, 7) + 1, pos(order, 8), "the door's halves together");
		assertTrue(pos(order, 7) > pos(order, 1), "the door after its floor");
	}

	@Test
	void unreachableCellsComeLastAndEveryCellComes() {
		int[][] xyz = {{0, 0, 0}, {1, 0, 0}, {9, 9, 9}, {9, 10, 9}};
		Grid g = Grid.of(xyz);
		boolean[] anchor = {true, false, false, false};
		int[] order = BuildOrder.bySupport(g.y(), new int[4], none(4), none(4), anchor, g.neighbours(), none(4));
		assertArrayEquals(new int[] {0, 1, 2, 3}, order);
	}

	/**
	 * Random shapes (a connected blob plus floating bits), random anchors and kinds; dependencies as buildings have them: an attachable's
	 * support, a gravity block's cell below and a pair's first are closer to the site (or as close) than the cell that waits on them.
	 */
	@Test
	void randomShapesKeepEveryPrefixConnected() {
		Random rnd = new Random(7);
		for (int round = 0; round < 400; round++) {
			int n = 5 + rnd.nextInt(150);
			List<int[]> cells = new ArrayList<>();
			Map<String, Boolean> seen = new HashMap<>();
			int[] c = {0, 0, 0};
			while (cells.size() < n) {
				if (rnd.nextInt(12) == 0) {
					c = new int[] {rnd.nextInt(40), rnd.nextInt(40), rnd.nextInt(40)};
				} else {
					int a = rnd.nextInt(3);
					c = c.clone();
					c[a] += rnd.nextBoolean() ? 1 : -1;
				}
				if (seen.putIfAbsent(c[0] + "," + c[1] + "," + c[2], true) == null) {
					cells.add(c);
				}
			}
			Grid g = Grid.of(cells.toArray(int[][]::new));
			int[][] nb = g.neighbours();
			boolean[] anchor = new boolean[n];
			for (int i = 0; i < n; i++) {
				anchor[i] = rnd.nextInt(12) == 0;
			}
			int[] dist = BuildOrder.distances(anchor, nb);
			int[] kind = new int[n];
			int[] support = none(n);
			int[] pair = none(n);
			int[] below = none(n);
			for (int i = 0; i < n; i++) {
				kind[i] = rnd.nextInt(3);
				List<Integer> closer = new ArrayList<>();
				for (int m : nb[i]) {
					if (dist[m] < dist[i]) {
						closer.add(m);
					}
				}
				if (kind[i] == ATTACHABLE && !closer.isEmpty()) {
					support[i] = closer.get(rnd.nextInt(closer.size()));
				}
				int b = g.belowOf()[i];
				if (b >= 0 && dist[b] < dist[i] && rnd.nextInt(6) == 0) {
					below[i] = b;
				}
			}
			for (int i = 0; i < n; i++) {
				int up = -1;
				for (int m : nb[i]) {
					if (g.xyz()[m][1] == g.xyz()[i][1] + 1) {
						up = m;
					}
				}
				if (up >= 0 && dist[i] <= dist[up] && rnd.nextInt(10) == 0 && pair[i] < 0 && pair[up] < 0 && support[up] < 0 && below[up] < 0) {
					boolean waitedOn = false;
					for (int j = 0; j < n; j++) {
						waitedOn |= support[j] == up || below[j] == up || pair[j] == up;
					}
					if (!waitedOn) {
						pair[up] = i; // a door's upper half rides with its lower half
					}
				}
			}
			int[] order = BuildOrder.bySupport(g.y(), kind, support, pair, anchor, nb, below);
			BuildOrderTest.assertPermutation(order, n);
			assertConnectedPrefixes(order, anchor, nb, dist);
			boolean[] done = new boolean[n];
			boolean unreachedSeen = false;
			for (int k = 0; k < n; k++) {
				int i = order[k];
				int dep = BuildOrder.dependency(i, kind, support, below);
				assertTrue(dep < 0 || done[dep], "round " + round + ": cell " + i + " after its dependency " + dep);
				if (pair[i] >= 0) {
					assertEquals(pair[i], order[k - 1], "round " + round + ": a second half right after its first");
				}
				if (dist[i] == BuildOrder.UNREACHED) {
					unreachedSeen = true;
				} else {
					assertTrue(!unreachedSeen, "round " + round + ": reachable cell " + i + " after an unreachable one");
				}
				done[i] = true;
			}
		}
	}

	@Test
	void theOldOrderIsUntouched() {
		Random rnd = new Random(11);
		for (int round = 0; round < 200; round++) {
			int n = 1 + rnd.nextInt(60);
			int[] y = new int[n];
			int[] kind = new int[n];
			int[] support = none(n);
			int[] pair = none(n);
			for (int i = 0; i < n; i++) {
				y[i] = rnd.nextInt(8);
				kind[i] = rnd.nextInt(3);
				if (kind[i] == ATTACHABLE && rnd.nextBoolean()) {
					support[i] = rnd.nextInt(n);
				}
			}
			// the reference: main's algorithm as written before SO (sort, then attachables wait, seconds ride)
			assertArrayEquals(reference(y, kind, support, pair), BuildOrder.order(y, kind, support, pair), "round " + round);
		}
	}

	/** A copy of the bottom-up order as main (b1ee8dcc) has it, to prove {@link BuildOrder#order} unchanged. */
	static int[] reference(int[] y, int[] kind, int[] support, int[] pairOf) {
		int n = y.length;
		Integer[] idx = new Integer[n];
		for (int i = 0; i < n; i++) {
			idx[i] = i;
		}
		Arrays.sort(idx, (a, b) -> y[a] != y[b] ? Integer.compare(y[a], y[b]) : kind[a] != kind[b] ? Integer.compare(kind[a], kind[b]) : Integer.compare(a, b));
		boolean[] done = new boolean[n];
		int[] out = new int[n];
		int[] k = {0};
		Map<Integer, List<Integer>> waiting = new HashMap<>();
		for (int i : idx) {
			emitRef(i, kind, support, waiting, done, out, k);
		}
		for (int i : idx) {
			if (!done[i]) {
				done[i] = true;
				out[k[0]++] = i;
			}
		}
		return out;
	}

	private static void emitRef(int i, int[] kind, int[] support, Map<Integer, List<Integer>> waiting, boolean[] done, int[] out, int[] k) {
		int s = support[i];
		if (kind[i] == ATTACHABLE && s >= 0 && s != i && !done[s]) {
			waiting.computeIfAbsent(s, x -> new ArrayList<>()).add(i);
			return;
		}
		if (done[i]) {
			return;
		}
		done[i] = true;
		out[k[0]++] = i;
		List<Integer> w = waiting.remove(i);
		if (w != null) {
			for (int j : w) {
				if (!done[j]) {
					emitRef(j, kind, support, waiting, done, out, k);
				}
			}
		}
	}
}
