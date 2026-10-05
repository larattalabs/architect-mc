package dev.larattalabs.architect.placement;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * A library design's sidecar ({@code <id>.blueprint.json}, docs/CONTRACT.md "Sidecar"). Pure data: no Minecraft types, so
 * it is parsed and tested without a game. The structure template that goes with it is held by {@link Blueprints}.
 *
 * <p>All coordinates are template-local (origin = the template's minimum corner), unrotated. {@code size}, {@code groundY},
 * {@code front}, {@code foundationBlock} and {@code approach} keep their AgentCraft meaning (docs/BUILDINGS.md in AgentCraft).
 *
 * @param type the building type ({@link #TYPES}); unknown types read as {@code custom}
 * @param front the direction the entrance faces in the unrotated template ({@code north/east/south/west})
 * @param interior the interior region (template-local, inclusive); null when absent
 * @param foundationBlock the vanilla block the placement fills below the floor with ({@link #DEFAULT_FOUNDATION} when absent)
 * @param approach the entrance approach placement builds in front of the door ({@link Approach.Spec#DEFAULT} when absent)
 * @param source the parametric source file name ({@code <id>.mjs}), or empty
 * @param createdAt when the design was made (ms), 0 for bundled ones
 * @param request the DesignRequest it was made from, or null (bundled)
 */
public record Blueprint(String id, String name, String description, String type, List<String> tags, int sizeX, int sizeY, int sizeZ,
	int groundY, String front, List<String> materials, Anchors.@Nullable Bounds interior, Map<String, Anchor> anchors, String foundationBlock,
	Approach.Spec approach, String source, long createdAt, @Nullable JsonObject request) {

	public static final Pattern ID = Pattern.compile("[a-z0-9_]+");
	/** The building types (docs/CONTRACT.md "Building types"). */
	public static final List<String> TYPES = List.of("house", "cabin", "cottage", "tower", "shop", "tavern", "barn", "smithy", "chapel",
		"gatehouse", "custom");
	public static final String ENTRANCE = "entrance";
	public static final String SPAWN = "spawn";
	public static final String CAM_PREFIX = "cam_";
	/** How far outside the template a non-camera anchor may lie (the approach strip). */
	public static final int OUTSIDE_SLACK = 16;
	/** What fills below a building's floor when the sidecar names no {@code foundationBlock}. */
	public static final String DEFAULT_FOUNDATION = "minecraft:stone_bricks";
	private static final Pattern BLOCK_ID = Pattern.compile("[a-z0-9_.\\-]+:[a-z0-9_./\\-]+");

	public Blueprint {
		tags = List.copyOf(tags);
		materials = List.copyOf(materials);
		anchors = Collections.unmodifiableMap(new LinkedHashMap<>(anchors));
	}

	/** Whether {@code id} looks like a namespaced block id ({@code minecraft:stone_bricks}). */
	public static boolean isBlockId(@Nullable String id) {
		return id != null && BLOCK_ID.matcher(id).matches();
	}

	/** Parses a sidecar. Throws {@link IllegalArgumentException} with a readable message when it is unusable. */
	public static Blueprint fromJson(JsonObject o) {
		String id = str(o, "id", null);
		if (id == null || !ID.matcher(id).matches()) {
			throw new IllegalArgumentException("missing or invalid \"id\" (expected [a-z0-9_]+): " + id);
		}
		if (!o.has("size") || !o.get("size").isJsonObject()) {
			throw new IllegalArgumentException("missing \"size\"");
		}
		JsonObject size = o.getAsJsonObject("size");
		int sx = size.get("x").getAsInt();
		int sy = size.get("y").getAsInt();
		int sz = size.get("z").getAsInt();
		if (sx < 1 || sy < 1 || sz < 1) {
			throw new IllegalArgumentException("bad \"size\" " + sx + "x" + sy + "x" + sz);
		}
		int groundY = o.has("groundY") ? o.get("groundY").getAsInt() : 0;
		if (groundY < 0 || groundY >= sy) {
			throw new IllegalArgumentException("\"groundY\" " + groundY + " is outside the template (0.." + (sy - 1) + ")");
		}
		String front = str(o, "front", "south").toLowerCase(Locale.ROOT);
		if (BlueprintTransform.directionIndex(front) < 0) {
			throw new IllegalArgumentException("\"front\" must be north/east/south/west, not " + front);
		}
		String type = str(o, "type", "custom").toLowerCase(Locale.ROOT);
		if (!TYPES.contains(type)) {
			type = "custom";
		}
		Anchors.Bounds interior = null;
		if (o.has("interior") && o.get("interior").isJsonObject()) {
			JsonObject w = o.getAsJsonObject("interior");
			interior = new Anchors.Bounds(w.get("minX").getAsInt(), w.get("minY").getAsInt(), w.get("minZ").getAsInt(),
				w.get("maxX").getAsInt(), w.get("maxY").getAsInt(), w.get("maxZ").getAsInt());
		}
		Map<String, Anchor> anchors = new LinkedHashMap<>();
		if (o.has("anchors") && o.get("anchors").isJsonObject()) {
			for (var e : o.getAsJsonObject("anchors").entrySet()) {
				JsonObject a = e.getValue().getAsJsonObject();
				anchors.put(e.getKey(), new Anchor(e.getKey(), a.get("x").getAsDouble(), a.get("y").getAsDouble(), a.get("z").getAsDouble(),
					a.has("yaw") ? a.get("yaw").getAsFloat() : 0f, a.has("pitch") ? a.get("pitch").getAsFloat() : 0f));
			}
		}
		String foundation = str(o, "foundationBlock", DEFAULT_FOUNDATION).strip().toLowerCase(Locale.ROOT);
		if (!foundation.isEmpty() && foundation.indexOf(':') < 0) {
			foundation = "minecraft:" + foundation;
		}
		return new Blueprint(id, str(o, "name", id), str(o, "description", ""), type, strings(o.get("tags")), sx, sy, sz, groundY, front,
			strings(o.get("materials")), interior, anchors, foundation.isEmpty() ? DEFAULT_FOUNDATION : foundation,
			Approach.Spec.fromJson(o.get("approach")), str(o, "source", ""), o.has("createdAt") ? o.get("createdAt").getAsLong() : 0L,
			o.has("request") && o.get("request").isJsonObject() ? o.getAsJsonObject("request") : null);
	}

	/** A string list from a JSON array (non-strings skipped), a single string, or nothing. */
	private static List<String> strings(@Nullable JsonElement e) {
		List<String> out = new ArrayList<>();
		if (e == null || e.isJsonNull()) {
			return out;
		}
		if (e.isJsonArray()) {
			for (JsonElement x : e.getAsJsonArray()) {
				if (x.isJsonPrimitive() && x.getAsJsonPrimitive().isString()) {
					out.add(x.getAsString());
				}
			}
		} else if (e.isJsonPrimitive()) {
			out.add(e.getAsString()); // an AgentCraft sidecar's "materials": "vanilla"
		}
		return out;
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("name", name);
		o.addProperty("description", description);
		o.addProperty("type", type);
		JsonArray t = new JsonArray();
		tags.forEach(t::add);
		o.add("tags", t);
		JsonObject size = new JsonObject();
		size.addProperty("x", sizeX);
		size.addProperty("y", sizeY);
		size.addProperty("z", sizeZ);
		o.add("size", size);
		o.addProperty("groundY", groundY);
		o.addProperty("front", front);
		JsonArray m = new JsonArray();
		materials.forEach(m::add);
		o.add("materials", m);
		o.addProperty("foundationBlock", foundationBlock);
		o.add("approach", approach.toJson());
		if (interior != null) {
			o.add("interior", Anchors.boundsJson(interior));
		}
		JsonObject a = new JsonObject();
		anchors.forEach((n, v) -> a.add(n, Anchors.anchorJson(v)));
		o.add("anchors", a);
		if (!source.isEmpty()) {
			o.addProperty("source", source);
		}
		if (createdAt > 0) {
			o.addProperty("createdAt", createdAt);
		}
		if (request != null) {
			o.add("request", request);
		}
		return o;
	}

	/**
	 * Non-fatal problems worth a log line: required anchors missing, anchors outside the template, an interior box
	 * outside the template, block ids that are not ids. Empty when the sidecar looks complete.
	 */
	public List<String> warnings() {
		List<String> w = new ArrayList<>();
		for (String req : List.of(ENTRANCE, SPAWN)) {
			if (!anchors.containsKey(req)) {
				w.add("missing anchor " + req);
			}
		}
		for (Anchor a : anchors.values()) {
			// cameras may stand anywhere; entrance, spawn and the rest may sit on the approach strip, up to 16 cells out
			int m = OUTSIDE_SLACK;
			if (!a.name().startsWith(CAM_PREFIX) && (a.x() < -m || a.y() < -m || a.z() < -m || a.x() > sizeX + m || a.y() > sizeY + m
				|| a.z() > sizeZ + m)) {
				w.add("anchor " + a.name() + " lies more than " + m + " cells outside the template");
			}
		}
		if (interior != null && (interior.minX() < 0 || interior.minY() < 0 || interior.minZ() < 0 || interior.maxX() >= sizeX
			|| interior.maxY() >= sizeY || interior.maxZ() >= sizeZ)) {
			w.add("interior box exceeds the template");
		}
		if (approach.enabled() && (!isBlockId(approach.block()) || !isBlockId(approach.slab()))) {
			w.add("approach block/slab is not a block id (" + Approach.DEFAULT_BLOCK + " / " + Approach.DEFAULT_SLAB + " are used)");
		}
		if (!isBlockId(foundationBlock)) {
			w.add("foundationBlock '" + foundationBlock + "' is not a block id (" + DEFAULT_FOUNDATION + " is used)");
		}
		return w;
	}

	private static String str(JsonObject o, String key, @Nullable String def) {
		return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : def;
	}
}
