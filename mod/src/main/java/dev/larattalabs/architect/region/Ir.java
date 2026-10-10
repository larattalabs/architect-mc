package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * What the mod reads of a Region IR (kit/REGIONS.md "The Region IR"): the claim, the stages, the tiles each change-set touches,
 * the lots, the ground roads, the anchors and the budget. The ops are the kit's business (the sidecar evaluates them).
 */
public record Ir(JsonObject json, String id, String kitVersion, String seed, int[] claim, List<String> stages, Map<String, List<String>> terrainTiles,
	Map<String, List<String>> pathTiles, List<Lot> lots, List<Road> roads, Map<String, int[]> anchors, long[] budget, int format, List<String> requires,
	List<BlobRef> blobs) {

	/** (6b) A format-2 side blob the IR names ({@code blobs: {name: {sha, bytes, kind}}}). */
	public record BlobRef(String name, String sha, long bytes, String kind) {
	}

	/** A lot: box {minX, minY, minZ, maxX, maxY, maxZ}; floorY the first cell above the pad. */
	public record Lot(String id, String stage, @Nullable String part, int[] box, int floorY, String front, @Nullable String brief, int[] max) {
	}

	/** A ground road: 4e RoadRequest points. */
	public record Road(String id, String stage, List<int[]> points, int width, @Nullable String surface, boolean lanterns) {
	}

	/**
	 * Reads an IR of any format (6b: format 1 or 2; a newer one is read as far as it goes, so a stale region still loads and can
	 * be removed; {@link IrStale} decides whether it may be evaluated).
	 */
	public static Ir of(JsonObject o) {
		if (!o.has("format") || !o.get("format").isJsonPrimitive() || o.get("format").getAsInt() < 1) {
			throw new IllegalArgumentException("not a Region IR");
		}
		JsonObject c = o.getAsJsonObject("claim");
		int[] claim = {c.get("minX").getAsInt(), c.get("minY").getAsInt(), c.get("minZ").getAsInt(), c.get("maxX").getAsInt(), c.get("maxY").getAsInt(),
			c.get("maxZ").getAsInt()};
		List<String> stages = strings(o.getAsJsonArray("stages"));
		Map<String, List<String>> terrain = new LinkedHashMap<>();
		Map<String, List<String>> path = new LinkedHashMap<>();
		JsonObject tiles = o.has("tiles") ? o.getAsJsonObject("tiles") : new JsonObject();
		for (String st : stages) {
			JsonObject t = tiles.has(st) ? tiles.getAsJsonObject(st) : new JsonObject();
			terrain.put(st, t.has("terrain") ? strings(t.getAsJsonArray("terrain")) : List.of());
			path.put(st, t.has("path") ? strings(t.getAsJsonArray("path")) : List.of());
		}
		List<Lot> lots = new ArrayList<>();
		if (o.has("lots")) {
			for (JsonElement e : o.getAsJsonArray("lots")) {
				JsonObject l = e.getAsJsonObject();
				JsonObject b = l.getAsJsonObject("box");
				lots.add(new Lot(l.get("id").getAsString(), l.get("stage").getAsString(), str(l, "part"), new int[] {b.get("minX").getAsInt(), b.get("minY")
					.getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get("maxY").getAsInt(), b.get("maxZ").getAsInt()}, l.get("floorY")
						.getAsInt(), l.has("front") ? l.get("front").getAsString() : "south", str(l, "brief"), ints(l.getAsJsonArray("max"))));
			}
		}
		List<Road> roads = new ArrayList<>();
		if (o.has("roads")) {
			for (JsonElement e : o.getAsJsonArray("roads")) {
				JsonObject r = e.getAsJsonObject();
				List<int[]> pts = new ArrayList<>();
				r.getAsJsonArray("points").forEach(p -> pts.add(ints(p.getAsJsonArray())));
				roads.add(new Road(r.get("id").getAsString(), r.get("stage").getAsString(), pts, r.has("width") ? r.get("width").getAsInt() : 3, str(r,
					"surface"), !r.has("lanterns") || r.get("lanterns").getAsBoolean()));
			}
		}
		Map<String, int[]> anchors = new LinkedHashMap<>();
		if (o.has("anchors")) {
			o.getAsJsonObject("anchors").entrySet().forEach(e -> anchors.put(e.getKey(), ints(e.getValue().getAsJsonArray())));
		}
		JsonObject bu = o.has("budget") ? o.getAsJsonObject("budget") : new JsonObject();
		long[] budget = {num(bu, "cells"), num(bu, "removed"), num(bu, "added")};
		List<String> requires = o.has("requires") && o.get("requires").isJsonArray() ? strings(o.getAsJsonArray("requires")) : List.of();
		List<BlobRef> blobs = new ArrayList<>();
		if (o.has("blobs") && o.get("blobs").isJsonObject()) {
			for (Map.Entry<String, JsonElement> e : o.getAsJsonObject("blobs").entrySet()) {
				if (e.getValue() instanceof JsonObject b && b.has("sha") && !b.has("data")) {
					blobs.add(new BlobRef(e.getKey(), b.get("sha").getAsString(), b.has("bytes") ? b.get("bytes").getAsLong() : -1, b.has("kind") ? b.get(
						"kind").getAsString() : ""));
				}
			}
		}
		return new Ir(o, o.get("id").getAsString(), o.has("kitVersion") ? o.get("kitVersion").getAsString() : "", o.has("seed") ? o.get("seed")
			.getAsString() : "0", claim, stages, terrain, path, lots, roads, anchors, budget, o.get("format").getAsInt(), List.copyOf(requires), List.copyOf(
				blobs));
	}

	/**
	 * A region's IR at world load: {@link #of}, or, when it can't be read (an IR far newer than this mod), a placeholder with the
	 * region's claim and no tiles, lots or roads, so the record still loads (and is refused PLAN_STALE, and can be removed: undo
	 * reads the journal only).
	 */
	public static Ir lenient(JsonObject o, int[] claim) {
		try {
			return of(o);
		} catch (RuntimeException e) {
			int f = o.has("format") && o.get("format").isJsonPrimitive() ? o.get("format").getAsInt() : 0;
			return new Ir(o, o.has("id") && o.get("id").isJsonPrimitive() ? o.get("id").getAsString() : "?", o.has("kitVersion") && o.get("kitVersion")
				.isJsonPrimitive() ? o.get("kitVersion").getAsString() : "", "0", claim.clone(), List.of(), Map.of(), Map.of(), List.of(), List.of(), Map.of(),
				new long[3], f, List.of(), List.of());
		}
	}

	/** (6b) The IR's side blobs' shas, in IR order, unique. */
	public List<String> blobShas() {
		return blobs.stream().map(BlobRef::sha).distinct().toList();
	}

	/** Every tile entry of the IR, as (stage, set, key), stage by stage, terrain before path. */
	public List<String[]> tileItems() {
		List<String[]> out = new ArrayList<>();
		for (String st : stages) {
			terrainTiles.getOrDefault(st, List.of()).forEach(k -> out.add(new String[] {st, "terrain", k}));
			pathTiles.getOrDefault(st, List.of()).forEach(k -> out.add(new String[] {st, "path", k}));
		}
		return out;
	}

	public static int[] tile(String key) {
		String[] p = key.split(",");
		return new int[] {Integer.parseInt(p[0].trim()), Integer.parseInt(p[1].trim())};
	}

	private static long num(JsonObject o, String k) {
		return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsLong() : 0L;
	}

	private static @Nullable String str(JsonObject o, String k) {
		return o.has(k) && !o.get(k).isJsonNull() ? o.get(k).getAsString() : null;
	}

	private static List<String> strings(@Nullable JsonArray a) {
		List<String> out = new ArrayList<>();
		if (a != null) {
			a.forEach(e -> out.add(e.getAsString()));
		}
		return out;
	}

	static int[] ints(JsonArray a) {
		int[] out = new int[a.size()];
		for (int i = 0; i < out.length; i++) {
			out[i] = a.get(i).getAsInt();
		}
		return out;
	}
}
