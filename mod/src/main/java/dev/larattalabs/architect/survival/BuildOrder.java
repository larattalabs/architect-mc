package dev.larattalabs.architect.survival;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The order a construction site builds its cells in (docs/CONTRACT.md phase 3 "Build order"): bottom-up by y; within a
 * row full blocks, then partial blocks (slabs, stairs, panes, fences), then attachables (torches, lanterns, doors, beds,
 * ladders, signs, carpets, flowers...). An attachable comes only after its support cell (when the support is a queued cell
 * too: a lantern hanging from a beam above its row waits for the beam). The second cell of a two-part block (a door's upper
 * half, a bed's head, a tall plant's top) comes right after its first: the pair is placed together. Pure.
 */
public final class BuildOrder {
	public static final int FULL = 0;
	public static final int PARTIAL = 1;
	public static final int ATTACHABLE = 2;

	private BuildOrder() {
	}

	/**
	 * The build order of {@code n} cells.
	 *
	 * @param y each cell's height
	 * @param kind {@link #FULL}, {@link #PARTIAL} or {@link #ATTACHABLE}
	 * @param support the cell an attachable needs built first, or -1 (not queued: terrain, or none)
	 * @param pairOf for the second cell of a pair, its first cell; else -1
	 * @return a permutation of {@code 0..n-1}
	 */
	public static int[] order(int[] y, int[] kind, int[] support, int[] pairOf) {
		int n = y.length;
		Integer[] idx = new Integer[n];
		for (int i = 0; i < n; i++) {
			idx[i] = i;
		}
		Arrays.sort(idx, (a, b) -> y[a] != y[b] ? Integer.compare(y[a], y[b]) : kind[a] != kind[b] ? Integer.compare(kind[a], kind[b])
			: Integer.compare(a, b));
		// second halves ride with their first
		Map<Integer, List<Integer>> seconds = new HashMap<>();
		for (int i = 0; i < n; i++) {
			if (pairOf[i] >= 0 && pairOf[i] != i) {
				seconds.computeIfAbsent(pairOf[i], k -> new ArrayList<>()).add(i);
			}
		}
		int[] out = new int[n];
		int[] k = {0};
		boolean[] done = new boolean[n];
		Map<Integer, List<Integer>> waiting = new HashMap<>();
		for (int i : idx) {
			if (pairOf[i] >= 0 && pairOf[i] != i) {
				continue; // emitted with its first
			}
			emit(i, kind, support, seconds, waiting, done, out, k);
		}
		// what still waits has a support that never comes first (a cycle, or a support that is itself a second half): append
		for (int i : idx) {
			if (!done[i]) {
				put(i, seconds, done, out, k);
			}
		}
		return out;
	}

	private static void emit(int i, int[] kind, int[] support, Map<Integer, List<Integer>> seconds, Map<Integer, List<Integer>> waiting,
		boolean[] done, int[] out, int[] k) {
		int s = support[i];
		if (kind[i] == ATTACHABLE && s >= 0 && s != i && !done[s]) {
			waiting.computeIfAbsent(s, x -> new ArrayList<>()).add(i);
			return;
		}
		List<Integer> placed = put(i, seconds, done, out, k);
		for (int p : placed) {
			List<Integer> w = waiting.remove(p);
			if (w != null) {
				for (int j : w) {
					if (!done[j]) {
						emit(j, kind, support, seconds, waiting, done, out, k);
					}
				}
			}
		}
	}

	/** Puts {@code i} and its second halves; returns the cells put. */
	private static List<Integer> put(int i, Map<Integer, List<Integer>> seconds, boolean[] done, int[] out, int[] k) {
		List<Integer> placed = new ArrayList<>(2);
		if (done[i]) {
			return placed;
		}
		done[i] = true;
		out[k[0]++] = i;
		placed.add(i);
		for (int j : seconds.getOrDefault(i, List.of())) {
			if (!done[j]) {
				done[j] = true;
				out[k[0]++] = j;
				placed.add(j);
			}
		}
		return placed;
	}
}
