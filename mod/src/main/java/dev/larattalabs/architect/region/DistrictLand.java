package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.region.BesideReach.Cols;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * (6c D3, D-S3; docs/CONTRACT.md "Phase 6c slice D3" §6) {@code architect_mc:land}: the land a districts region takes, from its IR alone,
 * set in its ext at realise. kit/lib/region/land.mjs is the reference; the two are equal on every fixture ({@code DistrictLandTest}).
 * Parts: district (a following district's columns as a mask, a plain one's or an outpost's as the rect round them), join (its written
 * columns, its reach and the contact columns it holds), route (each route between districts), corridor (an outpost's
 * {@code architect_mc:corridor}, exactly), extra (written columns in no other part). {@code union}: every part's columns but a corridor
 * column in the town's claim nothing writes; {@code outside}: union minus the town's claim; {@code inside}: union in it.
 */
public final class DistrictLand {
	/** The record's version (6d's grown parts move it to 2). */
	public static final int V = 1;
	/** (6d GR §7) The version once the region has had a revision (it stays 2 after undoRevision). Since NEXT. */
	public static final int V2 = 2;
	public static final String EXT_LAND = "architect_mc:land";

	private static final Pattern JOIN_PATH = Pattern.compile("^route_join_\\d+[lg]?$");
	private static final Pattern JOIN_ROAD = Pattern.compile("^route_join_\\d+$");
	private static final Pattern ROUTE_PATH = Pattern.compile("^route_(d_[a-z0-9_]+?__[a-z0-9_]+?)_\\d+[lg]?$");
	private static final Pattern ROUTE_ROAD = Pattern.compile("^route_(d_[a-z0-9_]+?__[a-z0-9_]+?)_\\d+$");

	private DistrictLand() {
	}

	/** The record, or null for an IR that is not a districts plan (no districts in its params). */
	public static @Nullable JsonObject of(JsonObject ir, int @Nullable [] town, @Nullable Long standingRemoved) {
		return of(ir, town, standingRemoved, false);
	}

