package dev.larattalabs.architect.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.design.DesignSpec;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The Style editor's model: a Style being edited (a new version of the player's own) or made (a copy of any
 * Style: a duplicate, a start from a built-in). Name, tags, the four main rows and every role (a {@link StyleForm} in VARIANT mode does
 * the fan-out and the provenance, as in the design editor), the suggested features (at most {@value StyleForm#MAX_FEATURES}), and what
 * the Style carries that the editor only shows: its shape hints, its settlement roles and its water / wall / pattern / tier slots
 * (read-only: a slot names a role, so roles are never removed here, only re-pointed). Out: {@link #saveRequest()} is
 * {@code bible.save} ({@code bibleId} when editing), {@link #checkRequest()} the test-house check of the same Style. Pure.
 */
public final class StyleDraft {
	public enum Mode {
		/** A new version of a Style the player may edit ({@link Bible#editable()}). */
		EDIT,
		/** A new hand-made Style, starting from a copy of another (any Style: built-in and mod-owned ones too). */
		NEW
	}

	public static final int MAX_TAGS = 8;
	public static final int MAX_TAG = 20;
	public static final int MAX_NAME = 40;
	/** A settlement Style's extra roles (kit.mjs MACRO_ROLES). */
	public static final List<String> SETTLEMENT_ROLES = List.of("rock", "surface", "subsurface", "rubble", "rail", "structure");
	/** The roles the four main rows and the fixed fan-out cover (kit.mjs CORE_ROLES), in the editor's order. */
	public static final List<String> CORE_ROLES = List.of("wall", "frame", "floor", "foundation", "trim", "roof", "accent", "wall_alt", "light", "glass",
		"path");
	/** What each main row drives (the editor's "drives …" line). */
	public static final Map<String, String> DRIVES = Map.of("wood", "wall, frame, floor + the wood set", "stone", "foundation, trim + the stone set",
		"roof", "roof stairs and slabs", "accent", "accent trim, doors, fences");
	/** Fields the store owns, never sent back. */
	private static final Set<String> STORE = Set.of("id", "version", "versions", "builtin", "preset", "archived", "cost", "critique", "createdAt", "dir",
		"sheetPath", "prose", "components", "owner", "origin", "seedPreset", "ext", "name", "roles", "tags", "suggestedFeatures", "basedOn");
	/** The shape hints, in the order shown. */
	public static final List<String> SHAPE = List.of("roofLanguage", "silhouette", "proportions", "motifs", "lighting", "avoid");
	/** The slot fields (each names roles). */
	public static final List<String> SLOTS = List.of("fluids", "connectors", "patterns", "tiers");

	/** A slot shown read-only: its field and key, what it says, and the roles it names. */
	public record Slot(String field, String key, String text, List<String> roles) {
	}

	private final Mode mode;
	private final @Nullable String id;
	private final int version;
	private final @Nullable String basedOnId;
	private final int basedOnVersion;
	private final JsonObject kept;
	private final StyleForm materials;
	private String name;
	private final List<String> tags = new ArrayList<>();
	private final List<String> features = new ArrayList<>();
	private final String originalName;
	private final List<String> originalTags;
	private final List<String> originalFeatures;

	private StyleDraft(Mode mode, Bible from, @Nullable JsonObject full, String name, StyleRoles table, Palettes palettes) {
		this.mode = mode;
		this.id = mode == Mode.EDIT ? from.id() : null;
		this.version = from.version();
		this.basedOnId = mode == Mode.NEW ? from.id() : from.basedOn().map(p -> p.id()).orElse(null);
		this.basedOnVersion = mode == Mode.NEW ? from.version() : from.basedOn().map(p -> p.version()).orElse(0);
		this.kept = new JsonObject();
		if (full != null) {
			for (var e : full.entrySet()) {
				if (!STORE.contains(e.getKey())) {
					kept.add(e.getKey(), e.getValue().deepCopy());
				}
			}
		}
		if (!kept.has("scope")) {
			kept.addProperty("scope", from.scope());
		}
		from.blurb().ifPresent(b -> {
			if (!kept.has("blurb")) {
				kept.addProperty("blurb", b);
			}
		});
		this.materials = new StyleForm(StyleForm.Mode.VARIANT, StyleForm.Style.of(from), List.of(), table, palettes);
		this.name = name;
		from.tags().forEach(this::addTag);
		from.suggestedFeatures().stream().filter(f -> DesignSpec.find(DesignSpec.FEATURES, f) != null).limit(StyleForm.MAX_FEATURES)
			.forEach(features::add);
		originalName = this.name;
		originalTags = List.copyOf(tags);
		originalFeatures = List.copyOf(features);
	}

	/**
	 * Edit: a new version of {@code b} (the player's own: {@link Bible#editable()}). {@code full}: its {@code bible.json} as stored (shape
	 * hints and slots ride along unchanged), or null (then only what the Bible record carries).
	 */
	public static StyleDraft edit(Bible b, @Nullable JsonObject full, StyleRoles table, Palettes palettes) {
		if (!b.editable()) {
			throw new IllegalArgumentException(b.name() + " can't be edited here (" + (b.builtin() ? "built in" : "owned by " + b.owner().orElse("a mod"))
				+ "): duplicate it");
		}
		return new StyleDraft(Mode.EDIT, b, full, b.name(), table, palettes);
	}

	/** New: a copy of {@code b} named {@code name} (null: "<name> copy"), based on it. */
	public static StyleDraft copy(Bible b, @Nullable JsonObject full, @Nullable String name, StyleRoles table, Palettes palettes) {
		String n = name == null || name.isBlank() ? b.name() + " copy" : name.strip();
		return new StyleDraft(Mode.NEW, b, full, n.length() > MAX_NAME ? n.substring(0, MAX_NAME) : n, table, palettes);
	}

	public Mode mode() {
		return mode;
	}

	public @Nullable String id() {
		return id;
	}

	/** "Save v3" when editing v2, "Save style" for a new one. */
	public String saveLabel() {
		return mode == Mode.EDIT ? "Save v" + (version + 1) : "Save style";
	}

	public String name() {
		return name;
	}

	public void setName(String n) {
		name = n == null ? "" : n;
	}

	public List<String> tags() {
		return List.copyOf(tags);
	}

	/** Adds tags from text ("cold, timber"): lower case, trimmed, at most {@value #MAX_TAGS}; returns how many were added. */
	public int addTag(String text) {
		int n = 0;
		if (text == null) {
			return 0;
		}
		for (String t : text.split(",")) {
			String s = t.strip().toLowerCase(Locale.ROOT).replaceAll("\\s+", " ");
			if (s.length() > MAX_TAG) {
				s = s.substring(0, MAX_TAG).strip();
			}
			if (!s.isEmpty() && !tags.contains(s) && tags.size() < MAX_TAGS) {
				tags.add(s);
				n++;
			}
		}
		return n;
	}

	public void removeTag(String t) {
		tags.remove(t);
	}

	/** The materials (the four main rows, every role and its provenance). */
	public StyleForm materials() {
		return materials;
	}

	public Map<String, String> roles() {
		return materials.roles();
	}

	public List<String> features() {
		return List.copyOf(features);
	}

	/** Turns a suggested feature on or off; at most {@value StyleForm#MAX_FEATURES} (throws past it). */
	public void toggleFeature(String f) {
		if (DesignSpec.find(DesignSpec.FEATURES, f) == null) {
			throw new IllegalArgumentException("unknown feature '" + f + "'");
		}
		if (!features.remove(f)) {
			if (features.size() >= StyleForm.MAX_FEATURES) {
				throw new IllegalArgumentException("at most " + StyleForm.MAX_FEATURES + " suggested features");
			}
			features.add(f);
		}
	}

	/** Whether anything changed since it was opened. */
	public boolean dirty() {
		return !name.equals(originalName) || !tags.equals(originalTags) || !features.equals(originalFeatures) || materials.changed();
	}

	/** The roles beyond the core and settlement ones ("more roles": a Style's own extra roles), in its order. */
	public List<String> extraRoles() {
		List<String> l = new ArrayList<>();
		for (String r : roles().keySet()) {
			if (!CORE_ROLES.contains(r) && !SETTLEMENT_ROLES.contains(r)) {
				l.add(r);
			}
		}
		return l;
	}

	/** The settlement roles the Style names (a settlement Style's; empty for a building one). */
	public List<String> settlementRoles() {
		return SETTLEMENT_ROLES.stream().filter(roles()::containsKey).toList();
	}

	public String scope() {
		return kept.has("scope") ? kept.get("scope").getAsString() : "building";
	}

	/** The shape hints as lines ("Roof language: steep gables"), in {@link #SHAPE} order. */
	public List<String> shapeHints() {
		List<String> out = new ArrayList<>();
		for (String k : SHAPE) {
			if (!kept.has(k)) {
				continue;
			}
			String v = text(kept.get(k));
			if (!v.isBlank()) {
				out.add(label(k) + ": " + v);
			}
		}
		return out;
	}

	/** Every slot the Style carries, read-only (each names roles). */
	public List<Slot> slots() {
		List<Slot> out = new ArrayList<>();
		for (String field : SLOTS) {
			JsonElement e = kept.get(field);
			if (e == null || !e.isJsonObject()) {
				continue;
			}
			for (var s : e.getAsJsonObject().entrySet()) {
				List<String> named = new ArrayList<>();
				collectRoles(s.getValue(), named);
				out.add(new Slot(field, s.getKey(), text(s.getValue()), List.copyOf(named)));
			}
		}
		return out;
	}

	private void collectRoles(JsonElement e, List<String> out) {
		if (e == null || e.isJsonNull()) {
			return;
		}
		if (e.isJsonPrimitive()) {
			String s = e.getAsString();
			if (roles().containsKey(s) && !out.contains(s)) {
				out.add(s);
			}
		} else if (e.isJsonArray()) {
			e.getAsJsonArray().forEach(x -> collectRoles(x, out));
		} else {
			e.getAsJsonObject().entrySet().forEach(x -> collectRoles(x.getValue(), out));
		}
	}

	private static String label(String k) {
		String s = k.replaceAll("([A-Z])", " $1").toLowerCase(Locale.ROOT);
		return Character.toUpperCase(s.charAt(0)) + s.substring(1);
	}

	/** A JSON value as short text: strings as they are, lists joined, objects as "k v, k v". */
	static String text(JsonElement e) {
		if (e == null || e.isJsonNull()) {
			return "";
		}
		if (e.isJsonPrimitive()) {
			return e.getAsString();
		}
		List<String> l = new ArrayList<>();
		if (e.isJsonArray()) {
			e.getAsJsonArray().forEach(x -> l.add(text(x)));
		} else {
			e.getAsJsonObject().entrySet().forEach(x -> l.add(x.getKey() + " " + text(x.getValue())));
		}
		return String.join(", ", l);
	}

	/** Why it can't be saved yet (field -> message), empty when it can be sent (the helper's test house still checks it). */
	public Map<String, String> errors() {
		Map<String, String> e = new LinkedHashMap<>();
		String n = name.strip();
		if (n.isEmpty()) {
			e.put("name", "a Style needs a name");
		} else if (n.length() > MAX_NAME) {
			e.put("name", "at most " + MAX_NAME + " characters (" + n.length() + ")");
		}
		for (Slot s : slots()) {
			for (String r : s.roles()) {
				if (!roles().containsKey(r)) {
					e.put("slots", s.field() + "." + s.key() + " names the role " + r + ", which this Style lacks");
				}
			}
		}
		return e;
	}

	/** The Style as {@code bible.save} and the test-house check take it. */
	public JsonObject bible() {
		JsonObject o = kept.deepCopy();
		o.addProperty("name", name.strip());
		JsonObject r = new JsonObject();
		roles().forEach(r::addProperty);
		o.add("roles", r);
		JsonArray t = new JsonArray();
		tags.forEach(t::add);
		o.add("tags", t);
		JsonArray f = new JsonArray();
		features.forEach(f::add);
		o.add("suggestedFeatures", f);
		if (basedOnId != null && basedOnVersion > 0) {
			JsonObject b = new JsonObject();
			b.addProperty("id", basedOnId);
			b.addProperty("version", basedOnVersion);
			o.add("basedOn", b);
		}
		o.addProperty("origin", "hand");
		return o;
	}

	/** {@code bible.save}'s fields: {@code bibleId} when editing (a new version of it), and the Style. */
	public JsonObject saveRequest() {
		JsonObject o = new JsonObject();
		if (mode == Mode.EDIT && id != null) {
			o.addProperty("bibleId", id);
		}
		o.add("bible", bible());
		return o;
	}

	/** {@code bible.check}'s fields: the Style and its scope. */
	public JsonObject checkRequest() {
		JsonObject o = new JsonObject();
		o.add("bible", bible());
		o.addProperty("scope", scope());
		return o;
	}
}
