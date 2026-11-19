package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.PartBuild;
import dev.larattalabs.architect.api.PartShape;
import dev.larattalabs.architect.api.RegionBuild;
import dev.larattalabs.architect.api.RegionLayout;
import dev.larattalabs.architect.apiimpl.StatusViews;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (8b LY, docs/CONTRACT.md "Phase 8b" §3.2) {@code Regions.layout}: a region's geometry for a map, from what the region already keeps.
 * <ul>
 * <li>Lots (pads too): kind {@code lot}, the effective IR's box.</li>
 * <li>A plan/0 region (realised from an artifact): one shape per plan part of the artifact ({@code parts[]}), kind its block
 * ({@code connector.rope_bridge}, {@code zone.standard}, {@code form.hollow_mountain}, ...), its box and ends from the part's geometry
 * ({@code rect}; a connector's {@code link.from/to}; a route's {@code legs[].path}). Its part id is the plan part's, which is
 * {@link PartBuild#part} in survival.</li>
 * <li>A bundled program's region: one shape per IR part (its id is {@link PartBuild#part}), kind {@code tile} (a bundled program's IR names
 * no plan/0 kind), its box the union of its ops' bounds; and each 4e road, kind {@code route}, ends its points.</li>
 * <li>(LYW) A wall's answer ({@code geometry.line}): the wall, its gates and passages, its corner stubs; its lots carry {@code wall} and
 * {@code wallAt}. A district's connecting route with stair or graded sections: one route from the IR's graph edge and {@code paths}.</li>
 * <li>(LYW2) A bundled program's ring wall (the IR's {@code walls}, its {@code ring(..., {wall: true})}): the wall, its gates and its towers,
 * as a wall answer's, in place of its part's tile. A mixed district route's road pieces are in its one route only.</li>
 * </ul>
 * Geometry is cached per region, head revision and IR sha; targets and lots per part come from the survival build when read. Server
 * thread. Internal.
 */
public final class Layouts {
	private Layouts() {
	}

	private static final Map<String, List<PartShape>> CACHE = new ConcurrentHashMap<>();

	static RegionLayout of(RegionsImpl.Live l) {
		RegionRec r = l.rec();
		String sha = Revisions.headIrSha(r);
		String k = r.id + "#" + r.headRid + "#" + sha;
		List<PartShape> geo = CACHE.get(k);
		if (geo == null) {
			geo = geometry(l);
			CACHE.keySet().removeIf(x -> x.startsWith(r.id + "#"));
			CACHE.put(k, geo);
		}
		// the targets and lot of each part (survival), read now: they change as targets are put down
		RegionBuild b = r.survival() ? dev.larattalabs.architect.site.RegionTargets.build(l) : null;
		Map<String, PartBuild> builds = new LinkedHashMap<>();
		if (b != null) {
			b.parts().forEach(p -> builds.put(p.part(), p));
		}
		List<PartShape> out = new ArrayList<>();
		for (PartShape s : geo) {
			PartBuild pb = builds.get(s.part());
			List<String> targets = pb != null ? pb.targets() : "lot".equals(s.kind()) && r.lots.get(s.part()) != null && r.lots.get(s.part()).siteId != null ? List.of(r
				.lots.get(s.part()).siteId) : List.of();
			String lot = s.lot() != null ? s.lot() : pb == null ? null : pb.lot();
			out.add(new PartShape(s.part(), s.kind(), s.stage(), s.box(), s.ends(), s.revision(), lot, targets, s.width(), s.height(), s.wall(), s.wallAt()));
		}
		return new RegionLayout(r.id, sha, r.headRid, out);
	}

	/** The cached half: every shape's part, kind, stage, box, ends and revision. */
	static List<PartShape> geometry(RegionsImpl.Live l) {
		RegionRec r = l.rec();
		JsonObject ir;
		try {
			ir = Revisions.effective(l);
		} catch (RuntimeException e) {
			ir = l.ir().json();
		}
		return shapes(ir, bodies(r), r.claim[1], r.claim[4], id -> r.lots.get(id) == null ? 0 : Revisions.lotRevision(r.lots.get(id)));
	}

	/**
	 * Every shape of an effective IR (pure): its lots, then the artifact's plan parts when {@code body} is given (a plan/0 region), else the
	 * IR's parts and roads. {@code y0}/{@code y1}: the claim's height range, for boxes the plan gives in x/z only.
	 */
	/** An artifact's body and the rid of the revision it realised (0: the region's own). */
	record Body(JsonObject body, int rid) {
	}

