package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.region.Heights;
import dev.larattalabs.architect.region.Ir;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.TreeSet;
import org.jspecify.annotations.Nullable;

/**
 * (6c close-out A, §8) What a region's tile and road items carry so a caller can match and say their waits, as targets do (S-RS-1):
 * {@code architect_mc:region}, {@code architect_mc:part} (a road's part, its road id as {@code RegionView.build.parts} names it; a tile's
 * when one plan part writes it) and {@code architect_mc:parts} (a tile's plan parts, sorted, at most 16: the IR parts whose ops' bounds
 * meet the tile's columns, in the tile's stage and set, under their survival target group; a creative IR's own part ids). And the stage
 * waits' sayable sentence ({@code architect_mc:waitsFor.waiter}, {@code .say}) from the plan parts' labels.
 */
public final class RegionWaitTags {
	public static final String EXT_PARTS = "architect_mc:parts";
	/** At most this many parts are named on a tile. */
	public static final int MAX_PARTS = 16;

	private RegionWaitTags() {
	}

	/** Tags a tile item's ext (idempotent). */
	public static void tagTile(JsonObject ext, String region, Ir ir, String stage, String set, String tileKey) {
		ext.addProperty(RegionItems.EXT_REGION, region);
		List<String> parts = tileParts(ir, stage, set, tileKey);
		JsonArray a = new JsonArray();
		parts.forEach(a::add);
		ext.add(EXT_PARTS, a);
		if (parts.size() == 1) {
			ext.addProperty(RegionTargets.EXT_PART, parts.get(0));
		}
	}

	/** Tags a road item's ext (idempotent): its region and its road id. */
	public static void tagRoad(JsonObject ext, String region, String roadId) {
		ext.addProperty(RegionItems.EXT_REGION, region);
		ext.addProperty(RegionTargets.EXT_PART, roadId);
	}

	/**
	 * The ext an event shows for a region batch's tile or road item: its own, with the tags filled in when a queue saved before close-out
	 * A lacks them (computed, never written back). Null when the item is not one, or already tagged.
	 */
	public static @Nullable JsonObject backfill(QBatch b, QItem i) {
		String region = RegionItems.regionOf(b);
		if (region == null || i.ext.has(RegionTargets.EXT_PART) || i.ext.has(EXT_PARTS)) {
			return null;
		}
		JsonObject ext = i.ext.deepCopy();
		if ("road".equals(i.itemKind) && i.key.startsWith("road:")) {
			tagRoad(ext, region, i.key.substring("road:".length()));
			return ext;
		}
		RegionsImpl.Live l = RegionsImpl.live(region);
		if (l != null && "tile".equals(i.itemKind) && i.spec != null && i.spec.has("tile") && i.spec.has("set")) {
			tagTile(ext, region, l.ir(), i.stage, i.spec.get("set").getAsString(), i.spec.get("tile").getAsString());
			return ext;
		}
		return null;
	}

	/** An IR part's tile index entry: its stage, set, plan part and its ops' x/z bounds. */
	private record PartBounds(String stage, String set, String part, int[][] boxes) {
	}

