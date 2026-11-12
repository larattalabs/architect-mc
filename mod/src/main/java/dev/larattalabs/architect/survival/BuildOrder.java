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

	/** A support-distance key that no reachable cell has (a cell no anchor reaches through queued cells). */
	public static final int UNREACHED = Integer.MAX_VALUE;

	/**
	 * (7b slice SO) The support order of {@code n} cells of a site-aware building (docs/CONTRACT.md "Phase 7b" slice SO; SETTLEMENTS
	 * §7.7): by support distance, a breadth-first search over the cells (through {@code neighbours}) from the {@code anchor} cells (a
	 * cell face-adjacent to the site's solid or to a keep-critical cell), ties by y, then today's full/partial/attachable rank and the
	 * cell's index. A cell is emitted only when it is <em>connected</em> (an anchor, or a face neighbour already emitted) and its
	 * dependency is emitted: an attachable's {@code support}, a gravity block's queued cell {@code below}. Second halves ride with
	 * their first ({@code pairOf}). So every prefix of the order is connected to the site. Cells that can never be connected (no anchor
	 * reaches them, or a dependency cycle) come last, lowest key first, each as soon as nothing connected is left. Pure.
	 *
	 * @param y each cell's height
	 * @param kind {@link #FULL}, {@link #PARTIAL} or {@link #ATTACHABLE}
	 * @param support the cell an attachable needs built first, or -1
	 * @param pairOf for the second cell of a pair, its first; else -1
	 * @param anchor whether the cell touches the site's solid (or a keep-critical cell) on a face
	 * @param neighbours each cell's face-adjacent cells (indices)
	 * @param below for a gravity block (sand, gravel, concrete powder, anvils, scaffolding), the cell under it when that is a cell
	 *     too; else -1
	 * @return a permutation of {@code 0..n-1}
	 */
	public static int[] bySupport(int[] y, int[] kind, int[] support, int[] pairOf, boolean[] anchor, int[][] neighbours, int[] below) {
		int n = y.length;
		int[] dist = distances(anchor, neighbours);
		Integer[] rank = new Integer[n];
		for (int i = 0; i < n; i++) {
			rank[i] = i;
		}
		java.util.Comparator<Integer> key = (a, b) -> dist[a] != dist[b] ? Integer.compare(dist[a], dist[b]) : y[a] != y[b] ? Integer.compare(y[a], y[b])
			: kind[a] != kind[b] ? Integer.compare(kind[a], kind[b]) : Integer.compare(a, b);
		Arrays.sort(rank, key);
		Map<Integer, List<Integer>> seconds = new HashMap<>();
		boolean[] second = new boolean[n];
		for (int i = 0; i < n; i++) {
			if (pairOf[i] >= 0 && pairOf[i] != i) {
				seconds.computeIfAbsent(pairOf[i], k -> new ArrayList<>()).add(i);
				second[i] = true;
			}
		}
		// who waits on whom: a cell's dependency (support or the cell below) wakes it
		Map<Integer, List<Integer>> waiters = new HashMap<>();
		for (int i = 0; i < n; i++) {
			int d = dependency(i, kind, support, below);
			if (d >= 0) {
				waiters.computeIfAbsent(d, x -> new ArrayList<>()).add(i);
			}
		}
		boolean[] done = new boolean[n];
		boolean[] queued = new boolean[n];
		java.util.PriorityQueue<Integer> ready = new java.util.PriorityQueue<>(key);
		int[] out = new int[n];
		int k = 0;
		for (int i = 0; i < n; i++) {
			if (!second[i] && anchor[i] && dependency(i, kind, support, below) < 0) {
				ready.add(i);
				queued[i] = true;
			}
		}
		int scan = 0; // the lowest-ranked cell not yet emitted (the fallback when nothing connected is ready)
		while (k < n) {
			Integer next = ready.poll();
			if (next == null) {
				while (scan < n && (done[rank[scan]] || second[rank[scan]])) {
					scan++;
				}
				if (scan == n) {
					// only second halves whose first is a second half (or themselves) are left
					for (int i : rank) {
						if (!done[i]) {
							done[i] = true;
							out[k++] = i;
						}
					}
					break;
				}
				next = rank[scan];
			}
			if (done[next]) {
				continue;
			}
			List<Integer> placed = new ArrayList<>(2);
			done[next] = true;
			out[k++] = next;
			placed.add(next);
			for (int j : seconds.getOrDefault(next, List.of())) {
				if (!done[j]) {
					done[j] = true;
					out[k++] = j;
					placed.add(j);
				}
			}
			for (int p : placed) {
				for (int m : neighbours[p]) {
					offer(m, done, queued, second, kind, support, below, ready);
				}
				for (int w : waiters.getOrDefault(p, List.of())) {
					offer(w, done, queued, second, kind, support, below, ready, anchor, neighbours);
				}
			}
		}
		return out;
	}

	/** Support distances: 0 for an anchor, else the fewest face steps through cells to one; {@link #UNREACHED} for none. Pure. */
	public static int[] distances(boolean[] anchor, int[][] neighbours) {
		int n = anchor.length;
		int[] dist = new int[n];
		Arrays.fill(dist, UNREACHED);
		int[] q = new int[n];
		int head = 0;
		int tail = 0;
		for (int i = 0; i < n; i++) {
			if (anchor[i]) {
				dist[i] = 0;
				q[tail++] = i;
			}
		}
		while (head < tail) {
			int i = q[head++];
			for (int m : neighbours[i]) {
				if (dist[m] == UNREACHED) {
					dist[m] = dist[i] + 1;
					q[tail++] = m;
				}
			}
		}
		return dist;
	}

	/** The cell {@code i} must follow: an attachable's support, else a gravity block's cell below; -1 for none. */
	static int dependency(int i, int[] kind, int[] support, int[] below) {
		if (kind[i] == ATTACHABLE && support[i] >= 0 && support[i] != i) {
			return support[i];
		}
		return below[i] >= 0 && below[i] != i ? below[i] : -1;
	}

	/** Queues {@code m} once a face neighbour of it was emitted (it is connected) and its dependency is emitted. */
	private static void offer(int m, boolean[] done, boolean[] queued, boolean[] second, int[] kind, int[] support, int[] below,
		java.util.PriorityQueue<Integer> ready) {
		if (done[m] || queued[m] || second[m]) {
			return;
		}
		int d = dependency(m, kind, support, below);
		if (d >= 0 && !done[d]) {
			return; // its dependency wakes it
		}
		queued[m] = true;
		ready.add(m);
	}

	/** Queues a waiter {@code w} whose dependency was just emitted, when it is connected (an anchor or a neighbour emitted). */
	private static void offer(int w, boolean[] done, boolean[] queued, boolean[] second, int[] kind, int[] support, int[] below,
		java.util.PriorityQueue<Integer> ready, boolean[] anchor, int[][] neighbours) {
		if (done[w] || queued[w] || second[w]) {
			return;
		}
		boolean connected = anchor[w];
		for (int m : neighbours[w]) {
			connected |= done[m];
		}
		if (connected) {
			offer(w, done, queued, second, kind, support, below, ready);
		}
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