	/**
	 * Every shape of the head (pure): the effective IR's lots; then each artifact's plan parts, the realised artifact's first and each
	 * standing revision's after it in position order (a later answer for the same part replaces the earlier: a changed zone shows the head's
	 * geometry), each stamped with its revision's rid; then the effective IR's roads (kind route), so a growth's street appears; and, for a
	 * bundled program's region (no artifact), the effective IR's parts (kind tile). A part an artifact names is not repeated from the IR.
	 */
	static List<PartShape> shapes(JsonObject ir, List<Body> bodies, int y0, int y1, java.util.function.ToIntFunction<String> lotRev) {
		Map<String, PartShape> out = new LinkedHashMap<>();
		Map<String, BoundingBox> lotBoxes = LotViews.boxesOf(ir);
		Map<String, String> lotStage = new LinkedHashMap<>();
		if (ir.get("lots") instanceof JsonArray la) {
			for (JsonElement e : la) {
				if (e instanceof JsonObject lo && lo.get("id") != null) {
					lotStage.put(lo.get("id").getAsString(), StatusViews.str(lo, "stage"));
				}
			}
		}
		lotBoxes.forEach((id, box) -> out.put(id, new PartShape(id, "lot", lotStage.get(id), box, List.of(), lotRev.applyAsInt(id), id, List.of())));
		// (LYW) the lots a wall sited on its line: lot id -> {wall, at}
		Map<String, String[]> onWall = new LinkedHashMap<>();
		for (Body b : bodies) {
			if (b.body().get("parts") instanceof JsonArray ps) {
				for (JsonElement e : ps) {
					if (e instanceof JsonObject p && StatusViews.str(p, "part") != null) {
						if (p.get("geometry") instanceof JsonObject g && g.get("line") instanceof JsonArray) {
							for (PartShape sh : wallShapes(p, g, planPart(b.body(), StatusViews.str(p, "part")), y0, y1, onWall)) {
								PartShape was = out.get(sh.part());
								// (the wall itself always; a gate or tower the wall lists only when no gate part of the same answer named it)
								if (!lotBoxes.containsKey(sh.part()) && (sh.part().equals(StatusViews.str(p, "part")) || was == null || was.revision() < b.rid())) {
									out.put(sh.part(), restamp(sh, b.rid()));
								}
							}
							continue;
						}
						PartShape sh = ofAnswer(p, y0, y1);
						if (sh != null && !lotBoxes.containsKey(sh.part())) {
							out.put(sh.part(), restamp(sh, b.rid()));
						}
					}
				}
			}
		}
		onWall.forEach((lot, wa) -> {
			PartShape s = out.get(lot);
			if (s != null && "lot".equals(s.kind())) {
				out.put(lot, new PartShape(s.part(), s.kind(), s.stage(), s.box(), s.ends(), s.revision(), s.lot(), s.targets(), s.width(), s.height(), wa[0], wa[1]));
			}
		});
		if (ir.get("roads") instanceof JsonArray rs) {
			for (JsonElement e : rs) {
				if (e instanceof JsonObject rd && rd.get("points") instanceof JsonArray pts && StatusViews.str(rd, "id") != null && !out.containsKey(StatusViews.str(rd,
					"id"))) {
					List<BlockPos> line = new ArrayList<>();
					for (JsonElement q : pts) {
						JsonArray a = q.getAsJsonArray();
						line.add(new BlockPos(a.get(0).getAsInt(), a.size() > 2 ? a.get(1).getAsInt() : y0, a.get(a.size() > 2 ? 2 : 1).getAsInt()));
					}
					int w = rd.has("width") ? rd.get("width").getAsInt() : 3;
					BoundingBox box = boxOf(line, w / 2, y0, y1);
					if (box != null) {
						out.put(StatusViews.str(rd, "id"), new PartShape(StatusViews.str(rd, "id"), "route", StatusViews.str(rd, "stage"), box, simplify(line), rid(rd), null,
							List.of(), w, 0, null, null));
					}
				}
			}
		}
		districtRoutes(ir, out, y0, y1);
		// ((LYW2) a bundled program's ring walls, before its tiles: the wall's part is its shape, not a tile)
		if (bodies.isEmpty()) {
			ringWalls(ir, out, y0, y1);
		}
		// a bundled program's IR parts (a plan/0 region's IR parts are its plan parts' writes, already shown by their answers)
		if (bodies.isEmpty() && ir.get("parts") instanceof JsonArray ps) {
			for (JsonElement e : ps) {
				if (e instanceof JsonObject p && StatusViews.str(p, "id") != null && !out.containsKey(StatusViews.str(p, "id"))) {
					BoundingBox box = opsBox(p, y0, y1);
					if (box != null) {
						out.put(StatusViews.str(p, "id"), new PartShape(StatusViews.str(p, "id"), "tile", StatusViews.str(p, "stage"), box, List.of(), rid(p), null, List.of()));
					}
				}
			}
		}
		return List.copyOf(out.values());
	}