	/**
	 * (6d GR §7) The record of an effective IR: v 2 once the region has had a revision ({@code revised}, or an effective IR with
	 * revisions); a revision's parts, lots and roads (the entries carrying {@code rid}) are its own {@code grown} part {@code rv<rid>}
	 * ({@code district}, {@code revision}), never a district's or {@code extra}; every part carries {@code revision} (0: the realised plan's).
	 */
	public static @Nullable JsonObject of(JsonObject ir0, int @Nullable [] town, @Nullable Long standingRemoved, boolean revised) {
		JsonObject ir = ir0;
		boolean v2 = revised || (ir0.get("revisions") instanceof JsonArray rv && !rv.isEmpty());
		TreeMap<Integer, Cols> grown = new TreeMap<>();
		TreeMap<Integer, java.util.TreeSet<String>> grownD = new TreeMap<>();
		TreeMap<Integer, List<JsonObject>> grownBands = new TreeMap<>();
		JsonArray ds = null;
		if (ir.get("params") instanceof JsonObject params) {
			if (params.get("spec") instanceof JsonObject spec && spec.get("districts") instanceof JsonArray a) {
				ds = a;
			} else if (params.get("districts") instanceof JsonArray a) {
				ds = a;
			}
		}
		if (ds == null) {
			return null;
		}
		if (v2) {
			List<String> dids = new ArrayList<>();
			for (JsonElement de : ds) {
				String id = BesideReach.str(de.getAsJsonObject(), "id");
				if (id != null) {
					dids.add(id);
				}
			}
			ir = ir0.deepCopy();
			for (String fam : List.of("parts", "lots", "roads")) {
				JsonArray keep = new JsonArray();
				if (ir.get(fam) instanceof JsonArray a) {
					for (JsonElement e : a) {
						JsonObject x = e.getAsJsonObject();
						int rid = x.get("rid") instanceof JsonElement r && r.isJsonPrimitive() ? r.getAsInt() : 0;
						if (rid <= 0) {
							keep.add(x);
							continue;
						}
						Cols c = grown.computeIfAbsent(rid, k -> new Cols());
						java.util.TreeSet<String> dd = grownD.computeIfAbsent(rid, k -> new java.util.TreeSet<>());
						switch (fam) {
							case "parts" -> {
								opsCols(x, c);
								for (String d : dids) {
									if (str(x, "id").startsWith("rv" + rid + "_" + d + "_")) {
										dd.add(d);
									}
								}
							}
							case "lots" -> boxCols(x.getAsJsonObject("box"), c);
							default -> {
								roadCols(x, c);
								if (x.get("ext") instanceof JsonObject ex && ex.get("architect_mc:street") instanceof JsonObject f && f.get("district") instanceof JsonElement d
									&& d.isJsonPrimitive()) {
									dd.add(d.getAsString());
								}
								if (x.get("ext") instanceof JsonObject ex2 && ex2.get("architect_mc:band") instanceof JsonObject b && b.get("district") instanceof JsonElement bd
									&& bd.isJsonPrimitive() && b.get("runs") instanceof JsonArray) {
									grownBands.computeIfAbsent(rid, k -> new ArrayList<>()).add(b);
								}
							}
						}
					}
					ir.add(fam, keep);
				}
			}
		}
		Cols written = new Cols();
		JsonArray parts = ir.get("parts") instanceof JsonArray p ? p : new JsonArray();
		for (JsonElement pe : parts) {
			opsCols(pe.getAsJsonObject(), written);
		}
		JsonArray lots = ir.get("lots") instanceof JsonArray l ? l : new JsonArray();
		for (JsonElement le : lots) {
			boxCols(le.getAsJsonObject().getAsJsonObject("box"), written);
		}
		JsonArray roads = ir.get("roads") instanceof JsonArray r ? r : new JsonArray();
		for (JsonElement re : roads) {
			roadCols(re.getAsJsonObject(), written);
		}
		JsonArray paths = ir.get("paths") instanceof JsonArray pa ? pa : new JsonArray();
		JsonObject reach = ir.get("reach") instanceof JsonObject rc ? rc : null;
		if (reach != null) {
			written.addRuns(reach.getAsJsonArray("runs"));
		}
		List<JsonObject> out = new ArrayList<>();
		Cols claimed = new Cols();
		List<String> ids = new ArrayList<>();
		for (JsonElement de : ds) {
			JsonObject d = de.getAsJsonObject();
			String id = BesideReach.str(d, "id");
			if (id == null) {
				continue;
			}
			ids.add(id);
			String pre = id + "_";
			Cols c = new Cols();
			for (JsonElement pe : parts) {
				JsonObject p = pe.getAsJsonObject();
				if (str(p, "id").startsWith(pre)) {
					opsCols(p, c);
				}
			}
			for (JsonElement le : lots) {
				JsonObject l = le.getAsJsonObject();
				if (str(l, "part").startsWith(pre)) {
					boxCols(l.getAsJsonObject("box"), c);
				}
			}
			for (JsonElement re : roads) {
				JsonObject rd = re.getAsJsonObject();
				if (str(rd, "id").startsWith(pre) || str(rd, "id").startsWith("route_st_" + id + "_")) {
					roadCols(rd, c);
				}
			}
			for (JsonElement pe : paths) {
				JsonObject p = pe.getAsJsonObject();
				if (str(p, "id").startsWith("route_st_" + id + "_") && p.get("box") instanceof JsonObject b) {
					boxCols(b, c);
				}
			}
			if (c.isEmpty()) {
				continue;
			}
			JsonObject extra = new JsonObject();
			if (d.has("follow")) {
				extra.addProperty("shape", "mask");
				push(out, claimed, town, "district", id, c, extra);
			} else {
				int[] r = c.rect();
				Cols rc2 = new Cols();
				rc2.addRect(r[0], r[1], r[2], r[3]);
				extra.addProperty("shape", "rect");
				push(out, claimed, town, "district", id, rc2, extra);
			}
		}
		// the join
		Cols join = new Cols();
		JsonObject jp = null;
		for (JsonElement pe : parts) {
			if ("route_join".equals(str(pe.getAsJsonObject(), "id"))) {
				jp = pe.getAsJsonObject();
			}
		}
		if (jp != null) {
			opsCols(jp, join);
		}
		if (reach != null) {
			join.addRuns(reach.getAsJsonArray("runs"));
		}
		if (jp == null) {
			for (JsonElement pe : paths) {
				JsonObject p = pe.getAsJsonObject();
				if (JOIN_PATH.matcher(str(p, "id")).matches() && p.get("box") instanceof JsonObject b) {
					boxCols(b, join);
				}
			}
			for (JsonElement re : roads) {
				if (JOIN_ROAD.matcher(str(re.getAsJsonObject(), "id")).matches()) {
					roadCols(re.getAsJsonObject(), join);
				}
			}
		}
		if (!join.isEmpty()) {
			JsonObject ext = null, jd = null;
			if (ir.get("graph") instanceof JsonObject g && g.get("edges") instanceof JsonArray es) {
				for (JsonElement ee : es) {
					JsonObject e = ee.getAsJsonObject();
					if ("join_external".equals(str(e, "id"))) {
						ext = e;
					}
					if ("route_join".equals(str(e, "id"))) {
						jd = e;
					}
				}
			}
			String from = jd == null ? "" : str(jd, "from").split("\\.")[0];
			String district = null;
			for (String id : ids) {
				if (from.startsWith(id + "_")) {
					district = id;
					break;
				}
			}
			JsonObject extra = new JsonObject();
			if (district == null) {
				extra.add("district", com.google.gson.JsonNull.INSTANCE);
			} else {
				extra.addProperty("district", district);
			}
			String jk = ext == null ? null : ext.get("junction") instanceof JsonObject j ? str(j, "kind") : "end";
			if (jk == null) {
				extra.add("junction", com.google.gson.JsonNull.INSTANCE);
			} else {
				extra.addProperty("junction", jk);
			}
			push(out, claimed, town, "join", "join", join, extra);
		}
		// the routes between districts
		TreeMap<String, Cols> routes = new TreeMap<>();
		for (JsonElement pe : paths) {
			JsonObject p = pe.getAsJsonObject();
			Matcher m = ROUTE_PATH.matcher(str(p, "id"));
			if (m.matches() && p.get("box") instanceof JsonObject b) {
				boxCols(b, routes.computeIfAbsent(m.group(1), k -> new Cols()));
			}
		}
		for (JsonElement re : roads) {
			Matcher m = ROUTE_ROAD.matcher(str(re.getAsJsonObject(), "id"));
			if (m.matches()) {
				roadCols(re.getAsJsonObject(), routes.computeIfAbsent(m.group(1), k -> new Cols()));
			}
		}
		for (Map.Entry<String, Cols> e : routes.entrySet()) {
			push(out, claimed, town, "route", e.getKey(), e.getValue(), new JsonObject());
		}
		// an outpost's corridor, exactly architect_mc:corridor's runs
		List<Cols> corridors = new ArrayList<>();
		if (ir.get("corridor") instanceof JsonObject cor) {
			for (String id : new java.util.TreeSet<>(cor.keySet())) {
				JsonElement v = cor.get(id);
				JsonArray runs = v instanceof JsonArray a ? a : v instanceof JsonObject o && o.get("runs") instanceof JsonArray a2 ? a2 : new JsonArray();
				Cols c = BesideReach.colsOf(runs);
				if (c.isEmpty()) {
					continue;
				}
				corridors.add(c);
				out.add(part("corridor", id, c, town, new JsonObject()));
			}
		}
		// extra: written columns in no other part
		Cols extra = new Cols();
		written.forEach((x, z) -> {
			if (!claimed.has(x, z)) {
				extra.add(x, z);
			}
		});
		push(out, claimed, town, "extra", "written", extra, new JsonObject());
		// (6d GR §7) each revision's grown land, by rid
		for (Map.Entry<Integer, Cols> e : grown.entrySet()) {
			for (JsonObject b : grownBands.getOrDefault(e.getKey(), List.of())) {
				JsonObject bx = new JsonObject();
				bx.addProperty("shape", "mask");
				bx.addProperty("revision", e.getKey());
				push(out, claimed, town, "district", b.get("district").getAsString(), BesideReach.colsOf(b.getAsJsonArray("runs")), bx);
			}
			JsonObject gx = new JsonObject();
			java.util.TreeSet<String> dd = grownD.getOrDefault(e.getKey(), new java.util.TreeSet<>());
			if (dd.isEmpty()) {
				gx.add("district", com.google.gson.JsonNull.INSTANCE);
			} else {
				gx.addProperty("district", String.join(",", dd));
			}
			gx.addProperty("revision", e.getKey());
			push(out, claimed, town, "grown", "rv" + e.getKey(), e.getValue(), gx);
		}
		if (v2) {
			for (JsonObject p : out) {
				if (!p.has("revision")) {
					p.addProperty("revision", 0);
				}
			}
		}
		// union, outside, inside
		Cols union = new Cols();
		for (JsonObject p : out) {
			boolean cor = "corridor".equals(str(p, "kind"));
			BesideReach.colsOf(p.getAsJsonArray("runs")).forEach((x, z) -> {
				if (!(cor && in(town, x, z) && !written.has(x, z))) {
					union.add(x, z);
				}
			});
		}
		Cols outside = new Cols(), inside = new Cols();
		union.forEach((x, z) -> (in(town, x, z) ? inside : outside).add(x, z));
		JsonObject o = new JsonObject();
		o.addProperty("v", v2 ? V2 : V);
		if (ir.get("beside") instanceof JsonObject bs && bs.get("id") instanceof JsonElement bid && bid.isJsonPrimitive()) {
			o.addProperty("standing", bid.getAsString());
		} else {
			o.add("standing", com.google.gson.JsonNull.INSTANCE);
		}
		o.add("standingClaim", town == null ? com.google.gson.JsonNull.INSTANCE : BesideReach.arr(town));
		if (standingRemoved == null) {
			o.add("standingRemoved", com.google.gson.JsonNull.INSTANCE);
		} else {
			o.addProperty("standingRemoved", standingRemoved);
		}
		o.add("outside", rec(outside));
		o.add("inside", rec(inside));
		o.add("union", rec(union));
		JsonArray pa2 = new JsonArray();
		out.forEach(pa2::add);
		o.add("parts", pa2);
		return o;
	}

