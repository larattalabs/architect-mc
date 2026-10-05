package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * A placed design (was AgentCraft's {@code Building}, without repos, wings and home). Pure data, persisted by {@link Sites}
 * in {@code <world>/architect-sites.json}.
 *
 * @param blueprint the library id it was placed from
 * @param rotation lower-case Minecraft {@code Rotation} name ({@code none}, {@code clockwise_90}, ...)
 * @param box the world block box the template occupies (inclusive); its minimum corner is the origin
 * @param interior the design's interior region in world space (the whole box when it has none)
 * @param anchors world-space anchors, rotated
 * @param dimension the dimension it was placed in ({@code minecraft:overworld}, ...)
 * @param snapshotBox the box the snapshot covers when it is larger than {@code box} (foundation fill and the entrance
 *                    approach); null = {@code box}. See {@link #restoreBox()}.
 * @param snapshot the snapshot's file name in {@code <world>/architect-sites/} (the terrain before placement)
 * @param movedFrom where it stood before its last move ("undo move"), null when it never moved
 * @param pin what it was placed from (template fingerprint, own block entities), so a later change of the design under the
 *            same id never changes what this site is
 */
public record Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
	long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin) {
	public static final String OVERWORLD = "minecraft:overworld";

	/** A site's former place: its box's minimum corner, rotation and dimension. */
	public record Location(int x, int y, int z, String rotation, String dimension) {
	}

	/**
	 * The template a site was placed from, and what it holds outside its box.
	 *
	 * @param template {@code TemplateGrid.fingerprint} of the template
	 * @param blockEntities the template's own block entities as offsets from the box's minimum corner, three ints each
	 * @param heldLeaves leaves outside the snapshot box that the site made persistent while it stands (clearing logs inside
	 *                   the box would otherwise let them decay, and Remove could not bring them back): world x, y, z and
	 *                   the original {@code distance}, four ints each. {@code LeafGuard.release} gives them back on Remove/Move.
	 */
	public record Pin(String template, List<Integer> blockEntities, List<Integer> heldLeaves) {
		public Pin {
			blockEntities = List.copyOf(blockEntities);
			heldLeaves = List.copyOf(heldLeaves);
			if (blockEntities.size() % 3 != 0) {
				throw new IllegalArgumentException("blockEntities must hold x,y,z triples");
			}
			if (heldLeaves.size() % 4 != 0) {
				throw new IllegalArgumentException("heldLeaves must hold x,y,z,distance quadruples");
			}
		}

		public Pin(String template, List<Integer> blockEntities) {
			this(template, blockEntities, List.of());
		}

		public Pin withHeldLeaves(List<Integer> leaves) {
			return new Pin(template, blockEntities, leaves);
		}

		public Pin withoutBlockEntities(List<Integer> kept) {
			return new Pin(template, kept, heldLeaves);
		}

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("template", template);
			JsonArray be = new JsonArray();
			blockEntities.forEach(be::add);
			o.add("blockEntities", be);
			if (!heldLeaves.isEmpty()) {
				JsonArray hl = new JsonArray();
				heldLeaves.forEach(hl::add);
				o.add("heldLeaves", hl);
			}
			return o;
		}

		public static Pin fromJson(JsonObject o) {
			return new Pin(o.get("template").getAsString(), ints(o, "blockEntities"), ints(o, "heldLeaves"));
		}

		private static List<Integer> ints(JsonObject o, String key) {
			List<Integer> out = new ArrayList<>();
			if (o.has(key) && o.get(key).isJsonArray()) {
				for (JsonElement e : o.getAsJsonArray(key)) {
					out.add(e.getAsInt());
				}
			}
			return out;
		}
	}

	public Site {
		anchors = Collections.unmodifiableMap(new LinkedHashMap<>(anchors));
		if (snapshotBox != null && snapshotBox.equals(box)) {
			snapshotBox = null;
		}
	}

	/** The box {@link Sites#remove} restores: the snapshot's box (the template box plus foundation and approach). */
	public Anchors.Bounds restoreBox() {
		return snapshotBox != null ? snapshotBox : box;
	}

	/** This site's place (for a later "undo move"). */
	public Location location() {
		return new Location(box.minX(), box.minY(), box.minZ(), rotation, dimension);
	}

	// ------------------------------------------------------------------ JSON

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("blueprint", blueprint);
		JsonArray origin = new JsonArray();
		origin.add(box.minX());
		origin.add(box.minY());
		origin.add(box.minZ());
		o.add("origin", origin);
		o.addProperty("rotation", rotation);
		o.add("box", Anchors.boundsJson(box));
		o.add("interior", Anchors.boundsJson(interior));
		JsonObject a = new JsonObject();
		anchors.forEach((n, v) -> a.add(n, Anchors.anchorJson(v)));
		o.add("anchors", a);
		o.addProperty("placedAt", placedAt);
		o.addProperty("dimension", dimension);
		if (snapshotBox != null) {
			o.add("snapshotBox", Anchors.boundsJson(snapshotBox));
		}
		o.addProperty("snapshot", snapshot);
		if (movedFrom != null) {
			JsonObject m = new JsonObject();
			m.addProperty("x", movedFrom.x());
			m.addProperty("y", movedFrom.y());
			m.addProperty("z", movedFrom.z());
			m.addProperty("rotation", movedFrom.rotation());
			m.addProperty("dimension", movedFrom.dimension());
			o.add("movedFrom", m);
		}
		if (pin != null) {
			o.add("pin", pin.toJson());
		}
		return o;
	}

	public static Site fromJson(JsonObject o) {
		Map<String, Anchor> anchors = new LinkedHashMap<>();
		if (o.has("anchors")) {
			for (var e : o.getAsJsonObject("anchors").entrySet()) {
				JsonObject a = e.getValue().getAsJsonObject();
				anchors.put(e.getKey(), new Anchor(e.getKey(), a.get("x").getAsDouble(), a.get("y").getAsDouble(), a.get("z").getAsDouble(),
					a.has("yaw") ? a.get("yaw").getAsFloat() : 0f, a.has("pitch") ? a.get("pitch").getAsFloat() : 0f));
			}
		}
		Anchors.Bounds box = Anchors.boundsFromJson(o.getAsJsonObject("box"));
		Location moved = null;
		if (o.has("movedFrom") && o.get("movedFrom").isJsonObject()) {
			JsonObject m = o.getAsJsonObject("movedFrom");
			moved = new Location(m.get("x").getAsInt(), m.get("y").getAsInt(), m.get("z").getAsInt(),
				m.has("rotation") ? m.get("rotation").getAsString() : "none", m.has("dimension") ? m.get("dimension").getAsString() : OVERWORLD);
		}
		String id = o.get("id").getAsString();
		return new Site(id, o.get("blueprint").getAsString(), o.has("rotation") ? o.get("rotation").getAsString() : "none", box,
			o.has("interior") ? Anchors.boundsFromJson(o.getAsJsonObject("interior")) : box, anchors,
			o.has("placedAt") ? o.get("placedAt").getAsLong() : 0L, o.has("dimension") ? o.get("dimension").getAsString() : OVERWORLD,
			o.has("snapshotBox") ? Anchors.boundsFromJson(o.getAsJsonObject("snapshotBox")) : null,
			o.has("snapshot") ? o.get("snapshot").getAsString() : id + ".nbt", moved,
			o.has("pin") && o.get("pin").isJsonObject() ? Pin.fromJson(o.getAsJsonObject("pin")) : null);
	}

	/**
	 * A site taken down (removed, or moved away): its snapshot is kept until the next world start finds the restored terrain
	 * on disk ({@code Reconcile.decide}), because a save does not promise to write the restored chunks.
	 *
	 * @param site the record as it was before (its box, design, dimension and snapshot file)
	 * @param at when it was taken down (ms)
	 * @param why {@code removed} or {@code moved}
	 */
	public record Pending(Site site, long at, String why) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.add("site", site.toJson());
			o.addProperty("at", at);
			o.addProperty("why", why);
			return o;
		}

		public static Pending fromJson(JsonObject o) {
			return new Pending(Site.fromJson(o.getAsJsonObject("site")), o.has("at") ? o.get("at").getAsLong() : 0L,
				o.has("why") ? o.get("why").getAsString() : "removed");
		}
	}

	/** The sites file: {@code {"version":1, "next": 4, "sites": [...], "pending": [...]}}; {@code next} never goes back. */
	public static JsonObject fileJson(List<Site> sites, int next, List<Pending> pending) {
		JsonObject root = new JsonObject();
		root.addProperty("version", 1);
		root.addProperty("next", next);
		JsonArray arr = new JsonArray();
		sites.forEach(b -> arr.add(b.toJson()));
		root.add("sites", arr);
		if (!pending.isEmpty()) {
			JsonArray p = new JsonArray();
			pending.forEach(x -> p.add(x.toJson()));
			root.add("pending", p);
		}
		return root;
	}

	/** Parsed sites file. */
	public record FileData(List<Site> sites, int next, List<Pending> pending) {
		public FileData {
			sites = List.copyOf(sites);
			pending = List.copyOf(pending);
		}
	}

	public static FileData fileFromJson(JsonObject root) {
		List<Site> list = new ArrayList<>();
		int maxId = 0;
		for (JsonElement e : root.has("sites") ? root.getAsJsonArray("sites") : new JsonArray()) {
			Site b = fromJson(e.getAsJsonObject());
			list.add(b);
			maxId = Math.max(maxId, idNumber(b.id()));
		}
		List<Pending> pending = new ArrayList<>();
		for (JsonElement e : root.has("pending") ? root.getAsJsonArray("pending") : new JsonArray()) {
			Pending p = Pending.fromJson(e.getAsJsonObject());
			pending.add(p);
			maxId = Math.max(maxId, idNumber(p.site().id()));
		}
		int next = root.has("next") ? root.get("next").getAsInt() : 1;
		return new FileData(list, Math.max(next, maxId + 1), pending);
	}

	/** {@code s12 -> 12}; 0 for other ids. */
	public static int idNumber(@Nullable String id) {
		if (id == null || id.length() < 2 || id.charAt(0) != 's') {
			return 0;
		}
		try {
			return Integer.parseInt(id.substring(1));
		} catch (NumberFormatException e) {
			return 0;
		}
	}
}