	/** (LYW) A copy stamped with a revision's rid, every other component kept. */
	private static PartShape restamp(PartShape s, int rid) {
		return new PartShape(s.part(), s.kind(), s.stage(), s.box(), s.ends(), rid, s.lot(), s.targets(), s.width(), s.height(), s.wall(), s.wallAt());
	}

	/** (LYW) kit/lib/connectors/wall.mjs WALL_DEFAULTS: a gate's opening height, a wall's thickness and height. */
	static final int WALL_GATE_HEIGHT = 3, WALL_THICKNESS = 2, WALL_HEIGHT = 6;
	/** (LYW) A corner stub tower stands this many above its wall (wall.mjs, "corner stubs: 3 above the wall"). */
	static final int STUB_ABOVE = 3;

	/** (LYW) The plan's part with this id (any top-level array of the artifact's plan: zones, connectors, forms, ...), or null. */
	static @Nullable JsonObject planPart(JsonObject body, @Nullable String id) {
		if (id == null || !(body.get("plan") instanceof JsonObject plan)) {
			return null;
		}
		for (Map.Entry<String, JsonElement> e : plan.entrySet()) {
			if (e.getValue() instanceof JsonArray a) {
				for (JsonElement q : a) {
					if (q instanceof JsonObject o && id.equals(StatusViews.str(o, "id"))) {
						return o;
					}
				}
			}
		}
		return null;
	}

	/** (LYW) A gate's opening: a square of its width round {@code at} (its walk's feet), {@code height} up. */
	private static PartShape gate(String id, String kind, @Nullable String stage, String wall, BlockPos at, int width, int height) {
		int h = Math.max(0, width / 2);
		BoundingBox box = new BoundingBox(at.getX() - h, at.getY(), at.getZ() - h, at.getX() + h, at.getY() + Math.max(1, height) - 1, at.getZ() + h);
		return new PartShape(id, kind, stage, box, List.of(at), 0, null, List.of(), width, height, wall, "gate");
	}

