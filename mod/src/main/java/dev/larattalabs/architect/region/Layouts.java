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
			out.add(new PartShape(s.part(), s.kind(), s.stage(), s.box(), s.ends(), s.revision(), lot, targets));
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
		for (Body b : bodies) {
			if (b.body().get("parts") instanceof JsonArray ps) {
				for (JsonElement e : ps) {
					if (e instanceof JsonObject p && StatusViews.str(p, "part") != null) {
						PartShape sh = ofAnswer(p, y0, y1);
						if (sh != null && !lotBoxes.containsKey(sh.part())) {
							out.put(sh.part(), new PartShape(sh.part(), sh.kind(), sh.stage(), sh.box(), sh.ends(), b.rid(), null, List.of()));
						}
					}
				}
			}
		}
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
							List.of()));
					}
				}
			}
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
