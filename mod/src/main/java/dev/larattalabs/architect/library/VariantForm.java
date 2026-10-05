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
	private final Palettes.Inputs originalPalette;
	private final @Nullable String originalPreset;
	private final Map<String, JsonPrimitive> original = new LinkedHashMap<>();
	private final Map<String, JsonPrimitive> values = new LinkedHashMap<>();
	private @Nullable String preset;
	private Palettes.Inputs inputs;
	private String name = "";

	/**
	 * @param from the library id
	 * @param params the entry's {@code params} (or null)
	 * @param values the entry's {@code values} (or null: the defaults)
	 * @param palette the entry's {@code palette} (or null)
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
		String named = palette == null ? null : Palettes.first(palette, "preset", "name");
		Palettes.Inputs in = Palettes.Inputs.of(palette);
		Palettes.Inputs presetIn = palettes.preset(named);
		if (presetIn != null) {
			in = in.orElse(presetIn);
		}
		this.originalPalette = in;
		this.originalPreset = presetIn != null && presetIn.equals(in) ? named : palettes.presetMatching(in);
		this.inputs = in;
		this.preset = originalPreset;
	}

	public String from() {
		return from;
	}

	public Palettes palettes() {
		return palettes;
	}

	public List<Param> params() {
		return params;
	}

	public List<String> skipped() {
		return List.copyOf(skipped);
	}

	public @Nullable String preset() {
		return preset;
	}

	public Palettes.Inputs inputs() {
		return inputs;
	}

	public String name() {
		return name;
	}

	public void setName(@Nullable String n) {
		name = n == null ? "" : n.strip();
	}

	/** Picks a preset chip: the inputs become the preset's. */
	public void choosePreset(String p) {
		Palettes.Inputs in = palettes.preset(p);
		if (in == null) {
			throw new IllegalArgumentException("no palette preset '" + p + "' (" + String.join(", ", palettes.presets().keySet()) + ")");
		}
		preset = p;
		inputs = in;
	}

	/** An advanced dropdown: one field changes; the preset name stays only while the inputs still equal it. */
	public void setField(String field, @Nullable String value) {
		if (!Palettes.FIELDS.contains(field)) {
			throw new IllegalArgumentException("palette field must be wood, stone, roof or accent: " + field);
		}
		inputs = inputs.with(field, Palettes.shortName(value));
		Palettes.Inputs p = palettes.preset(preset);
		if (p == null || !p.equals(inputs)) {
			preset = palettes.presetMatching(inputs);
		}
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
		return !inputs.equals(originalPalette);
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
	 * {@code {from, palette?, values?, name?}}: {@code palette} is the preset name when the inputs are exactly a preset's,
	 * else an object of the four inputs, and absent when unchanged; {@code values} holds only the changed parameters.
	 */
	public JsonObject requestJson() {
		JsonObject o = new JsonObject();
		o.addProperty("from", from);
		if (paletteChanged()) {
			Palettes.Inputs p = palettes.preset(preset);
			if (preset != null && p != null && p.equals(inputs)) {
				o.addProperty("palette", preset);
			} else {
				o.add("palette", inputs.toJson());
			}
		}
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

	/** DevBridge view. */
	public JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("from", from);
		o.addProperty("preset", preset);
		o.addProperty("originalPreset", originalPreset);
		o.add("inputs", inputs.toJson());
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