	/**
	 * (LYW, pure) A wall answer's shapes ({@code geometry.line}: K1's wall emission): the wall (its block the kind, its line the ends at its
	 * foot, a closed wall's line back to its first point; width its thickness, height its height); each gatehouse passage (its lot's
	 * {@code passage}: ends front and back) and each gate the wall lists; a {@code corners: tower} closed wall's corner stubs (the ring's
	 * corners, a max(3, thickness + 1) square, none where a lot's box holds the corner). Records each lot the wall sited in {@code onWall}.
	 */
	static List<PartShape> wallShapes(JsonObject p, JsonObject g, @Nullable JsonObject planPart, int y0, int y1, Map<String, String[]> onWall) {
		String id = StatusViews.str(p, "part");
		String kind = StatusViews.str(p, "block") == null ? "connector.wall" : StatusViews.str(p, "block");
		String stage = StatusViews.str(p, "stage");
		int t = num(g, "thickness", WALL_THICKNESS), height = num(g, "height", WALL_HEIGHT);
		int topLo = y1, topHi = y1;
		if (g.get("top") instanceof JsonArray top && top.size() == 2) {
			topLo = top.get(0).getAsInt();
			topHi = top.get(1).getAsInt();
		}
		int foot = g.get("top") instanceof JsonArray ? topLo - height + 1 : y0;
		List<BlockPos> line = new ArrayList<>();
		for (JsonElement q : g.getAsJsonArray("line")) {
			JsonArray a = q.getAsJsonArray();
			line.add(a.size() >= 3 ? new BlockPos(a.get(0).getAsInt(), foot, a.get(2).getAsInt()) : new BlockPos(a.get(0).getAsInt(), foot, a.get(1).getAsInt()));
		}
		boolean closed = g.get("closed") != null && g.get("closed").isJsonPrimitive() && g.get("closed").getAsBoolean();
		if (closed && line.size() > 2 && !line.get(0).equals(line.get(line.size() - 1))) {
			line.add(line.get(0));
		}
		List<PartShape> out = new ArrayList<>();
		BoundingBox box = boxOf(line, Math.max(0, t - 1), foot, Math.max(foot, topHi));
		if (box == null) {
			return out;
		}
		out.add(new PartShape(id, kind, stage, box, simplify(line), rid(p), null, List.of(), t, height, id, null));
		List<int[]> lotBoxes = new ArrayList<>();
		if (g.get("wallLots") instanceof JsonArray wl) {
			for (JsonElement e : wl) {
				if (!(e instanceof JsonObject q) || StatusViews.str(q, "lot") == null) {
					continue;
				}
				String lot = StatusViews.str(q, "lot");
				onWall.put(lot, new String[] {id, StatusViews.str(q, "at")});
				if (q.get("box") instanceof JsonArray b && b.size() == 6) {
					lotBoxes.add(new int[] {b.get(0).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(5).getAsInt()});
				}
				if (q.get("passage") instanceof JsonObject ps && ps.get("front") instanceof JsonArray f && ps.get("back") instanceof JsonArray bk) {
					List<BlockPos> fb = List.of(pos(f, foot), pos(bk, foot));
					int w = num(ps, "width", 3), h = num(ps, "height", WALL_GATE_HEIGHT);
					BoundingBox pb = boxOf(fb, w / 2, fb.get(0).getY(), fb.get(0).getY() + Math.max(1, h) - 1);
					out.add(new PartShape(lot + "_passage", "connector.gate", stage, pb, fb, rid(p), lot, List.of(), w, h, id, "gate"));
				}
			}
		}
		if (g.get("gates") instanceof JsonArray gs) {
			for (JsonElement e : gs) {
				if (e instanceof JsonObject q && StatusViews.str(q, "id") != null && q.get("at") instanceof JsonArray at && at.size() >= 3 && out.stream().noneMatch(
					s -> s.part().equals(StatusViews.str(q, "id")))) {
					out.add(gate(StatusViews.str(q, "id"), "connector.gate", stage, id, pos(at, foot), num(q, "width", 3), num(q, "height", WALL_GATE_HEIGHT)));
				}
			}
		}
		// ((LYW2) a ring wall's towers along its run: {id, at (its centre at its lowest footing), r, height}; a K1 wall has none)
		if (g.get("towers") instanceof JsonArray tw) {
			for (JsonElement e : tw) {
				if (e instanceof JsonObject q && StatusViews.str(q, "id") != null && q.get("at") instanceof JsonArray at && at.size() >= 3) {
					BlockPos c = pos(at, foot);
					int r = num(q, "r", 3), th = num(q, "height", height);
					out.add(new PartShape(StatusViews.str(q, "id"), "tower", stage, new BoundingBox(c.getX() - r, c.getY(), c.getZ() - r, c.getX() + r, c.getY() + Math
						.max(1, th) - 1, c.getZ() + r), List.of(c), rid(p), null, List.of(), 2 * r + 1, th, id, "run"));
				}
			}
		}
		if (closed && planPart != null && "tower".equals(StatusViews.str(planPart, "corners")) && g.get("ring") instanceof JsonArray rg && rg.size() == 4) {
			int s = Math.max(3, t + 1), minX = rg.get(0).getAsInt(), minZ = rg.get(1).getAsInt(), maxX = rg.get(2).getAsInt(), maxZ = rg.get(3).getAsInt();
			int[][] corners = {{minX, minZ, -1, -1}, {maxX, minZ, 1, -1}, {maxX, maxZ, 1, 1}, {minX, maxZ, -1, 1}};
			for (int i = 0; i < 4; i++) {
				int[] c = corners[i];
				int ox = c[2] < 0 ? c[0] - (s - 1) : c[0], oz = c[3] < 0 ? c[1] - (s - 1) : c[1];
				int x1 = ox + s - 1, z1 = oz + s - 1;
				// (a corner holding a lot's box has no stub)
				if (lotBoxes.stream().anyMatch(b -> ox <= b[2] && x1 >= b[0] && oz <= b[3] && z1 >= b[1])) {
					continue;
				}
				out.add(new PartShape(id + "_tower_" + (i + 1), "tower", stage, new BoundingBox(ox, foot, oz, x1, Math.max(foot, topHi) + STUB_ABOVE, z1), List.of(),
					rid(p), null, List.of(), s, height + STUB_ABOVE, id, "corner"));
			}
		}
		return out;
	}

