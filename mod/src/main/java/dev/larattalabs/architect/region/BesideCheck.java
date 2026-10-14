package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import org.jspecify.annotations.Nullable;

/**
 * (6c D1) A district beside a standing region (docs/CONTRACT.md "Phase 6c slice D" §3), the mod's half; kit/lib/region/beside.mjs is
 * the same rule in the kit (its reference and tests). The standing region's footprint from its IR (its lot boxes, its 4e roads across
 * their width plus 1, its paths' boxes and its path-set parts' columns), the seam rule (the new claim may overlap the standing claim
 * only in a seam of at most {@link #SEAM_MAX} columns and never over that footprint) and the {@code beside} data a plan reads
 * ({@code ctx.beside}: the standing region's id, claim, lot boxes and footprint near the new claim, and its graph).
 */
public final class BesideCheck {
	/** The deepest overlap of the two claims (columns, the narrower side of their intersection). */
	public static final int SEAM_MAX = 16;

	private BesideCheck() {
	}

	/** One footprint rect: what wrote it ({@code lot}, {@code road}, {@code path}, {@code way}), its id and [x0, z0, x1, z1]. */
	public record Piece(String kind, String id, int[] rect) {
	}

	/** The standing region's footprint from its IR, in the kit's order (lots, roads, paths, ways). */
	public static List<Piece> footprint(JsonObject ir) {
		List<Piece> out = new ArrayList<>();
		if (ir.get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				JsonObject l = e.getAsJsonObject(), b = l.getAsJsonObject("box");
				out.add(new Piece("lot", str(l, "id"), new int[] {b.get("minX").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxZ").getAsInt()}));
			}
		}
		if (ir.get("roads") instanceof JsonArray roads) {
			for (JsonElement e : roads) {
				JsonObject r = e.getAsJsonObject();
				int h = (r.has("width") ? r.get("width").getAsInt() : 3) / 2 + 1;
				JsonArray pts = r.getAsJsonArray("points");
				for (int i = 0; i + 1 < pts.size(); i++) {
					JsonArray a = pts.get(i).getAsJsonArray(), b = pts.get(i + 1).getAsJsonArray();
					int ax = a.get(0).getAsInt(), az = a.get(2).getAsInt(), bx = b.get(0).getAsInt(), bz = b.get(2).getAsInt();
					boolean alongX = az == bz, alongZ = ax == bx;
					out.add(new Piece("road", str(r, "id"), new int[] {Math.min(ax, bx) - (alongX ? 0 : h), Math.min(az, bz) - (alongZ ? 0 : h),
						Math.max(ax, bx) + (alongX ? 0 : h), Math.max(az, bz) + (alongZ ? 0 : h)}));
				}
			}
		}
		if (ir.get("paths") instanceof JsonArray paths) {
			for (JsonElement e : paths) {
				JsonObject p = e.getAsJsonObject();
				if (p.get("box") instanceof JsonObject b) {
					out.add(new Piece("path", str(p, "id"), new int[] {b.get("minX").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxZ").getAsInt()}));
				}
			}
		}
		if (ir.get("parts") instanceof JsonArray parts) {
			for (JsonElement e : parts) {
				JsonObject p = e.getAsJsonObject();
				if (!"path".equals(str(p, "set"))) {
					continue;
				}
				String id = str(p, "id");
				// columns as row runs (z, then x)
				TreeMap<Integer, TreeSet<Integer>> byZ = new TreeMap<>();
				if (p.get("ops") instanceof JsonArray ops) {
					for (JsonElement oe : ops) {
						JsonObject op = oe.getAsJsonObject();
						if ("columns".equals(str(op, "op")) && op.get("cols") instanceof JsonArray cols) {
							for (int i = 0; i + 4 < cols.size(); i += 5) {
								byZ.computeIfAbsent(cols.get(i + 1).getAsInt(), k -> new TreeSet<>()).add(cols.get(i).getAsInt());
							}
						} else if (op.get("bounds") instanceof JsonObject b) {
							out.add(new Piece("way", id, new int[] {b.get("minX").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxZ").getAsInt()}));
						}
					}
				}
				for (Map.Entry<Integer, TreeSet<Integer>> row : byZ.entrySet()) {
					int z = row.getKey();
					Integer s = null, last = null;
					for (int x : row.getValue()) {
						if (s == null) {
							s = x;
						} else if (x != last + 1) {
							out.add(new Piece("way", id, new int[] {s, z, last, z}));
							s = x;
						}
						last = x;
					}
					if (s != null) {
						out.add(new Piece("way", id, new int[] {s, z, last, z}));
					}
				}
			}
		}
		return out;
	}

	/** The seam rule: null when {@code claim} may stand beside the standing region, else the reason (an OVERLAP refusal's message). */
	public static @Nullable String seamProblem(int[] standingClaim, JsonObject ir, int[] claim) {
		int ix0 = Math.max(standingClaim[0], claim[0]), iz0 = Math.max(standingClaim[1], claim[1]);
		int ix1 = Math.min(standingClaim[2], claim[2]), iz1 = Math.min(standingClaim[3], claim[3]);
		if (ix0 > ix1 || iz0 > iz1) {
			return null;
		}
		int deep = Math.min(ix1 - ix0 + 1, iz1 - iz0 + 1);
		String seam = "[" + ix0 + ", " + iz0 + ", " + ix1 + ", " + iz1 + "]";
		if (deep > SEAM_MAX) {
			return "the claim overlaps the standing region's " + deep + " columns deep (the seam " + seam + "; at most " + SEAM_MAX + ")";
		}
		for (Piece p : footprint(ir)) {
			if (meets(p.rect(), claim)) {
				return "the seam " + seam + " meets the standing region's " + p.kind() + " " + p.id() + " at [" + p.rect()[0] + ", " + p.rect()[1] + ", "
					+ p.rect()[2] + ", " + p.rect()[3] + "]";
			}
		}
		return null;
	}

	/** The {@code beside} member of {@code region.plan}: {id, claim, lots, keep, graph} (the footprint within SEAM_MAX + 8 of the claim). */
	public static JsonObject besideData(String id, int[] standingClaim, JsonObject ir, int[] claim) {
		int[] near = {claim[0] - SEAM_MAX - 8, claim[1] - SEAM_MAX - 8, claim[2] + SEAM_MAX + 8, claim[3] + SEAM_MAX + 8};
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.add("claim", arr(standingClaim));
		JsonArray lots = new JsonArray(), keep = new JsonArray();
		for (Piece p : footprint(ir)) {
			if (!meets(p.rect(), near)) {
				continue;
			}
			("lot".equals(p.kind()) ? lots : keep).add(arr(p.rect()));
		}
		o.add("lots", lots);
		o.add("keep", keep);
		JsonObject g = new JsonObject();
		JsonObject graph = ir.get("graph") instanceof JsonObject x ? x : new JsonObject();
		g.add("nodes", graph.get("nodes") instanceof JsonArray n ? n.deepCopy() : new JsonArray());
		g.add("edges", graph.get("edges") instanceof JsonArray e ? e.deepCopy() : new JsonArray());
		o.add("graph", g);
		return o;
	}

	static boolean meets(int[] a, int[] b) {
		return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
	}

	private static JsonArray arr(int[] r) {
		JsonArray a = new JsonArray();
		for (int v : r) {
			a.add(v);
		}
		return a;
	}

	private static String str(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : "";
	}
}