	private static void push(List<JsonObject> out, Cols claimed, int @Nullable [] town, String kind, String id, Cols keys, JsonObject extra) {
		if (keys.isEmpty()) {
			return;
		}
		keys.forEach(claimed::add);
		out.add(part(kind, id, keys, town, extra));
	}

	private static JsonObject part(String kind, String id, Cols keys, int @Nullable [] town, JsonObject extra) {
		JsonObject p = new JsonObject();
		p.addProperty("kind", kind);
		p.addProperty("id", id);
		extra.entrySet().forEach(e -> p.add(e.getKey(), e.getValue()));
		p.add("runs", keys.runs());
		int[] r = keys.rect();
		p.add("rect", BesideReach.arr(r));
		p.addProperty("cells", keys.size());
		int[] inside = {0};
		keys.forEach((x, z) -> {
			if (in(town, x, z)) {
				inside[0]++;
			}
		});
		p.addProperty("insideCells", inside[0]);
		return p;
	}

	private static JsonObject rec(Cols c) {
		JsonObject o = new JsonObject();
		o.add("runs", c.runs());
		int[] r = c.rect();
		o.add("rect", r == null ? com.google.gson.JsonNull.INSTANCE : BesideReach.arr(r));
		o.addProperty("cells", c.size());
		return o;
	}