	/**
	 * (LYW2, pure) A bundled program's ring walls (the IR's {@code walls}: kit program.mjs {@code _ringWall}), each read as a wall answer
	 * ({@link #wallShapes}: its line, thickness, height, top, gates and towers), its part's stage and rid. A wall whose part already has a
	 * shape, or that names no part, is skipped.
	 */
	static void ringWalls(JsonObject ir, Map<String, PartShape> out, int y0, int y1) {
		if (!(ir.get("walls") instanceof JsonArray ws)) {
			return;
		}
		Map<String, JsonObject> parts = new LinkedHashMap<>();
		if (ir.get("parts") instanceof JsonArray ps) {
			for (JsonElement e : ps) {
				if (e instanceof JsonObject p && StatusViews.str(p, "id") != null) {
					parts.put(StatusViews.str(p, "id"), p);
				}
			}
		}
		for (JsonElement e : ws) {
			if (!(e instanceof JsonObject w) || StatusViews.str(w, "part") == null || !(w.get("line") instanceof JsonArray) || out.containsKey(StatusViews.str(w, "part"))) {
				continue;
			}
			String id = StatusViews.str(w, "part");
			JsonObject p = new JsonObject();
			p.addProperty("part", id);
			p.addProperty("block", "connector.wall");
			JsonObject ip = parts.get(id);
			if (ip != null && StatusViews.str(ip, "stage") != null) {
				p.addProperty("stage", StatusViews.str(ip, "stage"));
			}
			if (ip != null && ip.get("rid") != null) {
				p.add("rid", ip.get("rid"));
			}
			for (PartShape sh : wallShapes(p, w, null, y0, y1, new LinkedHashMap<>())) {
				out.putIfAbsent(sh.part(), sh);
			}
		}
	}

	/** (LYW) A district's connecting route's edge id: the districts pass's {@code route_d_<a>__<b>} and its joins. */
	private static final java.util.regex.Pattern DISTRICT_ROUTE = java.util.regex.Pattern.compile("route_(d_[a-z0-9_]+|join|join_in)");

