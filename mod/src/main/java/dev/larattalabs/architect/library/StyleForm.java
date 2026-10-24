package dev.larattalabs.architect.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.DesignRequest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The design editor's Style model (Style unification U2; docs/STYLE-UNIFY.md §1, §3; docs/CONTRACT.md "Style unification U2"), behind
 * both modes: NEW (WHAT plus a picked Style: its materials and suggested features) and VARIANT (WHAT fixed by the entry; a Style swap
 * re-skins the materials only). The Java twin of {@code kit/lib/styles.mjs} {@code formNew / formApply / formView};
 * {@code StyleFormTest} replays the kit's op sequences ({@code kit/test/fixtures/style-parity.json} {@code forms}). Pure.
 *
 * <ul>
 * <li>The picked Style, its roles, the four main rows (Wood / Stone / Roof / Accent) and each role's provenance are STORED: picking a
 * Style computes them once ({@link StyleRoles#mainOf}, {@link StyleRoles#provenance}); a main-row edit re-derives only the roles whose
 * stored provenance follows that row ({@link StyleRoles#editMainFrom}), so a role set by hand never moves a main row.</li>
 * <li>Any edit makes a custom mix based on the Style ({@link #mix}); {@link #revert} (or picking the same Style) undoes it.</li>
 * <li>Features (NEW): picking a Style adds its suggested features (at most 6 in all), marked as the Style's. Swapping Styles keeps the
 * player's own picks, replaces the untouched suggestions, and never adds back a feature the player turned off.</li>
 * <li>Output: {@link #request()} is the palette half of the request; {@link #saveRequest} the "Save as style…" Style.</li>
 * </ul>
 */
public final class StyleForm {
	public enum Mode {
		NEW, VARIANT
	}

	public static final int MAX_FEATURES = 6;
	public static final String PRESET = "preset";
	public static final String BIBLE = "bible";
	public static final String INPUTS = "inputs";
	private static final Pattern ROLE_ID = Pattern.compile("[a-z][a-z0-9_]{0,31}");
	private static final Pattern BLOCK = Pattern.compile("[a-z0-9_:]+");

	/**
	 * A Style as the form takes it. {@code kind}: {@value #PRESET} (a built-in Style, a palette preset), {@value #BIBLE} (an installed
	 * one: Claude-made or hand-made) or {@value #INPUTS} (an entry's own palette inputs: no Style, id null). {@code editable}: Architect's
	 * UI may edit it in place ({@link Bible#editable()}); every other one is Duplicate-only ("Save as style…" always makes a new one).
	 */
	public record Style(@Nullable String id, String name, int version, String kind, Palettes.@Nullable Inputs inputs, Map<String, String> roles,
		List<String> suggestedFeatures, List<String> tags, boolean editable, boolean modOwned) {
		public Style {
			Map<String, String> r = new LinkedHashMap<>();
			roles.forEach((k, v) -> {
				if (v != null) {
					r.put(k, StyleRoles.qualify(v));
				}
			});
			roles = java.util.Collections.unmodifiableMap(r);
			suggestedFeatures = List.copyOf(suggestedFeatures.size() > MAX_FEATURES ? suggestedFeatures.subList(0, MAX_FEATURES) : suggestedFeatures);
			tags = List.copyOf(tags);
		}

		/** An installed or built-in Style (a built-in one with no metadata takes the kit's, {@link Palettes#presetMeta}). */
		public static Style of(Bible b) {
			List<String> sf = b.suggestedFeatures();
			List<String> tags = b.tags();
			if (b.builtin() && sf.isEmpty() && tags.isEmpty()) {
				Palettes.Meta m = Palettes.presetMeta(b.id());
				if (m != null) {
					sf = m.suggestedFeatures();
					tags = m.tags();
				}
			}
			return new Style(b.id(), b.name(), b.version(), b.builtin() ? PRESET : BIBLE, null, b.roles(), sf, tags, b.editable(), b.modOwned());
		}

		/** A built-in Style from the kit's palettes (no helper needed); null when {@code p} has no roles for it. */
		public static @Nullable Style preset(Palettes p, String name) {
			Map<String, String> r = p.presetRoles(name);
			if (r == null) {
				return null;
			}
			Palettes.Meta m = Palettes.presetMeta(name);
			return new Style(name, name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1), 1, PRESET, null, r,
				m == null ? List.of() : m.suggestedFeatures(), m == null ? List.of() : m.tags(), false, false);
		}

		/** An entry's plain palette inputs (no Style): its roles are their fan-out. */
		public static Style inputs(Palettes.Inputs in, StyleRoles t) {
			return new Style(null, "custom", 1, INPUTS, in, t.fanOut(in), List.of(), List.of(), false, false);
		}

		/** From the kit's form JSON ({@code formStyle}: id, name, version, kind, inputs?, roles, suggestedFeatures, tags). */
		public static Style fromJson(JsonObject o, StyleRoles t) {
			String kind = o.get("kind").getAsString();
			if (kind.equals(INPUTS)) {
				return inputs(Palettes.Inputs.of(o.getAsJsonObject("inputs")), t);
			}
			Map<String, String> r = new LinkedHashMap<>();
			o.getAsJsonObject("roles").entrySet().forEach(e -> r.put(e.getKey(), e.getValue().getAsString()));
			return new Style(o.get("id").getAsString(), o.get("name").getAsString(), o.get("version").getAsInt(), kind, null, r, strings(o
				.getAsJsonArray("suggestedFeatures")), strings(o.getAsJsonArray("tags")), false, false);
		}

		String key() {
			return kind + ":" + Objects.requireNonNullElse(id, "") + ":" + version + ":" + (kind.equals(INPUTS) && inputs != null ? inputs.toJson()
				.toString() : "");
		}
	}

	private static List<String> strings(@Nullable JsonArray a) {
		List<String> l = new ArrayList<>();
		if (a != null) {
			a.forEach(x -> l.add(x.getAsString()));
		}
		return l;
	}

	private final Mode mode;
	private final StyleRoles table;
	private final Palettes palettes;
	private @Nullable Style base;
	private Map<String, String> roles = new LinkedHashMap<>();
	private @Nullable Map<String, String> main;
	private Map<String, String> prov = new LinkedHashMap<>();
	private List<String> features = new ArrayList<>();
	private List<String> from = new ArrayList<>();
	private List<String> mine = new ArrayList<>();
	private List<String> off = new ArrayList<>();
	private final String originalKey;
	private final Map<String, String> originalRoles;

	/**
	 * @param style the Style to start from (VARIANT: the entry's; NEW: the default pick), or null
	 * @param features NEW: the starting features (the player's; the Style's suggestions are not added at construction)
	 */
	public StyleForm(Mode mode, @Nullable Style style, List<String> features, StyleRoles table, Palettes palettes) {
		this.mode = mode;
		this.table = table;
		this.palettes = palettes;
		if (style != null) {
			base = style;
			materials(style);
		}
		if (mode == Mode.NEW) {
			List<String> l = new ArrayList<>(new LinkedHashSet<>(features));
			this.features = new ArrayList<>(l.size() > MAX_FEATURES ? l.subList(0, MAX_FEATURES) : l);
			this.mine = new ArrayList<>(this.features);
		}
		originalKey = base == null ? "" : base.key();
		originalRoles = new LinkedHashMap<>(roles);
	}

	/** With the kit's table and palettes checked in with the mod. */
	public StyleForm(Mode mode, @Nullable Style style, List<String> features) {
		this(mode, style, features, StyleRoles.fallback(), Palettes.FALLBACK);
	}

	private void materials(Style s) {
		roles = new LinkedHashMap<>(s.roles());
		Palettes.Inputs m = table.mainOf(roles);
		main = mainMap(m);
		prov = table.provenance(roles, roles);
	}

	private static Map<String, String> mainMap(Palettes.Inputs m) {
		Map<String, String> o = new LinkedHashMap<>();
		for (String f : StyleRoles.MAIN_FIELDS) {
			o.put(f, m.get(f));
		}
		return o;
	}

	public Mode mode() {
		return mode;
	}

	public StyleRoles table() {
		return table;
	}

	public @Nullable Style base() {
		return base;
	}

	public Map<String, String> roles() {
		return java.util.Collections.unmodifiableMap(roles);
	}

	/** The four main rows as stored (null without a Style). */
	public @Nullable Map<String, String> main() {
		return main == null ? null : java.util.Collections.unmodifiableMap(main);
	}

	public Palettes.Inputs mainInputs() {
		return main == null ? Palettes.Inputs.NONE : new Palettes.Inputs(main.get("wood"), main.get("stone"), main.get("roof"), main.get("accent"));
	}

	/** Each role's provenance: {@code style}, {@code follows_wood}, {@code follows_stone} or {@code hand}. */
	public Map<String, String> provenance() {
		return java.util.Collections.unmodifiableMap(prov);
	}

	public List<String> features() {
		return List.copyOf(features);
	}

	/** Whether a feature on the list came from the Style's suggestions (and the player hasn't touched it). */
	public boolean fromStyle(String feature) {
		return from.contains(feature);
	}

	// ------------------------------------------------------------------ operations (kit formApply)

	/** Picks a Style: its materials; NEW: its suggested features (the player's own stay). The same Style again: reverts the materials. */
	public void pick(Style s) {
		boolean same = base != null && s.key().equals(base.key());
		base = s;
		materials(s);
		if (mode == Mode.NEW && !same) {
			List<String> next = new ArrayList<>(features.stream().filter(mine::contains).toList());
			List<String> fr = new ArrayList<>();
			for (String f : s.suggestedFeatures()) {
				if (next.size() < MAX_FEATURES && !next.contains(f) && !off.contains(f)) {
					next.add(f);
					fr.add(f);
				}
			}
			features = next;
			from = fr;
		}
	}

	/** No Style (free text): the materials go; NEW: so do the Style's untouched suggestions. */
	public void unpick() {
		base = null;
		roles = new LinkedHashMap<>();
		main = null;
		prov = new LinkedHashMap<>();
		if (mode == Mode.NEW) {
			features = new ArrayList<>(features.stream().filter(f -> !from.contains(f)).toList());
			from = new ArrayList<>();
		}
	}

	/** Back to the picked Style's materials (features untouched). */
	public void revert() {
		if (base != null) {
			materials(base);
		}
	}

	/** One main row: the roles that follow it are re-derived; the row shows the value (stored). Throws for a value it can't be. */
	public void editMain(String field, String value) {
		if (base == null || main == null) {
			throw new IllegalStateException("pick a Style first");
		}
		if (!StyleRoles.MAIN_FIELDS.contains(field)) {
			throw new IllegalArgumentException("editMain: field must be one of " + String.join(", ", StyleRoles.MAIN_FIELDS) + " (got " + field + ")");
		}
		List<String> following = new ArrayList<>();
		prov.forEach((r, p) -> {
			if (p.equals("follows_" + field)) {
				following.add(r);
			}
		});
		Map<String, String> next = table.editMainFrom(roles, field, value, main.get(field), following);
		roles = next;
		main.put(field, StyleRoles.shortOf(value));
		if (field.equals("roof") || field.equals("accent")) {
			prov.put(field, Objects.equals(roles.get(field), base.roles().get(field)) ? StyleRoles.STYLE : StyleRoles.HAND);
		}
	}

	/** One role set by hand (it no longer follows a main row). Not for plain inputs (no Style). */
	public void setRole(String role, String block) {
		if (base == null) {
			throw new IllegalStateException("pick a Style first");
		}
		if (base.kind().equals(INPUTS)) {
			throw new IllegalStateException("pick a Style to set a single role (these are plain palette inputs)");
		}
		if (role == null || !ROLE_ID.matcher(role).matches()) {
			throw new IllegalArgumentException("role must match " + ROLE_ID);
		}
		if (block == null || !BLOCK.matcher(block).matches()) {
			throw new IllegalArgumentException("role " + role + ": a block id");
		}
		roles.put(role, StyleRoles.qualify(block));
		prov.put(role, StyleRoles.HAND);
	}

	private void requireNew() {
		if (mode != Mode.NEW) {
			throw new IllegalStateException("a variant's features are fixed (they are in the design's code)");
		}
	}

	/** NEW: turns a feature on (the player's) or off (it stays off through Style swaps). */
	public void toggleFeature(String id) {
		requireNew();
		if (!dev.larattalabs.architect.design.DesignSpec.FEATURES.stream().anyMatch(c -> c.id().equals(id))) {
			throw new IllegalArgumentException("unknown feature '" + id + "'");
		}
		if (features.contains(id)) {
			features.remove(id);
			from.remove(id);
			mine.remove(id);
			if (!off.contains(id)) {
				off.add(id);
			}
		} else {
			if (features.size() >= MAX_FEATURES) {
				throw new IllegalArgumentException("at most " + MAX_FEATURES + " features");
			}
			features.add(id);
			if (!mine.contains(id)) {
				mine.add(id);
			}
			off.remove(id);
		}
	}

	/** NEW: the whole list, all the player's (features dropped from it count as turned off). */
	public void setFeatures(List<String> list) {
		requireNew();
		List<String> l = new ArrayList<>(new LinkedHashSet<>(list));
		for (String f : l) {
			if (!dev.larattalabs.architect.design.DesignSpec.FEATURES.stream().anyMatch(c -> c.id().equals(f))) {
				throw new IllegalArgumentException("unknown feature '" + f + "'");
			}
		}
		if (l.size() > MAX_FEATURES) {
			throw new IllegalArgumentException("at most " + MAX_FEATURES + " features");
		}
		LinkedHashSet<String> o = new LinkedHashSet<>(off.stream().filter(f -> !l.contains(f)).toList());
		features.stream().filter(f -> !l.contains(f)).forEach(o::add);
		off = new ArrayList<>(o);
		features = l;
		mine = new ArrayList<>(l);
		from = new ArrayList<>();
	}

	// ------------------------------------------------------------------ output (kit formMix / formRequest / formSaveRequest / formView)

	/** Whether the materials differ from the picked Style's: a custom mix (based on it). */
	public boolean mix() {
		return base != null && (!roles.equals(base.roles()) || !Objects.equals(main, mainMap(table.mainOf(base.roles()))));
	}

	/** VARIANT: whether the request changes the materials. */
	public boolean changed() {
		return request().size() > 0;
	}

	private JsonObject inline() {
		JsonObject o = new JsonObject();
		o.add("palette", DesignRequest.stylePalette(Objects.requireNonNull(base).id(), base.version(), roles));
		return o;
	}

	private JsonObject inputs() {
		JsonObject p = new JsonObject();
		for (String f : StyleRoles.MAIN_FIELDS) {
			p.addProperty(f, Objects.requireNonNull(main).get(f));
		}
		JsonObject o = new JsonObject();
		o.add("palette", p);
		return o;
	}

	/**
	 * The palette half of the request. NEW: {@code {palette: {bible: {id, version, roles}}}} (withStyle unedited, a custom mix based on the
	 * Style edited), {@code {}} without a Style. VARIANT, {@code {}} while unchanged, else the smallest that builds it: an unedited
	 * preset's name, the four inputs (roles equal to their plain fan-out), {@code bible: id} (an unedited installed Style: the 4b
	 * re-skin), else the roles inline based on the Style.
	 */
	public JsonObject request() {
		Style b = base;
		if (b == null) {
			return new JsonObject();
		}
		if (mode == Mode.NEW) {
			return b.id() != null ? inline() : inputs();
		}
		if (b.key().equals(originalKey) && roles.equals(originalRoles)) {
			return new JsonObject();
		}
		Map<String, String> pr = b.kind().equals(PRESET) ? palettes.presetRoles(b.id()) : null;
		if (pr != null && roles.equals(new Style(null, "", 1, BIBLE, null, pr, List.of(), List.of(), false, false).roles())) {
			JsonObject o = new JsonObject();
			o.addProperty("palette", b.id());
			return o;
		}
		if ((b.kind().equals(PRESET) || b.kind().equals(INPUTS)) && roles.equals(table.fanOut(mainInputs()))) {
			return inputs();
		}
		if (b.kind().equals(BIBLE) && roles.equals(b.roles())) {
			JsonObject o = new JsonObject();
			o.addProperty("bible", b.id());
			return o;
		}
		return b.id() != null ? inline() : inputs();
	}

	/** "Save as style…": the {@code bible.save} Style (always a new hand-made one; name null = "<Style> mix" or "<Style> copy"), or null. */
	public @Nullable JsonObject saveRequest(@Nullable String name) {
		Style b = base;
		if (b == null) {
			return null;
		}
		JsonObject o = new JsonObject();
		o.addProperty("name", name != null ? name : b.name() + (mix() ? " mix" : " copy"));
		JsonObject r = new JsonObject();
		roles.forEach(r::addProperty);
		o.add("roles", r);
		o.add("tags", array(b.tags()));
		o.add("suggestedFeatures", array(mode == Mode.NEW ? features.subList(0, Math.min(MAX_FEATURES, features.size())) : b.suggestedFeatures()));
		if (b.id() != null && !b.kind().equals(INPUTS)) {
			JsonObject bo = new JsonObject();
			bo.addProperty("id", b.id());
			bo.addProperty("version", b.version());
			o.add("basedOn", bo);
		}
		o.addProperty("origin", "hand");
		return o;
	}

	private static JsonArray array(List<String> l) {
		JsonArray a = new JsonArray();
		l.forEach(a::add);
		return a;
	}

	private static JsonObject map(Map<String, String> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	/** The state as the editor and the wire see it (kit formView; what the parity cases record). */
	public JsonObject view() {
		JsonObject o = new JsonObject();
		o.addProperty("mode", mode.name().toLowerCase(Locale.ROOT));
		Style b = base;
		if (b != null) {
			JsonObject s = new JsonObject();
			s.add("id", b.id() == null ? JsonNull.INSTANCE : new JsonPrimitive(b.id()));
			s.addProperty("name", b.name());
			s.addProperty("version", b.version());
			s.addProperty("kind", b.kind());
			o.add("style", s);
		} else {
			o.add("style", JsonNull.INSTANCE);
		}
		o.addProperty("mix", mix());
		if (main != null && b != null) {
			o.add("main", map(main));
			Map<String, String> bm = mainMap(table.mainOf(b.roles()));
			JsonObject mp = new JsonObject();
			for (String f : StyleRoles.MAIN_FIELDS) {
				mp.addProperty(f, Objects.equals(main.get(f), bm.get(f)) ? StyleRoles.STYLE : StyleRoles.HAND);
			}
			o.add("mainProvenance", mp);
		} else {
			o.add("main", JsonNull.INSTANCE);
			o.add("mainProvenance", JsonNull.INSTANCE);
		}
		o.add("roles", map(roles));
		o.add("provenance", map(prov));
		o.add("features", array(features));
		JsonObject fp = new JsonObject();
		features.forEach(f -> fp.addProperty(f, from.contains(f) ? StyleRoles.STYLE : StyleRoles.HAND));
		o.add("featureProvenance", fp);
		o.add("changed", mode == Mode.VARIANT ? new JsonPrimitive(changed()) : JsonNull.INSTANCE);
		o.add("request", request());
		JsonElement save = saveRequest(null);
		o.add("save", save == null ? JsonNull.INSTANCE : save);
		return o;
	}
}