	private static boolean in(int @Nullable [] t, int x, int z) {
		return t != null && x >= t[0] && x <= t[2] && z >= t[1] && z <= t[3];
	}

	private static void opsCols(JsonObject part, Cols into) {
		if (part.get("ops") instanceof JsonArray ops) {
			for (JsonElement oe : ops) {
				BesideReach.opCols(oe.getAsJsonObject(), into);
			}
		}
	}

	private static void boxCols(JsonObject b, Cols into) {
		into.addRect(b.get("minX").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxZ").getAsInt());
	}

	/** A road item's columns: its centre cells across its width plus 2 (its verge each side). */
	private static void roadCols(JsonObject rd, Cols into) {
		List<int[]> pts = new ArrayList<>();
		for (JsonElement pe : rd.getAsJsonArray("points")) {
			JsonArray p = pe.getAsJsonArray();
			pts.add(new int[] {p.get(0).getAsInt(), p.get(2).getAsInt()});
		}
		int w = (rd.has("width") ? rd.get("width").getAsInt() : 3) + 2;
		int lo = -((w - 1) / 2), hi = w / 2;
		// geom.mjs centreCells with each cell's segment, rightOf(segmentAxis(a, b))
		for (int s = 0; s + 1 < pts.size(); s++) {
			int[] a = pts.get(s), b = pts.get(s + 1);
			int dx = b[0] - a[0], dz = b[1] - a[1];
			int ax, az;
			if (Math.abs(dx) >= Math.abs(dz) && dx != 0) {
				ax = Integer.signum(dx);
				az = 0;
			} else if (dz != 0) {
				ax = 0;
				az = Integer.signum(dz);
			} else {
				ax = 1;
				az = 0;
			}
			int rx = -az, rz = ax; // rightOf
			List<int[]> seg = BesideReach.centreCells(List.of(a, b));
			for (int i = s == 0 ? 0 : 1; i < seg.size(); i++) {
				int[] c = seg.get(i);
				for (int k = lo; k <= hi; k++) {
					into.add(c[0] + rx * k, c[1] + rz * k);
				}
			}
		}
	}

	private static String str(JsonObject o, String k) {
		String v = BesideReach.str(o, k);
		return v == null ? "" : v;
	}
}