	/**
	 * (LYW, pure) A district's connecting routes that the IR's roads don't already show whole: each graph edge of the districts pass
	 * ({@link #DISTRICT_ROUTE}, its id its path) with at least one stair, graded or ladder section in the IR's {@code paths}
	 * ({@code <path>_<n>}, {@code <path>_<n>l}): kind {@code route}, its ends the edge's from node, each section in order (a road piece's
	 * points, a path section's box centre) and its to node; its box the union; its width the edge's. A route laid as roads only is already
	 * there (its roads, kind route).
	 */
	static void districtRoutes(JsonObject ir, Map<String, PartShape> out, int y0, int y1) {
		if (!(ir.get("graph") instanceof JsonObject gr) || !(gr.get("edges") instanceof JsonArray es) || !(ir.get("paths") instanceof JsonArray paths)) {
			return;
		}
		Map<String, BlockPos> nodeAt = new LinkedHashMap<>();
		if (gr.get("nodes") instanceof JsonArray ns) {
			for (JsonElement e : ns) {
				if (e instanceof JsonObject n && StatusViews.str(n, "id") != null && n.get("at") instanceof JsonArray a && a.size() >= 3) {
					nodeAt.put(StatusViews.str(n, "id"), pos(a, y0));
				}
			}
		}
		// (v0.84 review) every district route edge first: a piece belongs to the longest edge id it extends (district b_1's
		// route_d_a__b_1_1 is its own piece 1, not a group of b's piece 1)
		List<String> edgeIds = new ArrayList<>();
		for (JsonElement e : es) {
			if (e instanceof JsonObject ed && StatusViews.str(ed, "id") != null && StatusViews.str(ed, "id").equals(StatusViews.str(ed, "path")) && DISTRICT_ROUTE
				.matcher(StatusViews.str(ed, "id")).matches()) {
				edgeIds.add(StatusViews.str(ed, "id"));
			}
		}
		java.util.Set<String> folded = new java.util.HashSet<>();
		Map<String, PartShape> routes = new LinkedHashMap<>();
		for (JsonElement e : es) {
			if (!(e instanceof JsonObject ed)) {
				continue;
			}
			String id = StatusViews.str(ed, "id");
			if (id == null || !edgeIds.contains(id) || out.containsKey(id) && routeOwner(id, edgeIds, ROAD_PIECE) == null) {
				// (an id another part already has, unless it is another route's road piece, folded below)
				continue;
			}
			java.util.regex.Pattern piece = java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(id) + PATH_PIECE.pattern());
			// ((LYW2) a road piece: <path>_<n>, or a long one's groups <path>_<n>_<k> (program.mjs _groundRoad))
			java.util.regex.Pattern roadPiece = java.util.regex.Pattern.compile(java.util.regex.Pattern.quote(id) + ROAD_PIECE.pattern());
			List<String> mine = new ArrayList<>();
			java.util.TreeMap<Double, List<BlockPos>> pieces = new java.util.TreeMap<>();
			int[] b = null;
			boolean section = false;
			for (JsonElement q : paths) {
				java.util.regex.Matcher m;
				if (q instanceof JsonObject ps && StatusViews.str(ps, "id") != null && (m = piece.matcher(StatusViews.str(ps, "id"))).matches() && id.equals(routeOwner(
					StatusViews.str(ps, "id"), edgeIds, PATH_PIECE)) && ps
					.get("box") instanceof JsonObject bx && bx.get("minX") != null) {
					int[] r = {bx.get("minX").getAsInt(), num(bx, "minY", y0), bx.get("minZ").getAsInt(), bx.get("maxX").getAsInt(), num(bx, "maxY", y1), bx.get(
						"maxZ").getAsInt()};
					pieces.put(Integer.parseInt(m.group(1)) + (m.group(2).isEmpty() ? 0 : 0.5), List.of(new BlockPos((r[0] + r[3]) / 2, r[1], (r[2] + r[5]) / 2)));
					b = union(b, r);
					section = true;
				}
			}
			if (!section) {
				continue;
			}
			int w = ed.get("width") != null && ed.get("width").isJsonPrimitive() ? ed.get("width").getAsInt() : 3;
			if (ir.get("roads") instanceof JsonArray rs) {
				for (JsonElement q : rs) {
					java.util.regex.Matcher m;
					if (q instanceof JsonObject rd && StatusViews.str(rd, "id") != null && (m = roadPiece.matcher(StatusViews.str(rd, "id"))).matches() && id.equals(
						routeOwner(StatusViews.str(rd, "id"), edgeIds, ROAD_PIECE)) && rd
						.get("points") instanceof JsonArray pts) {
						List<BlockPos> line = new ArrayList<>();
						for (JsonElement pt : pts) {
							JsonArray a = pt.getAsJsonArray();
							line.add(pos(a, y0));
						}
						pieces.put(Integer.parseInt(m.group(1)) + (m.group(2) == null ? 0 : Integer.parseInt(m.group(2)) / 1000.0), line);
						mine.add(StatusViews.str(rd, "id"));
						BoundingBox rb = boxOf(line, w / 2, y0, y1);
						if (rb != null) {
							b = union(b, new int[] {rb.minX(), line.stream().mapToInt(BlockPos::getY).min().orElse(y0), rb.minZ(), rb.maxX(), line.stream().mapToInt(
								BlockPos::getY).max().orElse(y1), rb.maxZ()});
						}
					}
				}
			}
			List<BlockPos> line = new ArrayList<>();
			BlockPos from = nodeAt.get(nodeOf(StatusViews.str(ed, "from"))), to = nodeAt.get(nodeOf(StatusViews.str(ed, "to")));
			if (from != null) {
				line.add(from);
			}
			pieces.values().forEach(line::addAll);
			if (to != null) {
				line.add(to);
			}
			for (BlockPos q : line) {
				b = union(b, new int[] {q.getX(), q.getY(), q.getZ(), q.getX(), q.getY(), q.getZ()});
			}
			folded.addAll(mine);
			routes.put(id, new PartShape(id, "route", StatusViews.str(ed, "stage"), new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]), simplify(line), rid(ed), null,
				List.of(), w, 0, null, null));
		}
		// ((LYW2) each road piece a route folds in is in that route only: not also its own route shape, from the IR's roads)
		for (String f : folded) {
			if (out.get(f) != null && "route".equals(out.get(f).kind())) {
				out.remove(f);
			}
		}
		routes.forEach(out::putIfAbsent);
	}

	/** (LYW) A district route's path section suffix ({@code _<n>}, {@code _<n>l}) and road piece suffix ({@code _<n>}, {@code _<n>_<k>}). */
	private static final java.util.regex.Pattern PATH_PIECE = java.util.regex.Pattern.compile("_(\\d+)(l?)"),
		ROAD_PIECE = java.util.regex.Pattern.compile("_(\\d+)(?:_(\\d+))?");

	/**
	 * (v0.84 review, pure) The district route edge a section or road piece id belongs to: the longest of {@code edgeIds} it extends by
	 * {@code suffix}, or null.
	 */
	static @Nullable String routeOwner(String pieceId, List<String> edgeIds, java.util.regex.Pattern suffix) {
		String best = null;
		for (String e : edgeIds) {
			if (pieceId.startsWith(e + "_") && (best == null || e.length() > best.length()) && suffix.matcher(pieceId.substring(e.length())).matches()) {
				best = e;
			}
		}
		return best;
	}

	/** A graph port reference's node ({@code node.port}; an external {@code region:node.port} has none here). */
	private static @Nullable String nodeOf(@Nullable String ref) {
		if (ref == null || ref.contains(":") && !ref.startsWith("lot:")) {
			return null;
		}
		int dot = ref.lastIndexOf('.');
		return dot < 0 ? ref : ref.substring(0, dot);
	}

	private static int[] union(int @Nullable [] b, int[] q) {
		if (b == null) {
			return q.clone();
		}
		for (int i = 0; i < 3; i++) {
			b[i] = Math.min(b[i], q[i]);
			b[i + 3] = Math.max(b[i + 3], q[i + 3]);
		}
		return b;
	}

	/** The artifacts a plan/0 region was realised and revised from: its own, then every standing revision's up to the head, in position order. */
	static List<Body> bodies(RegionRec r) {
		List<Body> out = new ArrayList<>();
		JsonObject b = artifactBody(r);
		if (b != null) {
			out.add(new Body(b, 0));
		}
		List<Revisions.Rev> revs = new ArrayList<>(r.revisions);
		revs.sort(java.util.Comparator.comparingInt(v -> v.position));
		for (Revisions.Rev v : revs) {
			if (v.standing() && v.position <= r.position && v.artifact != null) {
				try {
					PlanChecks.artifact(v.artifact).ifPresent(a -> out.add(new Body(a.body(), v.rid)));
				} catch (RuntimeException e) {
					// an unreadable revision artifact: its parts come from the effective IR only
				}
			}
		}
		return out;
	}

	/** The artifact a plan/0 region was realised from, its body; null for a bundled program's region. */
	static @Nullable JsonObject artifactBody(RegionRec r) {
		String sha = StatusViews.str(r.ext, PlanChecks.EXT_ARTIFACT);
		if (sha == null) {
			return null;
		}
		try {
			return PlanChecks.artifact(sha).map(a -> a.body()).orElse(null);
		} catch (RuntimeException e) {
			return null;
		}
	}

	/** A check answer's shape (pure): its block the kind, its geometry's rect, link or legs the box and ends; null with no geometry. */
	static @Nullable PartShape ofAnswer(JsonObject p, int y0, int y1) {
		String id = StatusViews.str(p, "part");
		String kind = StatusViews.str(p, "block");
		JsonObject g = p.get("geometry") instanceof JsonObject o ? o : null;
		if (g == null) {
			return null;
		}
		// ((LYW) a gate part: its opening in its wall)
		if (StatusViews.str(g, "wall") != null && g.get("at") instanceof JsonArray at && at.size() >= 3) {
			return gate(id, kind == null ? "connector.gate" : kind, StatusViews.str(p, "stage"), StatusViews.str(g, "wall"), pos(at, y0), num(g, "width", 3), num(g,
				"height", WALL_GATE_HEIGHT));
		}
		List<BlockPos> ends = new ArrayList<>();
		BoundingBox box = null;
		if (g.get("link") instanceof JsonObject link && link.get("from") instanceof JsonArray f && link.get("to") instanceof JsonArray t) {
			ends.add(pos(f, y0));
			ends.add(pos(t, y0));
			box = boxOf(ends, 0, Math.min(ends.get(0).getY(), ends.get(1).getY()), Math.max(ends.get(0).getY(), ends.get(1).getY()));
		} else if (g.get("legs") instanceof JsonArray legs) {
			for (JsonElement le : legs) {
				if (le instanceof JsonObject leg) {
					if (leg.get("path") instanceof JsonArray path && !path.isEmpty()) {
						path.forEach(q -> ends.add(pos(q.getAsJsonArray(), y0)));
					} else if (leg.get("from") instanceof JsonArray f && leg.get("to") instanceof JsonArray t) {
						ends.add(pos(f, y0));
						ends.add(pos(t, y0));
					}
				}
			}
			box = boxOf(ends, 1, y0, y1);
		}
		if (g.get("rect") instanceof JsonArray rc && rc.size() == 4) {
			box = new BoundingBox(rc.get(0).getAsInt(), y0, rc.get(1).getAsInt(), rc.get(2).getAsInt(), y1, rc.get(3).getAsInt());
		}
		if (box == null) {
			return null;
		}
		return new PartShape(id, kind == null ? "part" : kind, StatusViews.str(p, "stage"), box, simplify(ends), rid(p), null, List.of());
	}

	/** An IR part's box: the union of its ops' bounds (a null minY or maxY: the claim's). Null with none. Pure. */
	static @Nullable BoundingBox opsBox(JsonObject part, int y0, int y1) {
		if (!(part.get("ops") instanceof JsonArray ops)) {
			return null;
		}
		int[] b = null;
		for (JsonElement e : ops) {
			if (e instanceof JsonObject op && op.get("bounds") instanceof JsonObject bd && bd.get("minX") != null && !bd.get("minX").isJsonNull()) {
				int[] q = {bd.get("minX").getAsInt(), num(bd, "minY", y0), bd.get("minZ").getAsInt(), bd.get("maxX").getAsInt(), num(bd, "maxY", y1), bd.get("maxZ")
					.getAsInt()};
				if (b == null) {
					b = q;
				} else {
					for (int i = 0; i < 3; i++) {
						b[i] = Math.min(b[i], q[i]);
						b[i + 3] = Math.max(b[i + 3], q[i + 3]);
					}
				}
			}
		}
		return b == null ? null : new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]);
	}

	/**
	 * A polyline kept to at most {@link PartShape#MAX_ENDS} points (pure): consecutive duplicates dropped, then every n-th point with the
	 * last kept.
	 */
	static List<BlockPos> simplify(List<BlockPos> pts) {
		List<BlockPos> u = dedupe(pts);
		if (u.size() <= PartShape.MAX_ENDS) {
			return List.copyOf(u);
		}
		List<BlockPos> out = new ArrayList<>();
		double step = (u.size() - 1) / (double) (PartShape.MAX_ENDS - 1);
		for (int i = 0; i < PartShape.MAX_ENDS; i++) {
			out.add(u.get((int) Math.round(i * step)));
		}
		return List.copyOf(out);
	}

	private static List<BlockPos> dedupe(List<BlockPos> pts) {
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos p : pts) {
			if (out.isEmpty() || !out.get(out.size() - 1).equals(p)) {
				out.add(p);
			}
		}
		return out;
	}

	private static @Nullable BoundingBox boxOf(List<BlockPos> pts, int pad, int y0, int y1) {
		if (pts.isEmpty()) {
			return null;
		}
		int x0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
		for (BlockPos p : pts) {
			x0 = Math.min(x0, p.getX());
			z0 = Math.min(z0, p.getZ());
			x1 = Math.max(x1, p.getX());
			z1 = Math.max(z1, p.getZ());
		}
		return new BoundingBox(x0 - pad, Math.min(y0, y1), z0 - pad, x1 + pad, Math.max(y0, y1), z1 + pad);
	}

	private static BlockPos pos(JsonArray a, int y0) {
		return a.size() >= 3 ? new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()) : new BlockPos(a.get(0).getAsInt(), y0, a.get(1)
			.getAsInt());
	}

	private static int num(JsonObject o, String k, int dflt) {
		return o.get(k) == null || o.get(k).isJsonNull() ? dflt : o.get(k).getAsInt();
	}

	private static int rid(JsonObject o) {
		return o.get("rid") != null && o.get("rid").isJsonPrimitive() ? o.get("rid").getAsInt() : 0;
	}

	/** (TEST) Drops the cache. */
	static void clear() {
		CACHE.clear();
	}
}
