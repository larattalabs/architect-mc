package dev.larattalabs.architect.site.roads;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * A road along a caller's polyline (docs/CONTRACT.md phase 4e "Roads as sites"), pure: the world comes in as kinds
 * ({@link World}), unit-tested on synthetic terrain. Adapted from AgentCraft {@code RoadPlan} at {@code ab08a02}: the kinds,
 * the surface choice ({@link #surfaceFor}), the clearing rules, half steps and lanterns are kept; the route is the caller's
 * waypoints (a 4-connected supercover line between them, a diagonal step through its corner cell) instead of AgentCraft's
 * agent planner, with Architect's ground-following profile:
 * <ul>
 * <li><b>Profile</b>: each centre column's ground is the top solid block that is not leaves or a plant, searched from the
 * waypoint hint {@code y + 8} down to {@code y - 8}; the heights are smoothed so neighbouring centre cells differ by at most
 * one, and no column is cut or filled by more than {@link #MAX_CUT_FILL} ({@code TOO_STEEP} names the column).</li>
 * <li><b>Side cells</b> take their centre cell's height; each needs at most {@link #MAX_SIDE} of fill or cut, else it is left
 * out (noted). A centre cell holding something that can't be cleared keeps it (KEPT, noted).</li>
 * <li><b>Fill</b> uses the foundation block ({@link Block#FILL}); a cut removes natural blocks only.</li>
 * <li><b>Water</b>: 1-deep water gets an oak slab deck above it only with shallow decks on, otherwise the cell is skipped;
 * deeper water refuses ({@code DEEP_WATER}).</li>
 * <li><b>Other sites</b>: a column holding a cell another standing site or road owns is left out whole ({@link Owned}).</li>
 * </ul>
 */
public final class RoadPlan {
	// ------------------------------------------------------------------ cell kinds (AgentCraft's)
	public static final int AIR = 0;
	public static final int PLANT = 1;
	public static final int STACK = 2;
	public static final int LEAVES = 3;
	public static final int LOG = 4;
	public static final int WATER = 5;
	public static final int LAVA = 6;
	public static final int DIRT = 7;
	public static final int SAND = 8;
	public static final int STONE = 9;
	public static final int MUD = 10;
	public static final int PATH = 11;
	public static final int BUILT = 12;
	public static final int BUILT_OPEN = 13;
	public static final int BLOCK_ENTITY = 14;
	public static final int UNLOADED = 15;
	/** An exposed ore: never paved. */
	public static final int ORE = 16;

	public static final int MIN_WIDTH = 1;
	public static final int MAX_WIDTH = 5;
	public static final int MAX_POINTS = 256;
	public static final int MAX_CENTRE = 2048;
	public static final int MAX_CUT_FILL = 4;
	public static final int MAX_SIDE = 2;
	public static final int SEARCH = 8;
	public static final int HEADROOM = 2;
	public static final double LANTERN_FIRST = 6;
	public static final double LANTERN_SPACING = 12;
	static final int STACK_MAX = 12;

	/** The world under a road: the kind of block at (x, y, z). */
	@FunctionalInterface
	public interface World {
		int at(int x, int y, int z);
	}

	/** Cells other standing sites or roads own: the road leaves those columns as they are. Returns the owning site id, or null. */
	@FunctionalInterface
	public interface Owned {
		@Nullable String at(int x, int y, int z);
	}

	/**
	 * 6c 0c (C17): the request owner's protected columns: the message naming the area, or null. A protected column fails its
	 * waypoint segment ({@code PROTECTED}).
	 */
	@FunctionalInterface
	public interface Protect {
		@Nullable String at(int x, int z);
	}

	/**
	 * 6c 0c §3: a failing stretch of the road: waypoint segments {@code [fromPoint, toPoint]} (neighbouring failing segments
	 * merged), the first failure's reason (an API {@code Reason} name), message and cell.
	 */
	public record Span(int fromPoint, int toPoint, String reason, String message, int x, int y, int z) {
	}

	/** What a road puts into a cell. */
	public enum Block {
		AIR("minecraft:air"),
		DIRT_PATH("minecraft:dirt_path"),
		GRAVEL("minecraft:gravel"),
		PACKED_MUD("minecraft:packed_mud"),
		PATH_SLAB("minecraft:mud_brick_slab"),
		STONE_SLAB("minecraft:cobblestone_slab"),
		DECK("minecraft:oak_slab"),
		FENCE("minecraft:oak_fence"),
		LANTERN("minecraft:lantern"),
		FILL("minecraft:cobblestone"),
		/** The caller's surface block. */
		SURFACE(""),
		/** The caller's slab. */
		SLAB("");

		public final String id;

		Block(String id) {
			this.id = id;
		}

		public String wire() {
			return name().toLowerCase(Locale.ROOT);
		}
	}

	/** One changed cell: what goes there and the kind it replaces. */
	public record Op(int x, int y, int z, Block block, int before) {
	}

	/** A walkway cell: its column, the feet cell, whether it is on the centre line, its role. */
	public record Cell(int x, int feetY, int z, boolean centre, Role role) {
	}

	public enum Role {
		GROUND, SLAB, BRIDGE, KEPT
	}

	/**
	 * @param ops the changes, per column bottom to top
	 * @param cells the walkway
	 * @param refusal why nothing may be laid ({@code reason} the API {@code Reason} name), or null
	 * @param skipped per reason, cells left out
	 * @param ownedBy columns left as they are per owning site
	 */
	public record Plan(List<Op> ops, List<Cell> cells, @Nullable String refusal, @Nullable String reason, Map<String, Integer> skipped,
		Map<String, Integer> ownedBy, int centre, int[] lanterns, List<Span> spans) {
		public Plan(List<Op> ops, List<Cell> cells, @Nullable String refusal, @Nullable String reason, Map<String, Integer> skipped,
			Map<String, Integer> ownedBy, int centre, int[] lanterns) {
			this(ops, cells, refusal, reason, skipped, ownedBy, centre, lanterns, List.of());
		}

		public List<String> notes() {
			List<String> out = new ArrayList<>();
			if (refusal == null && !spans.isEmpty()) {
				out.add("skipped " + spansText(spans));
			}
			skipped.forEach((k, n) -> out.add(note(k, n)));
			ownedBy.forEach((site, n) -> out.add(n + " cell" + (n == 1 ? "" : "s") + " of " + site + " left as they are"));
			return out;
		}

		public boolean refused() {
			return refusal != null;
		}
	}

	/** "segments [2,3] (TOO_STEEP), [5,6] (PROTECTED)". */
	public static String spansText(List<Span> spans) {
		List<String> parts = new ArrayList<>();
		for (Span sp : spans) {
			parts.add("[" + sp.fromPoint() + "," + sp.toPoint() + "] (" + sp.reason() + ")");
		}
		return (spans.size() == 1 ? "segment " : "segments ") + String.join(", ", parts);
	}

	static String note(String reason, int n) {
		String cells = n + " cell" + (n == 1 ? "" : "s");
		return switch (reason) {
			case "water" -> cells + " of shallow water skipped (shallow decks off)";
			case "blocked" -> cells + " beside the road with something in the way (logs, blocks, block entities, fluids) left out";
			case "kept" -> cells + " on the centre line kept as they are (something there can't be cleared)";
			case "steep" -> cells + " beside the road needing more than " + MAX_SIDE + " of cut or fill left out";
			case "lantern" -> n + " lantern" + (n == 1 ? "" : "s") + " without room for a post";
			case "ore" -> cells + " of exposed ore left unpaved";
			case "short" -> cells + " on the centre line between skipped segments left out (a run shorter than 2)";
			default -> cells + " skipped (" + reason + ")";
		};
	}

	private RoadPlan() {
	}

	// ------------------------------------------------------------------ pure helpers

	public static boolean clearable(int kind) {
		return kind == PLANT || kind == STACK || kind == LEAVES;
	}

	public static boolean open(int kind) {
		return kind == AIR || clearable(kind);
	}

	/** Natural ground a road may pave or cut. */
	public static boolean ground(int kind) {
		return kind == DIRT || kind == SAND || kind == STONE || kind == MUD || kind == PATH;
	}

	/** Solid ground for the profile: anything with a top a walker stands on, not leaves or a plant. */
	static boolean solid(int kind) {
		return ground(kind) || kind == BUILT || kind == LOG || kind == ORE || kind == BLOCK_ENTITY;
	}

	/** Would a falling block (gravel) drop into this cell? */
	public static boolean free(int kind) {
		return kind == AIR || kind == PLANT || kind == STACK || kind == WATER || kind == LAVA;
	}

	/** AgentCraft's surface: dirt path on dirt, gravel on supported sand or stone (else packed mud), packed mud on mud. */
	public static @Nullable Block surfaceFor(int kind, boolean supported) {
		return switch (kind) {
			case DIRT, PATH -> Block.DIRT_PATH;
			case MUD -> Block.PACKED_MUD;
			case SAND, STONE -> supported ? Block.GRAVEL : Block.PACKED_MUD;
			default -> null;
		};
	}

	public static Block slabFor(int kind) {
		return kind == SAND || kind == STONE ? Block.STONE_SLAB : Block.PATH_SLAB;
	}

	/** Lateral offsets of a road {@code width} cells wide (0 = the centre, positive = right of travel): an even width puts the extra cell on the right. */
	public static int[] offsets(int width) {
		int lo = -(width - 1) / 2;
		int hi = width / 2;
		int[] o = new int[hi - lo + 1];
		for (int k = lo; k <= hi; k++) {
			o[k - lo] = k;
		}
		return o;
	}

	/**
	 * The centre line through {@code xs}/{@code zs} (waypoints): a 4-connected supercover line between consecutive points (a
	 * diagonal step goes through its corner cell: the x step first), each column once, in order. {@code ys}: the waypoints' y
	 * hints, interpolated along each segment into {@code hints}.
	 */
	public static List<int[]> line(int[] xs, int[] ys, int[] zs) {
		List<int[]> out = new ArrayList<>();
		Set<Long> seen = new HashSet<>();
		for (int s = 0; s + 1 < xs.length; s++) {
			int x0 = xs[s];
			int z0 = zs[s];
			int x1 = xs[s + 1];
			int z1 = zs[s + 1];
			int dx = Math.abs(x1 - x0);
			int dz = Math.abs(z1 - z0);
			int sx = Integer.signum(x1 - x0);
			int sz = Integer.signum(z1 - z0);
			int n = dx + dz;
			int x = x0;
			int z = z0;
			// walk the grid: at each step move in x or z, whichever keeps closer to the true line (ties: x first)
			long ex = 0;
			for (int i = 0; i <= n; i++) {
				double t = n == 0 ? 0 : (double) i / n;
				int y = (int) Math.round(ys[s] + (ys[s + 1] - ys[s]) * t);
				long k = ((long) x << 32) ^ (z & 0xFFFFFFFFL);
				if (seen.add(k)) {
					out.add(new int[] {x, y, z, s}); // [3]: the waypoint segment (6c 0c §3)
				}
				if (i == n) {
					break;
				}
				// error test of the supercover walk (Amanatides-Woo with integer steps)
				long nx = (long) (2 * (Math.abs(x - x0) + 1) - 1) * dz;
				long nz = (long) (2 * (Math.abs(z - z0) + 1) - 1) * dx;
				if (dz == 0 || dx != 0 && nx <= nz) {
					x += sx;
				} else {
					z += sz;
				}
			}
		}
		return out;
	}

	/** The smallest 1-Lipschitz majorant and largest minorant of {@code g}, averaged and floored: neighbours differ by at most one. */
	static int[] smooth(int[] g) {
		int n = g.length;
		int[] lo = new int[n];
		int[] hi = new int[n];
		for (int i = 0; i < n; i++) {
			lo[i] = g[i];
			hi[i] = g[i];
		}
		for (int i = 1; i < n; i++) {
			lo[i] = Math.max(lo[i], lo[i - 1] - 1);
			hi[i] = Math.min(hi[i], hi[i - 1] + 1);
		}
		for (int i = n - 2; i >= 0; i--) {
			lo[i] = Math.max(lo[i], lo[i + 1] - 1);
			hi[i] = Math.min(hi[i], hi[i + 1] + 1);
		}
		int[] t = new int[n];
		for (int i = 0; i < n; i++) {
			t[i] = Math.floorDiv(lo[i] + hi[i], 2);
		}
		return t;
	}

	/** The ground feet height of a column near {@code hint}: one above the top solid block from hint + 8 down to hint - 8, or MIN_VALUE. */
	static int groundFeet(World w, int x, int z, int hint) {
		for (int y = hint + SEARCH; y >= hint - SEARCH; y--) {
			int k = w.at(x, y, z);
			if (solid(k)) {
				return y + 1;
			}
			if (k == WATER || k == LAVA) {
				return y + 1;
			}
		}
		return Integer.MIN_VALUE;
	}

	/** The water depth below feet height {@code feet} (water cells down to the floor). */
	static int waterDepth(World w, int x, int feet, int z) {
		int d = 0;
		for (int y = feet - 1; y >= feet - 1 - SEARCH && w.at(x, y, z) == WATER; y--) {
			d++;
		}
		return d;
	}

	// ------------------------------------------------------------------ plan

	/** A walkway column before its ops. */
	private static final class Col {
		final int x;
		final int z;
		final boolean centre;
		final int index;
		int feet;
		int groundFeet;
		int surface;
		Role role = Role.GROUND;
		boolean water;

		Col(int x, int z, boolean centre, int index) {
			this.x = x;
			this.z = z;
			this.centre = centre;
			this.index = index;
		}
	}

	/**
	 * The road through waypoints ({@code xs, ys, zs}): {@code width} cells across, {@code lanterns}, {@code decks} over 1-deep
	 * water. {@code owned}: cells of other sites and roads (the road leaves those columns alone).
	 */
	public static Plan plan(int[] xs, int[] ys, int[] zs, int width, boolean lanterns, boolean decks, World w, Owned owned) {
		return plan(xs, ys, zs, width, lanterns, decks, w, owned, null, false);
	}

	/**
	 * {@link #plan}; 6c 0c §3: every failing centre column is mapped to its waypoint segment and neighbouring failing segments
	 * merge into {@link Plan#spans} (TOO_STEEP, DEEP_WATER, LAVA, PROTECTED; NOT_LOADED stays a whole-road refusal). The runs
	 * between failing segments are smoothed each on its own, a run's worst cut or fill failing its segment, until no run fails
	 * (one segment per run per round, so at most one round per segment). Without {@code partial} any span refuses the road
	 * (the first span is the refusal; no span: exactly the 4e plan). With {@code partial} the failing segments are dropped and the
	 * runs of at least 2 centre cells are planned as one road with gaps; nothing left refuses with the first span.
	 * {@code protect}: the owner's protected columns (C17), centre and side columns and lantern posts.
	 */
	public static Plan plan(int[] xs, int[] ys, int[] zs, int width, boolean lanterns, boolean decks, World w, Owned owned, @Nullable Protect protect,
		boolean partial) {
		Map<String, Integer> skipped = new LinkedHashMap<>();
		Map<String, Integer> ownedBy = new LinkedHashMap<>();
		if (xs.length < 2 || xs.length > MAX_POINTS) {
			return refused("a road takes 2-" + MAX_POINTS + " points (got " + xs.length + ")", "OTHER");
		}
		if (width < MIN_WIDTH || width > MAX_WIDTH) {
			return refused("width must be " + MIN_WIDTH + "-" + MAX_WIDTH + " (got " + width + ")", "OTHER");
		}
		List<int[]> line = line(xs, ys, zs);
		if (line.size() > MAX_CENTRE) {
			return refused("road too long (" + line.size() + " centre cells, at most " + MAX_CENTRE + "); split it", "OTHER");
		}
		int n = line.size();
		int nSeg = xs.length - 1;
		int[] offs = offsets(width);
		// NOT_LOADED first: temporary, a whole-road refusal (a waiting item waits for it)
		for (int i = 0; i < n; i++) {
			int[] c = line.get(i);
			for (int y = c[1] - SEARCH; y <= c[1] + SEARCH + 1; y++) {
				if (w.at(c[0], y, c[2]) == UNLOADED) {
					return refused("the road is not loaded at " + c[0] + ", " + c[2] + " (walk closer)", "NOT_LOADED");
				}
			}
		}
		// the span-local failures before smoothing, the first per segment
		String[] segReason = new String[nSeg];
		String[] segMsg = new String[nSeg];
		int[][] segAt = new int[nSeg][];
		int[] g = new int[n];
		boolean[] wet = new boolean[n];
		for (int i = 0; i < n; i++) {
			int[] c = line.get(i);
			int sg = c[3];
			String why = null;
			String reason = null;
			int f = groundFeet(w, c[0], c[2], c[1]);
			if (f == Integer.MIN_VALUE) {
				why = "no ground within " + SEARCH + " of y " + c[1] + " at column " + c[0] + ", " + c[2];
				reason = "TOO_STEEP";
			} else if (w.at(c[0], f - 1, c[2]) == LAVA) {
				why = "lava under the road at " + c[0] + ", " + (f - 1) + ", " + c[2];
				reason = "LAVA";
			} else if (w.at(c[0], f - 1, c[2]) == WATER) {
				int d = waterDepth(w, c[0], f, c[2]);
				if (d > 1) {
					why = "water " + d + " deep at " + c[0] + ", " + c[2] + " (bridges are phase 6)";
					reason = "DEEP_WATER";
				} else {
					wet[i] = true;
				}
			}
			if (why == null && protect != null) {
				int[] r = right(line, i);
				for (int k : offs) {
					String pm = protect.at(c[0] + k * r[0], c[2] + k * r[1]);
					if (pm != null) {
						why = pm;
						reason = "PROTECTED";
						break;
					}
				}
			}
			g[i] = f == Integer.MIN_VALUE ? c[1] : f;
			if (why != null && segReason[sg] == null) {
				segReason[sg] = reason;
				segMsg[sg] = why;
				segAt[sg] = new int[] {c[0], f == Integer.MIN_VALUE ? c[1] : f - 1, c[2]};
			}
		}
		// the runs between failing segments, smoothed each on its own until no run fails
		int[] t = new int[n];
		while (true) {
			boolean changed = false;
			int i = 0;
			while (i < n) {
				if (segReason[line.get(i)[3]] != null) {
					i++;
					continue;
				}
				int j = i;
				while (j < n && segReason[line.get(j)[3]] == null) {
					j++;
				}
				int[] run = java.util.Arrays.copyOfRange(g, i, j);
				int[] rt = smooth(run);
				int worst = -1;
				int dev = MAX_CUT_FILL;
				for (int k = 0; k < run.length; k++) {
					t[i + k] = rt[k];
					if (Math.abs(rt[k] - run[k]) > dev) {
						dev = Math.abs(rt[k] - run[k]);
						worst = i + k;
					}
				}
				if (worst >= 0) {
					int[] c = line.get(worst);
					segReason[c[3]] = "TOO_STEEP";
					segMsg[c[3]] = "column " + c[0] + ", " + c[2] + " needs " + Math.abs(t[worst] - g[worst]) + " of " + (t[worst] > g[worst] ? "fill" : "cut")
						+ " (at most " + MAX_CUT_FILL + ")";
					segAt[c[3]] = new int[] {c[0], g[worst] - 1, c[2]};
					changed = true;
				}
				i = j;
			}
			if (!changed) {
				break;
			}
		}
		List<Span> spans = new ArrayList<>();
		for (int sg = 0; sg < nSeg; sg++) {
			if (segReason[sg] == null) {
				continue;
			}
			int e = sg;
			while (e + 1 < nSeg && segReason[e + 1] != null) {
				e++;
			}
			spans.add(new Span(sg, e + 1, segReason[sg], segMsg[sg], segAt[sg][0], segAt[sg][1], segAt[sg][2]));
			sg = e;
		}
		boolean[] keep = new boolean[n];
		int kept = 0;
		for (int i = 0; i < n; i++) {
			keep[i] = segReason[line.get(i)[3]] == null;
		}
		if (!spans.isEmpty()) {
			Span first = spans.get(0);
			if (!partial) {
				return refusedSpans(first.message(), first.reason(), spans);
			}
			// runs shorter than 2 centre cells are left out
			for (int i = 0; i < n;) {
				if (!keep[i]) {
					i++;
					continue;
				}
				int j = i;
				while (j < n && keep[j]) {
					j++;
				}
				if (j - i < 2) {
					for (int k = i; k < j; k++) {
						keep[k] = false;
						bump(skipped, "short");
					}
				}
				i = j;
			}
		}
		for (boolean k : keep) {
			kept += k ? 1 : 0;
		}
		if (kept == 0) {
			Span first = spans.get(0);
			return refusedSpans(first.message(), first.reason(), spans);
		}
		// the walkway columns: centre first, then the sides (right of travel positive)
		LinkedHashMap<Long, Col> cols = new LinkedHashMap<>();
		for (int i = 0; i < n; i++) {
			if (!keep[i]) {
				continue;
			}
			int[] c = line.get(i);
			int[] nx = line.get(Math.min(n - 1, i + 1));
			int[] pv = line.get(Math.max(0, i - 1));
			int dx = Integer.signum(nx[0] - pv[0]);
			int dz = Integer.signum(nx[2] - pv[2]);
			if (dx != 0 && dz != 0) {
				dz = 0; // a corner: beside its x step
			}
			Col cc = cols.computeIfAbsent(key(c[0], c[2]), k -> new Col(c[0], c[2], true, 0));
			if (!cc.centre) {
				cols.put(key(c[0], c[2]), cc = new Col(c[0], c[2], true, i));
			}
			cc.feet = t[i];
			cc.groundFeet = g[i];
			cc.water = wet[i];
			int rx = -dz;
			int rz = dx;
			for (int k : offs) {
				if (k == 0) {
					continue;
				}
				int sx = c[0] + k * rx;
				int sz = c[2] + k * rz;
				Col sc = cols.get(key(sx, sz));
				if (sc == null) {
					sc = new Col(sx, sz, false, i);
					sc.feet = t[i];
					cols.put(key(sx, sz), sc);
				}
			}
		}
		List<Op> ops = new ArrayList<>();
		List<Cell> cells = new ArrayList<>();
		Map<Long, Col> accepted = new HashMap<>();
		for (Col c : cols.values()) {
			if (!c.centre) {
				int gf = groundFeet(w, c.x, c.z, c.feet);
				if (gf == Integer.MIN_VALUE || Math.abs(gf - c.feet) > MAX_SIDE) {
					bump(skipped, "steep");
					continue;
				}
				c.groundFeet = gf;
				if (w.at(c.x, gf - 1, c.z) == WATER) {
					c.water = true;
				}
			}
			if (c.water) {
				if (!decks) {
					bump(skipped, "water");
					continue;
				}
				c.role = Role.BRIDGE;
				c.feet = c.groundFeet + 1;
			}
			c.surface = w.at(c.x, c.groundFeet - 1, c.z);
			accepted.put(key(c.x, c.z), c);
		}
		// half steps: a ground cell with a road neighbour one block higher and none lower
		for (Col c : accepted.values()) {
			if (c.role != Role.GROUND) {
				continue;
			}
			boolean higher = false;
			boolean lower = false;
			for (int[] d : new int[][] {{1, 0}, {-1, 0}, {0, 1}, {0, -1}}) {
				Col o = accepted.get(key(c.x + d[0], c.z + d[1]));
				if (o == null || o.role == Role.BRIDGE) {
					continue;
				}
				higher |= o.feet == c.feet + 1;
				lower |= o.feet == c.feet - 1;
			}
			if (higher && !lower) {
				c.role = Role.SLAB;
			}
		}
		for (Col c : cols.values()) {
			if (!accepted.containsKey(key(c.x, c.z))) {
				continue;
			}
			List<Op> col = new ArrayList<>();
			String why = columnOps(c, w, col);
			if (why != null) {
				if (c.centre) {
					bump(skipped, "kept");
					cells.add(new Cell(c.x, c.feet, c.z, true, Role.KEPT));
				} else {
					bump(skipped, "blocked");
				}
				continue;
			}
			String site = null;
			for (Op o : col) {
				site = owned.at(o.x(), o.y(), o.z());
				if (site != null) {
					break;
				}
			}
			if (site != null) {
				ownedBy.merge(site, col.size(), Integer::sum);
				continue;
			}
			ops.addAll(col);
			cells.add(new Cell(c.x, c.feet, c.z, c.centre, c.role));
		}
		List<Integer> lan = new ArrayList<>();
		if (lanterns) {
			lanterns(line, t, keep, width, accepted, w, owned, protect, ops, lan, skipped);
		}
		int[] la = lan.stream().mapToInt(Integer::intValue).toArray();
		return new Plan(List.copyOf(ops), List.copyOf(cells), null, null, skipped, ownedBy, n, la, List.copyOf(spans));
	}

	private static long key(int x, int z) {
		return ((long) x << 32) ^ (z & 0xFFFFFFFFL);
	}

	private static void bump(Map<String, Integer> m, String k) {
		m.merge(k, 1, Integer::sum);
	}

	private static Plan refused(String why, String reason) {
		return new Plan(List.of(), List.of(), why, reason, Map.of(), Map.of(), 0, new int[0]);
	}

	private static Plan refusedSpans(String why, String reason, List<Span> spans) {
		return new Plan(List.of(), List.of(), why, reason, Map.of(), Map.of(), 0, new int[0], List.copyOf(spans));
	}

	/** The right-of-travel unit step {rx, rz} at centre cell {@code i} (a corner: beside its x step), as the walkway uses it. */
	private static int[] right(List<int[]> line, int i) {
		int n = line.size();
		int[] nx = line.get(Math.min(n - 1, i + 1));
		int[] pv = line.get(Math.max(0, i - 1));
		int dx = Integer.signum(nx[0] - pv[0]);
		int dz = Integer.signum(nx[2] - pv[2]);
		if (dx != 0 && dz != 0) {
			dz = 0;
		}
		return new int[] {-dz, dx};
	}

	/** A column's ops, bottom to top; null when it can be made, else why not. */
	private static @Nullable String columnOps(Col c, World w, List<Op> ops) {
		int x = c.x;
		int z = c.z;
		if (c.role == Role.BRIDGE) {
			int deck = c.feet;
			if (!open(w.at(x, deck, z))) {
				return "blocked";
			}
			ops.add(new Op(x, deck, z, Block.DECK, w.at(x, deck, z)));
			return clearUp(ops, w, x, deck + 1, deck + HEADROOM, z) ? null : "blocked";
		}
		int f = c.feet;
		int gf = c.groundFeet;
		int top = c.role == Role.SLAB ? f + HEADROOM : f + HEADROOM - 1;
		if (f > gf) {
			// fill from the old ground up to below the surface (the old ground's top block becomes fill too)
			int surfaceKind = c.surface;
			if (!ground(surfaceKind) && surfaceKind != BUILT) {
				return "blocked";
			}
			for (int y = gf; y < f - 1; y++) {
				int k = w.at(x, y, z);
				if (!open(k) && k != AIR) {
					return "blocked";
				}
				ops.add(new Op(x, y, z, Block.FILL, k));
			}
			int k = w.at(x, f - 1, z);
			if (!open(k)) {
				return "blocked";
			}
			Block s = surfaceFor(ground(surfaceKind) ? surfaceKind : STONE, true);
			ops.add(new Op(x, f - 1, z, s == null ? Block.FILL : s, k));
		} else {
			// at or below the old ground: a cut removes natural blocks only
			for (int y = f; y < gf; y++) {
				int k = w.at(x, y, z);
				if (!ground(k) && !open(k)) {
					return "blocked";
				}
			}
			int k = w.at(x, f - 1, z);
			if (k == ORE) {
				return "blocked";
			}
			if (!ground(k)) {
				return c.centre && (k == BUILT || k == LOG) ? "kept" : "blocked";
			}
			Block s = surfaceFor(k, !free(w.at(x, f - 2, z)));
			if (c.role != Role.SLAB && s != null) {
				ops.add(new Op(x, f - 1, z, s, k));
			}
			for (int y = f; y < gf; y++) {
				int kk = w.at(x, y, z);
				if (kk != AIR) {
					ops.add(new Op(x, y, z, Block.AIR, kk));
				}
			}
		}
		if (c.role == Role.SLAB) {
			int k = w.at(x, f, z);
			if (!open(k) && !ground(k)) {
				return "blocked";
			}
			ops.removeIf(o -> o.x() == x && o.z() == z && o.y() == f);
			ops.add(new Op(x, f, z, slabFor(c.surface), k));
			return clearUp(ops, w, x, f + 1, top, z) ? null : "blocked";
		}
		return clearUp(ops, w, x, Math.max(f, gf), top, z) ? null : "blocked";
	}

	/** Clears the clearable cells from {@code y0} to {@code y1} (and a tall plant's stack above); false when something can't be cleared. */
	private static boolean clearUp(List<Op> ops, World w, int x, int y0, int y1, int z) {
		int y = y0;
		for (; y <= y1; y++) {
			int k = w.at(x, y, z);
			if (k == AIR) {
				continue;
			}
			if (!clearable(k)) {
				return false;
			}
			ops.add(new Op(x, y, z, Block.AIR, k));
		}
		if (y1 >= y0 && w.at(x, y1, z) == STACK) {
			for (int n = 0; n < STACK_MAX; n++, y++) {
				int k = w.at(x, y, z);
				if (k != STACK) {
					break;
				}
				ops.add(new Op(x, y, z, Block.AIR, k));
			}
		}
		return true;
	}

	/** AgentCraft's lanterns: a fence post with a lantern beside the walkway, the first 6 blocks out, then every 12. */
	private static void lanterns(List<int[]> line, int[] t, boolean[] keep, int width, Map<Long, Col> walk, World w, Owned owned, @Nullable Protect protect,
		List<Op> ops, List<Integer> out, Map<String, Integer> skipped) {
		int[] offs = offsets(width);
		int hi = offs[offs.length - 1];
		int lo = offs[0];
		double since = LANTERN_SPACING - LANTERN_FIRST;
		for (int i = 1; i < line.size() - 1; i++) {
			since += 1;
			if (since + 1e-9 < LANTERN_SPACING || !keep[i]) {
				continue;
			}
			int[] c = line.get(i);
			int[] nx = line.get(i + 1);
			int dx = Integer.signum(nx[0] - c[0]);
			int dz = Integer.signum(nx[2] - c[2]);
			int rx = -dz;
			int rz = dx;
			boolean placed = false;
			for (int side : new int[] {hi + 1, lo - 1}) {
				int qx = c[0] + side * rx;
				int qz = c[2] + side * rz;
				if (walk.containsKey(key(qx, qz))) {
					continue;
				}
				for (int dy : new int[] {0, 1, -1}) {
					int y = t[i] + dy;
					int below = w.at(qx, y - 1, qz);
					int f = w.at(qx, y, qz);
					int l = w.at(qx, y + 1, qz);
					if (!ground(below) || !open(f) || !open(l) || f == STACK || l == STACK) {
						continue;
					}
					if (owned.at(qx, y, qz) != null || owned.at(qx, y + 1, qz) != null || protect != null && protect.at(qx, qz) != null) {
						continue;
					}
					ops.add(new Op(qx, y, qz, Block.FENCE, f));
					ops.add(new Op(qx, y + 1, qz, Block.LANTERN, l));
					out.add(qx);
					out.add(y + 1);
					out.add(qz);
					placed = true;
					break;
				}
				if (placed) {
					break;
				}
			}
			if (placed) {
				since = 0;
			} else {
				bump(skipped, "lantern");
				since = LANTERN_SPACING / 2;
			}
		}
	}
}
