package dev.larattalabs.architect.survival;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

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

	// ------------------------------------------------------------------ (8a TO) the terrain order

	/** (8a TO) A terrain cell's role: a solid fill (stone, dirt, ores, mushroom blocks, stairs...). */
	public static final int T_FILL = 0;
	/** (8a TO) A fill that falls (sand, gravel, concrete powder). */
	public static final int T_LOOSE = 1;
	/** (8a TO) A log, wood or stem: a solid fill that holds leaves. */
	public static final int T_LOG = 2;
	/** (8a TO) Leaves. */
	public static final int T_LEAF = 3;
	/** (8a TO) A block that rests on the cell under it (a plant, a carpet, a snow layer): no support for anything. */
	public static final int T_REST = 4;
	/** (8a TO) A cut: the cell's planned after is air. */
	public static final int T_CUT = 5;

	/** (8a TO) What the world holds at a cell outside the target: {@link #LAND_NONE}, {@link #LAND_SOLID}, {@link #LAND_LOG}, {@link #LAND_LEAF}. */
	@FunctionalInterface
	public interface Land {
		int at(int x, int y, int z);
	}

	/** (8a TO) Nothing that bears (air, fluid, a plant). */
	public static final int LAND_NONE = 0;
	/** (8a TO) Site-solid land, or a cell of the same part an earlier target already built. */
	public static final int LAND_SOLID = 1;
	/** (8a TO) A standing log: solid, and it holds leaves. */
	public static final int LAND_LOG = 2;
	/** (8a TO) A standing leaf (held by its log): it holds the leaves next to it, and bears nothing else. */
	public static final int LAND_LEAF = 3;

	/**
	 * (8a TO) A terrain target's order: {@code order} is a permutation of its cells, of which the first {@code connected} are buildable
	 * now, in that order (every rule below holds for each of them against the land as it stands plus the cells before it); the rest
	 * can't be reached from what stands yet (they hang from another target of the part: build them once it stands, by ordering them
	 * again). {@code cuts} is how many of the order's first cells are cuts.
	 */
	public record Terrain(int[] order, int connected, int cuts) {
	}

	/**
	 * (8a TO, docs/CONTRACT.md "Phase 8a" §3) The build order of a terrain target's cells (relief, pads' cut and fill, forms, scatter),
	 * each a cell whose planned after differs from its before. Pure.
	 * <ul>
	 * <li><b>Cuts first, top down</b>: by y from the top, so a column's upper cell goes before the one under it and no overhang is left
	 * for a later cut to undermine (and the fills then bear on the land as it will stay).</li>
	 * <li><b>Fills by support</b>: SO's breadth-first support distance from the seeds, ties by y, then the cell's index; a fill comes only
	 * when it is connected. A seed is a fill that replaces a solid cell ({@code wasSolid}: a grass top made dirt), a fill face-adjacent
	 * to {@link #LAND_SOLID} or {@link #LAND_LOG} land (site-solid land, or the same part's cells an earlier target built), or a
	 * floating form's virtual support. A fill is connected when it is a seed or touches a fill already placed ({@link #T_REST} cells
	 * connect nothing).</li>
	 * <li><b>Loose blocks and resting blocks</b> ({@link #T_LOOSE}, {@link #T_REST}) come only over a placed solid fill (not a leaf) or
	 * solid land.</li>
	 * <li><b>Leaves after their logs</b>: a leaf joined to a log of the target (through the target's leaves) comes only next to a placed
	 * log or a placed leaf already so held (or such land): a leaf is never written where no standing log holds it. (GPT review) A leaf no
	 * log holds (none in the target, none standing beside it) is never connected: solid ground bears no leaf.</li>
	 * <li><b>Floating forms</b> ({@code floating}: the declared anchors, {x, y, z} each): the target's cells in the anchor's 3x3 just under
	 * it seed the fill (the first cells built); a target that holds none of them gets nothing from it.</li>
	 * </ul>
	 * Cells nothing reaches come after the {@code connected} ones, lowest y first.
	 *
	 * @param x each cell's x
	 * @param y each cell's y
	 * @param z each cell's z
	 * @param role each cell's {@code T_*} role
	 * @param wasSolid whether the cell holds a solid block before it is built (the fill then replaces a standing support)
	 * @param land the world outside the target's cells
	 * @param floating the floating anchors' positions ({x, y, z} each), or empty
	 */
	public static Terrain forTerrain(int[] x, int[] y, int[] z, int[] role, boolean[] wasSolid, Land land, int[][] floating) {
		int n = x.length;
		Map<Long, Integer> at = new HashMap<>(n * 2);
		for (int i = 0; i < n; i++) {
			at.put(key(x[i], y[i], z[i]), i);
		}
		int[] out = new int[n];
		int k = 0;
		// cuts, top down
		List<Integer> cuts = new ArrayList<>();
		for (int i = 0; i < n; i++) {
			if (role[i] == T_CUT) {
				cuts.add(i);
			}
		}
		cuts.sort((a, b) -> y[a] != y[b] ? Integer.compare(y[b], y[a]) : Integer.compare(a, b));
		for (int i : cuts) {
			out[k++] = i;
		}
		int nCuts = k;
		// the fills' face neighbours among the fills (a cut is air by the time any fill goes in)
		int[][] nb = new int[n][];
		int[] below = new int[n];
		for (int i = 0; i < n; i++) {
			below[i] = -1;
			if (role[i] == T_CUT) {
				nb[i] = new int[0];
				continue;
			}
			int[] tmp = new int[6];
			int c = 0;
			for (int[] d : FACES) {
				Integer j = at.get(key(x[i] + d[0], y[i] + d[1], z[i] + d[2]));
				if (j != null && role[j] != T_CUT) {
					tmp[c++] = j;
					if (d[1] == -1) {
						below[i] = j;
					}
				}
			}
			nb[i] = Arrays.copyOf(tmp, c);
		}
		// leaves held by a log: a flood over the target's leaves from its logs and from its leaves that touch a standing log or leaf
		boolean[] held = new boolean[n];
		boolean[] seed = new boolean[n];
		int[] q = new int[n];
		int head = 0;
		int tail = 0;
		for (int i = 0; i < n; i++) {
			if (role[i] == T_LOG) {
				q[tail++] = i;
			} else if (role[i] == T_LEAF) {
				for (int[] d : FACES) {
					if (!at.containsKey(key(x[i] + d[0], y[i] + d[1], z[i] + d[2]))) {
						int l = land.at(x[i] + d[0], y[i] + d[1], z[i] + d[2]);
						seed[i] |= l == LAND_LOG || l == LAND_LEAF;
					}
				}
				if (seed[i]) {
					held[i] = true;
					q[tail++] = i;
				}
			}
		}
		while (head < tail) {
			int i = q[head++];
			for (int j : nb[i]) {
				if (role[j] == T_LEAF && !held[j]) {
					held[j] = true;
					q[tail++] = j;
				}
			}
		}
		// the other seeds: a loose or resting block over solid land; a fill (a log, a leaf no log holds) that replaces a solid cell or
		// touches solid land
		for (int i = 0; i < n; i++) {
			if (role[i] == T_CUT || held[i]) {
				continue;
			}
			if (role[i] == T_LOOSE || role[i] == T_REST) {
				seed[i] = below[i] < 0 && bears(land.at(x[i], y[i] - 1, z[i]));
				continue;
			}
			if (role[i] == T_LEAF) {
				continue; // (GPT review P1) a leaf no log holds is never ground-supported: it waits (unconnected) for a log to stand
			}
			seed[i] = wasSolid[i];
			for (int[] d : FACES) {
				if (!at.containsKey(key(x[i] + d[0], y[i] + d[1], z[i] + d[2]))) {
					seed[i] |= bears(land.at(x[i] + d[0], y[i] + d[1], z[i] + d[2]));
				}
			}
		}
		// a floating form's virtual support: the cells in its anchor's 3x3 just under it (a target that holds none gets nothing from it)
		for (int[] a : floating) {
			for (int i = 0; i < n; i++) {
				if (role[i] != T_CUT && role[i] != T_LOOSE && role[i] != T_REST && role[i] != T_LEAF && Math.abs(x[i] - a[0]) <= 1 && Math.abs(z[i] - a[2]) <= 1
					&& y[i] == a[1] - 1) {
					seed[i] = true;
				}
			}
		}
		// support distances over the fills, from the seeds
		int[] dist = distances(seed, nb);
		Comparator<Integer> rank = (a, b) -> dist[a] != dist[b] ? Integer.compare(dist[a], dist[b]) : y[a] != y[b] ? Integer.compare(y[a], y[b])
			: Integer.compare(a, b);
		boolean[] done = new boolean[n];
		boolean[] queued = new boolean[n];
		PriorityQueue<Integer> ready = new PriorityQueue<>(rank);
		for (int i = 0; i < n; i++) {
			if (role[i] != T_CUT && seed[i] && ready(i, role, held, below, nb, done, seed, land, x, y, z)) {
				ready.add(i);
				queued[i] = true;
			}
		}
		while (!ready.isEmpty()) {
			int i = ready.poll();
			done[i] = true;
			out[k++] = i;
			for (int m : nb[i]) {
				if (!done[m] && !queued[m] && ready(m, role, held, below, nb, done, seed, land, x, y, z)) {
					ready.add(m);
					queued[m] = true;
				}
			}
		}
		int connected = k;
		// what nothing reaches: lowest first
		List<Integer> rest = new ArrayList<>();
		for (int i = 0; i < n; i++) {
			if (role[i] != T_CUT && !done[i]) {
				rest.add(i);
			}
		}
		rest.sort((a, b) -> y[a] != y[b] ? Integer.compare(y[a], y[b]) : Integer.compare(a, b));
		for (int i : rest) {
			out[k++] = i;
		}
		return new Terrain(out, connected, nCuts);
	}

	private static final int[][] FACES = {{0, -1, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}, {0, 1, 0}};

	private static boolean bears(int land) {
		return land == LAND_SOLID || land == LAND_LOG;
	}

	private static long key(int x, int y, int z) {
		return ((long) (x & 0x3FFFFFF) << 38) | ((long) (z & 0x3FFFFFF) << 12) | (y & 0xFFFL);
	}

	/** Whether fill {@code i} can go in now: its rule against the placed cells (and the land, through its seed). */
	private static boolean ready(int i, int[] role, boolean[] held, int[] below, int[][] nb, boolean[] done, boolean[] seed, Land land, int[] x, int[] y,
		int[] z) {
		int r = role[i];
		if (r == T_LOOSE || r == T_REST) {
			// over a placed solid fill (no plant or leaf bears it), or over solid land (its seed)
			return below[i] >= 0 ? done[below[i]] && role[below[i]] != T_REST && role[below[i]] != T_LEAF : seed[i];
		}
		if (r == T_LEAF) {
			if (!held[i]) {
				return false; // (GPT review P1) only a log, or a leaf a log holds, bears a leaf
			}
			if (seed[i]) {
				return true;
			}
			for (int m : nb[i]) {
				if (done[m] && (role[m] == T_LOG || role[m] == T_LEAF && held[m])) {
					return true;
				}
			}
			return false;
		}
		if (seed[i]) {
			return true;
		}
		for (int m : nb[i]) {
			if (done[m] && role[m] != T_REST) {
				return true;
			}
		}
		return false;
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
