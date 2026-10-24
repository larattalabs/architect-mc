package dev.larattalabs.architect.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The Variants dialog's model (docs/CONTRACT.md "Variants…"): a palette (a preset, plus advanced wood/stone/roof/accent
 * overrides) and one control per declared parameter ({@code params}: {@code int} = stepper, {@code bool} = toggle,
 * {@code enum} = chips). {@link #requestJson()} is the {@code variant.request} payload: only what changed from the entry
 * is sent. Pure; the screen and the DevBridge drive it.
 */
public final class VariantForm {
	/** One parameter control. */
	public sealed interface Param permits IntParam, BoolParam, EnumParam {
		String name();

		String label();

		JsonPrimitive defaultValue();

		/** The value clamped / coerced into the domain (the default when it is unusable). */
		JsonPrimitive coerce(@Nullable JsonElement v);

		String kind();
	}

	public record IntParam(String name, String label, int min, int max, int def) implements Param {
		public JsonPrimitive defaultValue() {
			return new JsonPrimitive(def);
		}

		public JsonPrimitive coerce(@Nullable JsonElement v) {
			int x = def;
			if (v != null && v.isJsonPrimitive()) {
				try {
					x = (int) Math.round(v.getAsDouble());
				} catch (NumberFormatException e) {
					x = def;
				}
			}
			return new JsonPrimitive(Math.max(min, Math.min(max, x)));
		}

		public String kind() {
			return "int";
		}
	}

	public record BoolParam(String name, String label, boolean def) implements Param {
		public JsonPrimitive defaultValue() {
			return new JsonPrimitive(def);
		}

		public JsonPrimitive coerce(@Nullable JsonElement v) {
			if (v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isBoolean()) {
				return v.getAsJsonPrimitive();
			}
			if (v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isString()) {
				return new JsonPrimitive(Boolean.parseBoolean(v.getAsString()));
			}
			return defaultValue();
		}

		public String kind() {
			return "bool";
		}
	}

	public record EnumParam(String name, String label, List<String> options, String def) implements Param {
		public EnumParam {
			options = List.copyOf(options);
		}

		public JsonPrimitive defaultValue() {
			return new JsonPrimitive(def);
		}

		public JsonPrimitive coerce(@Nullable JsonElement v) {
			if (v != null && v.isJsonPrimitive() && options.contains(v.getAsString())) {
				return new JsonPrimitive(v.getAsString());
			}
			return defaultValue();
		}

		public String kind() {
			return "enum";
		}
	}

	/** The controls for a {@code params} schema, in declaration order. Entries it cannot use are listed in {@code skipped}. */
	public static List<Param> controls(@Nullable JsonObject params, List<String> skipped) {
		List<Param> out = new ArrayList<>();
		if (params == null) {
			return out;
		}
		for (var e : params.entrySet()) {
			String name = e.getKey();
			if (!e.getValue().isJsonObject()) {
				skipped.add(name + ": not an object");
				continue;
			}
			JsonObject p = e.getValue().getAsJsonObject();
			String type = Palettes.first(p, "type");
			String label = Objects.requireNonNullElse(Palettes.first(p, "label"), humanize(name));
			try {
				switch (type == null ? "" : type.toLowerCase(Locale.ROOT)) {
					case "int", "integer", "number" -> {
						int min = p.get("min").getAsInt();
						int max = p.get("max").getAsInt();
						if (max < min) {
							throw new IllegalArgumentException("max < min");
						}
						int def = p.has("default") ? p.get("default").getAsInt() : min;
						out.add(new IntParam(name, label, min, max, Math.max(min, Math.min(max, def))));
					}
					case "bool", "boolean" -> out.add(new BoolParam(name, label, p.has("default") && p.get("default").getAsBoolean()));
					case "enum", "choice" -> {
						List<String> opts = new ArrayList<>();
						for (JsonElement o : p.getAsJsonArray("options")) {
							opts.add(o.isJsonObject() ? o.getAsJsonObject().get("value").getAsString() : o.getAsString());
						}
						if (opts.isEmpty()) {
							throw new IllegalArgumentException("no options");
						}
						String def = p.has("default") && opts.contains(p.get("default").getAsString()) ? p.get("default").getAsString() : opts.get(0);
						out.add(new EnumParam(name, label, opts, def));
					}
					default -> skipped.add(name + ": unknown type " + type);
				}
			} catch (RuntimeException ex) {
				skipped.add(name + ": " + (ex.getMessage() == null ? ex.getClass().getSimpleName() : ex.getMessage()));
			}
		}
		return out;
	}

	static String humanize(String name) {
		String s = name.replaceAll("([a-z])([A-Z])", "$1 $2").replace('_', ' ').strip().toLowerCase(Locale.ROOT);
		return s.isEmpty() ? name : Character.toUpperCase(s.charAt(0)) + s.substring(1);
	}

	private final String from;
	private final Palettes palettes;
	private final List<Param> params;
	private final List<String> skipped = new ArrayList<>();
	private final @Nullable String originalPreset;
	private final Map<String, JsonPrimitive> original = new LinkedHashMap<>();
	private final Map<String, JsonPrimitive> values = new LinkedHashMap<>();
	private String name = "";
	/**
	 * (Style unification U2) The palette half: a {@link StyleForm} in VARIANT mode. WHAT is fixed (the design's code); a Style swap
	 * re-skins the materials only; the main rows and the roles' provenance are stored there.
	 */
	private final StyleForm style;
	/** The entry's own Style (a bible chip toggled off goes back to it). */
	private final StyleForm.@Nullable Style entryStyle;
	/** The rows before an installed Style with no known roles was picked (a main-row edit then falls back to plain inputs, as in 4b). */
	private Palettes.Inputs inputsBeforeBible = Palettes.Inputs.NONE;

	/**
	 * @param from the library id
	 * @param params the entry's {@code params} (or null)
	 * @param values the entry's {@code values} (or null: the defaults)
	 * @param palette the entry's {@code palette} (or null): a preset name and/or inputs, or a Style's roles {@code {bible: {id, version, roles}}}
	 */
	public VariantForm(String from, @Nullable JsonObject params, @Nullable JsonObject values, @Nullable JsonObject palette, Palettes palettes) {
		this.from = from;
		this.palettes = palettes;
		this.params = controls(params, skipped);
		for (Param p : this.params) {
			JsonPrimitive v = p.coerce(values == null ? null : values.get(p.name()));
			original.put(p.name(), v);
			this.values.put(p.name(), v);
		}
		this.entryStyle = entryStyle(palette, palettes);
		this.style = new StyleForm(StyleForm.Mode.VARIANT, entryStyle, List.of(), StyleRoles.fallback(), palettes);
		this.originalPreset = preset();
	}

	/** The Style an entry's palette names: a preset, its inputs, or its roles inline; null for none. */
	public static StyleForm.@Nullable Style entryStyle(@Nullable JsonObject palette, Palettes palettes) {
		if (palette == null) {
			return null;
		}
		if (palette.has("bible") && palette.get("bible").isJsonObject()) {
			JsonObject b = palette.getAsJsonObject("bible");
			Map<String, String> r = new LinkedHashMap<>();
			if (b.has("roles") && b.get("roles").isJsonObject()) {
				b.getAsJsonObject("roles").entrySet().forEach(e -> {
					if (e.getValue().isJsonPrimitive()) {
						r.put(e.getKey(), e.getValue().getAsString());
					}
				});
			}
			String id = Palettes.first(b, "id");
			int v = b.has("version") && b.get("version").isJsonPrimitive() ? b.get("version").getAsInt() : 1;
			StyleForm.Style preset = id == null ? null : StyleForm.Style.preset(palettes, id);
			if (preset != null && preset.roles().equals(new StyleForm.Style(id, id, v, StyleForm.BIBLE, null, r, List.of(), List.of(), false, false).roles())) {
				return preset;
			}
			return new StyleForm.Style(id == null ? "custom" : id, id == null ? "custom" : id, v, StyleForm.BIBLE, null, r, List.of(), List.of(), false, false);
		}
		String named = Palettes.first(palette, "preset", "name");
		Palettes.Inputs in = Palettes.Inputs.of(palette);
		Palettes.Inputs presetIn = palettes.preset(named);
		if (presetIn != null) {
			in = in.orElse(presetIn);
		}
		String match = presetIn != null && presetIn.equals(in) ? named : palettes.presetMatching(in);
		StyleForm.Style p = match == null ? null : StyleForm.Style.preset(palettes, match);
		if (p != null) {
			return p;
		}
		return in.equals(Palettes.Inputs.NONE) ? null : StyleForm.Style.inputs(in, StyleRoles.fallback());
	}

	public String from() {
		return from;
	}

	public Palettes palettes() {
		return palettes;
	}

	/** (U2) The palette half's model. */
	public StyleForm style() {
		return style;
	}

	public List<Param> params() {
		return params;
	}

	public List<String> skipped() {
		return List.copyOf(skipped);
	}

	/** The preset the materials are exactly (an unedited built-in Style, or plain inputs equal to a preset's), or null. */
	public @Nullable String preset() {
		StyleForm.Style b = style.base();
		if (b == null) {
			return null;
		}
		if (b.kind().equals(StyleForm.PRESET) && !style.mix()) {
			return b.id();
		}
		if ((b.kind().equals(StyleForm.PRESET) || b.kind().equals(StyleForm.INPUTS)) && style.roles().equals(style.table().fanOut(style.mainInputs()))) {
			String m = palettes.presetMatching(style.mainInputs());
			Map<String, String> pr = m == null ? null : palettes.presetRoles(m);
			return pr == null || style.roles().equals(new StyleForm.Style(m, m, 1, StyleForm.BIBLE, null, pr, List.of(), List.of(), false, false).roles())
				? m : null;
		}
		return null;
	}

	/** The four main rows as the form stores them ({@link Palettes.Inputs#NONE} without a Style). */
	public Palettes.Inputs inputs() {
		return style.mainInputs();
	}

	public String name() {
		return name;
	}

	public void setName(@Nullable String n) {
		name = n == null ? "" : n.strip();
	}

	/** The installed Style picked (a re-skin), or null. */
	public @Nullable String bible() {
		StyleForm.Style b = style.base();
		return b != null && b.kind().equals(StyleForm.BIBLE) && b != entryStyle ? b.id() : null;
	}

	/** (U2) Picks a Style (re-skin: materials only); null = back to the entry's own. */
	public void chooseStyle(StyleForm.@Nullable Style s) {
		if (s == null) {
			if (entryStyle != null) {
				style.pick(entryStyle);
			} else {
				style.unpick();
			}
			return;
		}
		if (s.roles().isEmpty()) {
			inputsBeforeBible = style.mainInputs();
		}
		style.pick(s);
	}

	/** Picks an installed style bible by id only (its roles unknown here: unedited, the 4b re-skin {@code bible: id}); null = none. */
	public void chooseBible(@Nullable String id) {
		chooseStyle(id == null || id.isBlank() ? null : new StyleForm.Style(id, id, 1, StyleForm.BIBLE, null, Map.of(), List.of(), List.of(), false, false));
	}

	/**
	 * (Style unification U1) Picks a style bible with its version and roles: a later main-row edit ({@link #setField}) edits these roles
	 * and the variant is sent with them inline ({@code palette: {bible: {id, version, roles}}}). Null id = none.
	 */
	public void chooseBible(@Nullable String id, int version, @Nullable Map<String, String> roles) {
		if (id == null || id.isBlank() || roles == null || roles.isEmpty()) {
			chooseBible(id);
			return;
		}
		chooseStyle(new StyleForm.Style(id, id, Math.max(1, version), StyleForm.BIBLE, null, roles, List.of(), List.of(), false, false));
	}

	/** The roles the variant builds with (null without a Style, or an installed one whose roles are unknown here). */
	public @Nullable Map<String, String> roles() {
		return style.base() == null || style.roles().isEmpty() ? null : new LinkedHashMap<>(style.roles());
	}

	/** Picks a preset chip: another Style (it replaces a picked bible). */
	public void choosePreset(String p) {
		Palettes.Inputs in = palettes.preset(p);
		if (in == null) {
			throw new IllegalArgumentException("no palette preset '" + p + "' (" + String.join(", ", palettes.presets().keySet()) + ")");
		}
		StyleForm.Style s = StyleForm.Style.preset(palettes, p);
		style.pick(s != null ? s : StyleForm.Style.inputs(in, style.table()));
	}

	/** A main row (Wood / Stone / Roof / Accent): the roles that still follow it are re-derived (StyleForm). */
	public void setField(String field, @Nullable String value) {
		if (!Palettes.FIELDS.contains(field)) {
			throw new IllegalArgumentException("palette field must be wood, stone, roof or accent: " + field);
		}
		String v = Palettes.shortName(value);
		if (v == null) {
			throw new IllegalArgumentException("a palette " + field + " needs a value");
		}
		StyleForm.Style b = style.base();
		if (b == null || b.roles().isEmpty()) {
			// no Style, or an installed one whose roles are unknown here: plain inputs from the rows shown (4b: the bible is dropped)
			Palettes.Inputs in = (b == null ? Palettes.Inputs.NONE : inputsBeforeBible).with(field, v);
			style.pick(StyleForm.Style.inputs(in, style.table()));
			return;
		}
		style.editMain(field, v);
	}

	public JsonPrimitive value(String param) {
		JsonPrimitive v = values.get(param);
		if (v == null) {
			throw new IllegalArgumentException("no parameter '" + param + "'");
		}
		return v;
	}

	public Param param(String name) {
		for (Param p : params) {
			if (p.name().equals(name)) {
				return p;
			}
		}
		throw new IllegalArgumentException("no parameter '" + name + "' (" + String.join(", ", params.stream().map(Param::name).toList()) + ")");
	}

	/** Sets a parameter (coerced into its domain). */
	public void set(String param, @Nullable JsonElement v) {
		values.put(param, param(param).coerce(v));
	}

	/** Steps an int parameter by {@code delta} (clamped). */
	public void step(String param, int delta) {
		if (param(param) instanceof IntParam ip) {
			set(param, new JsonPrimitive(value(param).getAsInt() + delta));
		}
	}

	public void toggle(String param) {
		if (param(param) instanceof BoolParam) {
			set(param, new JsonPrimitive(!value(param).getAsBoolean()));
		}
	}

	public boolean paletteChanged() {
		return style.changed();
	}

	/** The parameters that differ from the entry's values. */
	public Map<String, JsonPrimitive> changedValues() {
		Map<String, JsonPrimitive> m = new LinkedHashMap<>();
		values.forEach((k, v) -> {
			if (!v.equals(original.get(k))) {
				m.put(k, v);
			}
		});
		return m;
	}

	/** Whether "Make variant" has something to make. */
	public boolean changed() {
		return paletteChanged() || !changedValues().isEmpty();
	}

	/**
	 * {@code {from, palette? | bible?, values?, name?}}: the palette half is {@link StyleForm#request()} (absent when unchanged; a preset
	 * name, the four inputs, {@code bible: id} for an unedited installed Style, or a Style's roles inline); {@code values} holds only the
	 * changed parameters.
	 */
	public JsonObject requestJson() {
		JsonObject o = new JsonObject();
		o.addProperty("from", from);
		style.request().entrySet().forEach(e -> o.add(e.getKey(), e.getValue()));
		Map<String, JsonPrimitive> ch = changedValues();
		if (!ch.isEmpty()) {
			JsonObject v = new JsonObject();
			ch.forEach(v::add);
			o.add("values", v);
		}
		if (!name.isEmpty()) {
			o.addProperty("name", name);
		}
		return o;
	}

	/**
	 * "Will make: …" (the Variants dialog's footer): a re-skin with a Style, a preset or inputs palette, a custom mix of a Style (its roles
	 * inline: before U2 the dialog read every palette value as a string and threw on that object), then the changed values.
	 * @param styleName a Style id -> its name (the installed ones the client knows)
	 */
	public String summary(java.util.function.Function<String, String> styleName) {
		JsonObject r = requestJson();
		List<String> bits = new ArrayList<>();
		if (r.has("bible")) {
			bits.add("re-skinned with " + styleName.apply(r.get("bible").getAsString()));
		}
		if (r.has("palette")) {
			JsonElement p = r.get("palette");
			if (p.isJsonPrimitive()) {
				bits.add(p.getAsString() + " palette");
			} else if (p.getAsJsonObject().has("bible")) {
				bits.add("custom mix of " + styleName.apply(p.getAsJsonObject().getAsJsonObject("bible").get("id").getAsString()));
			} else {
				bits.add("palette " + String.join("/", p.getAsJsonObject().entrySet().stream().filter(e -> e.getValue().isJsonPrimitive()).map(e -> e
					.getValue().getAsString()).toList()));
			}
		}
		if (r.has("values")) {
			r.getAsJsonObject("values").entrySet().forEach(e -> bits.add(e.getKey() + " " + (e.getValue().isJsonPrimitive() && e.getValue()
				.getAsJsonPrimitive().isBoolean() ? e.getValue().getAsBoolean() ? "on" : "off" : e.getValue().getAsString())));
		}
		return String.join(", ", bits);
	}

	/** DevBridge view. */
	public JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("from", from);
		o.addProperty("preset", preset());
		o.addProperty("bible", bible());
		o.add("style", style.view());
		Map<String, String> rs = roles();
		if (rs != null) {
			JsonObject r = new JsonObject();
			rs.forEach(r::addProperty);
			o.add("roles", r);
			JsonObject pv = new JsonObject();
			style.provenance().forEach(pv::addProperty);
			o.add("provenance", pv);
		}
		o.addProperty("originalPreset", originalPreset);
		o.add("inputs", inputs().toJson());
		JsonArray ps = new JsonArray();
		for (Param p : params) {
			JsonObject j = new JsonObject();
			j.addProperty("name", p.name());
			j.addProperty("label", p.label());
			j.addProperty("kind", p.kind());
			j.add("value", values.get(p.name()));
			j.add("default", p.defaultValue());
			if (p instanceof IntParam ip) {
				j.addProperty("min", ip.min());
				j.addProperty("max", ip.max());
			} else if (p instanceof EnumParam ep) {
				JsonArray a = new JsonArray();
				ep.options().forEach(a::add);
				j.add("options", a);
			}
			ps.add(j);
		}
		o.add("params", ps);
		JsonArray sk = new JsonArray();
		skipped.forEach(sk::add);
		o.add("skipped", sk);
		o.addProperty("changed", changed());
		o.add("request", requestJson());
		o.addProperty("palettesFrom", palettes.origin());
		return o;
	}
}
