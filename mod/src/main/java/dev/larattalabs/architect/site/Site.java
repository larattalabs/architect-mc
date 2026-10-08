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
 * @param construction a survival construction site's queue, crate and free cells ({@link Construction}); null for a site
 *                     placed instantly
 * @param owner who owns it (docs/CONTRACT.md phase 4a, R5): a free string, by convention {@code <modid>:<thing>}; null = the
 *              player's own site. A guardrail, not security: the UI asks twice before removing an owned site, and the API
 *              refuses a remove from another requester without force. (Not {@link Construction#owner()}, the placing player.)
 * @param ext namespaced extra data ({@code "steward_mc:lot": "L3"}); never interpreted by Architect, never null
 * @param member (phase 4d) the site group, batch and item key it was placed for, or null
 * @param placing (phase 4d) an instant placement whose cells are still being written over ticks ({@code PlaceJob}); its
 *                snapshot was written first, so Remove (a cancel) restores it exactly
 */
public record Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
	long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin,
	@Nullable Construction construction, @Nullable String owner, JsonObject ext, @Nullable Member member, boolean placing, Versioning versioning) {
	public static final String OVERWORLD = "minecraft:overworld";

	/** Phase 4d shape: no versions (phase 5b derives the version from the pin when it is needed). */
	public Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
		long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin,
		@Nullable Construction construction, @Nullable String owner, JsonObject ext, @Nullable Member member, boolean placing) {
		this(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner, ext, member,
			placing, Versioning.NONE);
	}

	/**
	 * What a site stands at (docs/CONTRACT.md phase 5b "What a site stands at"): the library entry's {@code version} (0 =
	 * not known yet: a pre-5b record, derived once from the pin's template fingerprint), its {@code history} (placed, then
	 * every delta, revert and forward delta, oldest first), and a delta in progress ({@code updating}: the version it goes to,
	 * {@code reverting}: a revert's target), or 0.
	 */
	public record Versioning(int version, List<History> history, int updating, int reverting, int deviations) {
		public static final Versioning NONE = new Versioning(0, List.of(), 0, 0, 0);

		public Versioning {
			history = List.copyOf(history);
		}

		public Versioning(int version, List<History> history, int updating, int reverting) {
			this(version, history, updating, reverting, 0);
		}

		public Versioning withVersion(int v) {
			return new Versioning(v, history, updating, reverting, deviations);
		}

		public Versioning withUpdating(int to) {
			return new Versioning(version, history, to, reverting, deviations);
		}

		public Versioning withReverting(int to) {
			return new Versioning(version, history, updating, to, deviations);
		}

		/** The cells the player changed that the last delta kept (KEEP): they stay until the player puts the block back. */
		public Versioning withDeviations(int n) {
			return new Versioning(version, history, updating, reverting, n);
		}

		public Versioning append(History h) {
			List<History> l = new ArrayList<>(history);
			l.add(h);
			return new Versioning(h.version(), l, 0, 0, deviations);
		}

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("version", version);
			JsonArray h = new JsonArray();
			history.forEach(x -> h.add(x.toJson()));
			o.add("history", h);
			if (updating > 0) {
				o.addProperty("updating", updating);
			}
			if (reverting > 0) {
				o.addProperty("reverting", reverting);
			}
			if (deviations > 0) {
				o.addProperty("deviations", deviations);
			}
			return o;
		}

		public static Versioning fromJson(@Nullable JsonObject o) {
			if (o == null) {
				return NONE;
			}
			List<History> h = new ArrayList<>();
			if (o.get("history") instanceof JsonArray a) {
				for (JsonElement e : a) {
					h.add(History.fromJson(e.getAsJsonObject()));
				}
			}
			return new Versioning(o.has("version") ? o.get("version").getAsInt() : 0, h, o.has("updating") ? o.get("updating").getAsInt() : 0,
				o.has("reverting") ? o.get("reverting").getAsInt() : 0, o.has("deviations") ? o.get("deviations").getAsInt() : 0);
		}
	}

	/**
	 * One step of a site's history: the version it reached, when, how ({@code placed}, {@code delta}, {@code revert},
	 * {@code forward}), the {@code delta} journal entry that holds it (null for placed and reverts), the box corner the version
	 * stands at, and whether it can still be journal-undone ({@code revertible}: false for construction deltas and folded ones).
	 */
	public record History(int version, long appliedAt, String kind, @Nullable String deltaEntry, int[] origin, boolean revertible) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("version", version);
			o.addProperty("appliedAt", appliedAt);
			o.addProperty("kind", kind);
			if (deltaEntry != null) {
				o.addProperty("deltaEntry", deltaEntry);
			}
			JsonArray or = new JsonArray();
			for (int v : origin) {
				or.add(v);
			}
			o.add("origin", or);
			o.addProperty("revertible", revertible);
			return o;
		}

		public static History fromJson(JsonObject o) {
			int[] or = new int[3];
			if (o.get("origin") instanceof JsonArray a && a.size() == 3) {
				for (int i = 0; i < 3; i++) {
					or[i] = a.get(i).getAsInt();
				}
			}
			return new History(o.get("version").getAsInt(), o.has("appliedAt") ? o.get("appliedAt").getAsLong() : 0L, o.has("kind") ? o.get("kind")
				.getAsString() : "placed", o.has("deltaEntry") ? o.get("deltaEntry").getAsString() : null, or, !o.has("revertible") || o.get("revertible")
					.getAsBoolean());
		}

		public History withRevertible(boolean r) {
			return new History(version, appliedAt, kind, deltaEntry, origin, r);
		}
	}

	/** The same site at another version state. */
	public Site withVersioning(Versioning v) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner,
			ext, member, placing, v);
	}

	/** The same site with another geometry (a delta moves its box, anchors and pin; the restore box only grows). */
	public Site withGeometry(Anchors.Bounds b, Anchors.Bounds in, Map<String, Anchor> an, Anchors.@Nullable Bounds snap, @Nullable Pin p) {
		return new Site(id, blueprint, rotation, b, in, an, placedAt, dimension, snap, snapshot, movedFrom, p, construction, owner, ext, member, placing,
			versioning);
	}

	/** Phase 4a shape: no group membership, not placing. */
	public Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
		long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin,
		@Nullable Construction construction, @Nullable String owner, JsonObject ext) {
		this(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner, ext, null,
			false);
	}

	/** What a batch placed a site for: its site group, the batch and the item key (phase 4d, SHOULD 4). */
	public record Member(String group, @Nullable String batchId, @Nullable String itemKey) {
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("group", group);
			if (batchId != null) {
				o.addProperty("batchId", batchId);
			}
			if (itemKey != null) {
				o.addProperty("itemKey", itemKey);
			}
			return o;
		}

		public static Member fromJson(JsonObject o) {
			return new Member(o.get("group").getAsString(), o.has("batchId") ? o.get("batchId").getAsString() : null,
				o.has("itemKey") ? o.get("itemKey").getAsString() : null);
		}
	}

	/** A site placed instantly (phases 1-2): no construction data, no owner. */
	public Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
		long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin) {
		this(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, null, null, new JsonObject());
	}

	/** Phase 3 shape: no owner, no ext. */
	public Site(String id, String blueprint, String rotation, Anchors.Bounds box, Anchors.Bounds interior, Map<String, Anchor> anchors,
		long placedAt, String dimension, Anchors.@Nullable Bounds snapshotBox, String snapshot, @Nullable Location movedFrom, @Nullable Pin pin,
		@Nullable Construction construction) {
		this(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, null,
			new JsonObject());
	}

	/** Whether the site has an owner other than the player (R5). */
	public boolean owned() {
		return owner != null;
	}

	/** The same site with another owner and ext (carried over by move, pin and construction changes). */
	public Site withOwnership(@Nullable String owner, @Nullable JsonObject ext) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner,
			ext == null ? new JsonObject() : ext, member, placing, versioning);
	}

	/** The same site with another pin. */
	public Site withPin(@Nullable Pin p) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, p, construction, owner, ext,
			member, placing, versioning);
	}

	/** A construction site still building (survival, docs/CONTRACT.md phase 3): not every queued cell is in the world yet. */
	public boolean building() {
		return construction != null && construction.building();
	}

	public Site withConstruction(@Nullable Construction c) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, c, owner, ext, member,
			placing, versioning);
	}

	/** The same site in (or out of) a group. */
	public Site withMember(@Nullable Member m) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner,
			ext, m, placing, versioning);
	}

	/** The same site, still placing or done placing. */
	public Site withPlacing(boolean p) {
		return new Site(id, blueprint, rotation, box, interior, anchors, placedAt, dimension, snapshotBox, snapshot, movedFrom, pin, construction, owner,
			ext, member, p, versioning);
	}

	/** The site group it belongs to, or null. */
	public @Nullable String group() {
		return member == null ? null : member.group();
	}

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
		ext = ext == null ? new JsonObject() : ext.deepCopy();
		owner = owner == null || owner.isBlank() ? null : owner;
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

	/** A copy: the record must not be changed through it. */
	@Override
	public JsonObject ext() {
		return ext.deepCopy();
	}

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
		if (construction != null) {
			o.add("construction", construction.toJson());
		}
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		if (ext.size() > 0) {
			o.add("ext", ext.deepCopy());
		}
		if (member != null) {
			o.add("member", member.toJson());
		}
		if (placing) {
			o.addProperty("placing", true);
		}
		if (!versioning.equals(Versioning.NONE)) {
			o.add("versions", versioning.toJson());
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
			o.has("pin") && o.get("pin").isJsonObject() ? Pin.fromJson(o.getAsJsonObject("pin")) : null,
			o.has("construction") && o.get("construction").isJsonObject() ? Construction.fromJson(o.getAsJsonObject("construction")) : null,
			o.has("owner") && o.get("owner").isJsonPrimitive() ? o.get("owner").getAsString() : null,
			o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject(),
			o.has("member") && o.get("member").isJsonObject() ? Member.fromJson(o.getAsJsonObject("member")) : null,
			o.has("placing") && o.get("placing").getAsBoolean(), o.has("versions") && o.get("versions").isJsonObject() ? Versioning.fromJson(o
				.getAsJsonObject("versions")) : Versioning.NONE);
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
		return fileJson(sites, next, pending, List.of(), 1);
	}

	/** The sites file with the site groups (phase 4d): {@code "groups": [...]} and {@code "nextGroup"}. */
	public static JsonObject fileJson(List<Site> sites, int next, List<Pending> pending, List<SiteGroupRec> groups, int nextGroup) {
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
		if (!groups.isEmpty() || nextGroup > 1) {
			JsonArray g = new JsonArray();
			groups.forEach(x -> g.add(x.toJson()));
			root.add("groups", g);
			root.addProperty("nextGroup", nextGroup);
		}
		return root;
	}

	/** Parsed sites file. */
	public record FileData(List<Site> sites, int next, List<Pending> pending, List<SiteGroupRec> groups, int nextGroup) {
		public FileData {
			sites = List.copyOf(sites);
			pending = List.copyOf(pending);
			groups = List.copyOf(groups);
		}

		public FileData(List<Site> sites, int next, List<Pending> pending) {
			this(sites, next, pending, List.of(), 1);
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
		List<SiteGroupRec> groups = new ArrayList<>();
		int maxGroup = 0;
		for (JsonElement e : root.has("groups") ? root.getAsJsonArray("groups") : new JsonArray()) {
			SiteGroupRec g = SiteGroupRec.fromJson(e.getAsJsonObject());
			groups.add(g);
			maxGroup = Math.max(maxGroup, number(g.id(), 'g'));
		}
		int next = root.has("next") ? root.get("next").getAsInt() : 1;
		int nextGroup = root.has("nextGroup") ? root.get("nextGroup").getAsInt() : 1;
		return new FileData(list, Math.max(next, maxId + 1), pending, groups, Math.max(nextGroup, maxGroup + 1));
	}

	/** {@code g12 -> 12} (for prefix 'g'); 0 for other ids. */
	public static int number(@Nullable String id, char prefix) {
		if (id == null || id.length() < 2 || id.charAt(0) != prefix) {
			return 0;
		}
		try {
			return Integer.parseInt(id.substring(1));
		} catch (NumberFormatException e) {
			return 0;
		}
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