	/** Per IR instance (its id and identity: a record's equals would compare the whole JSON), its parts' bounds; the last 8. */
	private static final java.util.Map<String, List<PartBounds>> INDEX = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<>(16, 0.75f, true) {
		@Override
		protected boolean removeEldestEntry(java.util.Map.Entry<String, List<PartBounds>> e) {
			return size() > 8;
		}
	});

	private static List<PartBounds> index(Ir ir) {
		return INDEX.computeIfAbsent(ir.id() + "|" + System.identityHashCode(ir), k -> indexOf(ir));
	}

	private static List<PartBounds> indexOf(Ir ir) {
		JsonObject j = ir.json();
		JsonObject sv = j.get("survival") instanceof JsonObject o ? o : null;
		JsonObject svParts = sv != null && sv.get("parts") instanceof JsonObject o ? o : null;
		List<String> groups = dev.larattalabs.architect.region.RegionSurvival.groups(j);
		List<PartBounds> out = new ArrayList<>();
		if (j.get("parts") instanceof JsonArray parts) {
			for (JsonElement pe : parts) {
				if (!(pe instanceof JsonObject p) || !p.has("id") || !(p.get("ops") instanceof JsonArray ops)) {
					continue;
				}
				List<int[]> boxes = new ArrayList<>();
				for (JsonElement oe : ops) {
					if (oe instanceof JsonObject op && op.get("bounds") instanceof JsonObject bd && bd.has("minX") && bd.has("maxX") && bd.has("minZ") && bd.has("maxZ")) {
						boxes.add(new int[] {bd.get("minX").getAsInt(), bd.get("minZ").getAsInt(), bd.get("maxX").getAsInt(), bd.get("maxZ").getAsInt()});
					}
				}
				String id = p.get("id").getAsString();
				String part = id;
				if (svParts != null && svParts.has(id)) {
					int g = svParts.get(id).getAsInt();
					part = g >= 0 && g < groups.size() ? groups.get(g) : id;
				}
				out.add(new PartBounds(String.valueOf(str(p, "stage")), str(p, "set") == null ? "terrain" : str(p, "set"), part, boxes.toArray(int[][]::new)));
			}
		}
		return out;
	}

	/** A tile's plan parts (see the class doc). */
	public static List<String> tileParts(Ir ir, String stage, String set, String tileKey) {
		int[] t = Ir.tile(tileKey);
		int T = Heights.TILE, x0 = T * t[0], z0 = T * t[1], x1 = x0 + T - 1, z1 = z0 + T - 1;
		TreeSet<String> out = new TreeSet<>();
		for (PartBounds pb : index(ir)) {
			if (!stage.equals(pb.stage()) || !set.equals(pb.set())) {
				continue;
			}
			for (int[] b : pb.boxes()) {
				if (b[0] <= x1 && b[2] >= x0 && b[1] <= z1 && b[3] >= z0) {
					out.add(pb.part());
					break;
				}
			}
		}
		List<String> list = new ArrayList<>(out);
		return list.size() > MAX_PARTS ? list.subList(0, MAX_PARTS) : list;
	}

	// ------------------------------------------------------------------ the sayable sentence

	/**
	 * A part's words: its plan label (the artifact's plan, any object with that {@code id} and a {@code label}), else the id with
	 * {@code _} as spaces. {@code lot <id>} and {@code road <id>} read their id's label likewise.
	 */
	public static String words(RegionsImpl.@Nullable Live l, @Nullable String part) {
		if (part == null || part.isBlank()) {
			return "an earlier part";
		}
		String id = part.startsWith("lot ") || part.startsWith("road ") ? part.substring(part.indexOf(' ') + 1) : part;
		JsonObject plan = l == null ? null : planOf(l);
		String label = plan == null ? null : labelOf(plan, id, 0);
		if (label == null && l != null) {
			label = roadWords(l, plan, id);
		}
		return label != null ? label : id.replace('_', ' ');
	}

	/**
	 * A region road's words: a zone's (or a district's) street road ({@code architect_mc:street {zone, district?}}) is "<its label>'s
	 * street"; a route road ({@code route_c<n>l<k>[_<i>]}) is its connector's label, found by the leg's edge in the artifact's answers.
	 * Null when the id is no road of the region.
	 */
	static @Nullable String roadWords(RegionsImpl.Live l, @Nullable JsonObject plan, String id) {
		for (Ir.Road r : l.ir().roads()) {
			if (!r.id().equals(id)) {
				continue;
			}
			if (r.ext() != null && r.ext().get("architect_mc:street") instanceof JsonObject st) {
				String owner = st.get("district") instanceof JsonElement d && d.isJsonPrimitive() ? d.getAsString()
					: st.get("zone") instanceof JsonElement z && z.isJsonPrimitive() ? z.getAsString() : null;
				String ol = owner == null || plan == null ? null : labelOf(plan, owner, 0);
				return (ol != null ? ol : owner != null ? owner.replace('_', ' ') : "the town") + "'s street";
			}
			java.util.regex.Matcher m = java.util.regex.Pattern.compile("^route_(c\\d+l\\d+)(_\\d+)?$").matcher(id);
			JsonObject body = artifactBody(l);
			if (m.matches() && body != null && body.get("parts") instanceof JsonArray parts) {
				for (JsonElement pe : parts) {
					if (pe instanceof JsonObject p && p.get("geometry") instanceof JsonObject g && g.get("legs") instanceof JsonArray legs) {
						for (JsonElement le : legs) {
							if (le instanceof JsonObject leg && m.group(1).equals(str(leg, "edge")) && str(p, "part") != null) {
								String pl = plan == null ? null : labelOf(plan, str(p, "part"), 0);
								return pl != null ? pl : str(p, "part").replace('_', ' ');
							}
						}
					}
				}
			}
			return null;
		}
		return null;
	}

	/** The sentence a stage wait says: {@code "<waiter> waits for <part> to be built"}. */
	public static String say(RegionsImpl.@Nullable Live l, @Nullable String waiter, @Nullable String part) {
		String w = waiter == null ? "this part" : words(l, waiter);
		return capital(w) + " waits for " + words(l, part) + " to be built";
	}

	/** The waiting item's part: its {@code architect_mc:part}, else its first {@code parts}, else its lot ({@code lot <id>}), road, or null. */
	public static @Nullable String waiterOf(QBatch b, QItem i) {
		JsonObject ext = i.ext;
		JsonObject filled = backfill(b, i);
		if (filled != null) {
			ext = filled;
		}
		if (ext.get(RegionTargets.EXT_PART) instanceof JsonElement e && e.isJsonPrimitive()) {
			return e.getAsString();
		}
		if (ext.get(EXT_PARTS) instanceof JsonArray a && !a.isEmpty()) {
			return a.get(0).getAsString();
		}
		if (ext.get("architect_mc:lot") instanceof JsonElement e && e.isJsonPrimitive()) {
			return "lot " + e.getAsString();
		}
		return null;
	}

	private static String capital(String s) {
		return s.isEmpty() ? s : s.substring(0, 1).toUpperCase(Locale.ROOT) + s.substring(1);
	}

	private static @Nullable JsonObject planOf(RegionsImpl.Live l) {
		JsonObject b = artifactBody(l);
		return b != null && b.get("plan") instanceof JsonObject p ? p : null;
	}

	private static @Nullable JsonObject artifactBody(RegionsImpl.Live l) {
		String sha = l.rec().ext != null && l.rec().ext.get(dev.larattalabs.architect.region.PlanChecks.EXT_ARTIFACT) instanceof JsonElement e && e.isJsonPrimitive()
			? e.getAsString() : null;
		if (sha == null) {
			return null;
		}
		var a = RegionsImpl.INSTANCE.artifact(sha);
		return a.isPresent() ? a.get().body() : null;
	}

	private static @Nullable String labelOf(JsonElement e, String id, int depth) {
		if (depth > 12) {
			return null;
		}
		if (e instanceof JsonObject o) {
			if (o.get("id") instanceof JsonElement i && i.isJsonPrimitive() && id.equals(i.getAsString()) && o.get("label") instanceof JsonElement lb && lb
				.isJsonPrimitive() && !lb.getAsString().isBlank()) {
				return lb.getAsString();
			}
			for (var en : o.entrySet()) {
				String r = labelOf(en.getValue(), id, depth + 1);
				if (r != null) {
					return r;
				}
			}
		} else if (e instanceof JsonArray a) {
			for (JsonElement x : a) {
				String r = labelOf(x, id, depth + 1);
				if (r != null) {
					return r;
				}
			}
		}
		return null;
	}

	private static @Nullable String str(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() ? e.getAsString() : null;
	}
}
