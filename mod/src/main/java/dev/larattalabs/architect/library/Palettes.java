package dev.larattalabs.architect.library;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * The kit's palettes for the Variants dialog: the presets ({@code kit/lib/kit.mjs PALETTES}, each as its inputs) and the
 * choices for the advanced wood/stone/roof/accent dropdowns. Read from JSON shaped
 * {@code {"presets": {"rustic": {"wood","stone","roof","accent"}, ...}, "woods": [...], "stones": [...], "roofs": [...]}}:
 * the sidecar's {@code snapshot.palettes} when it sends one, else the {@code palettes.json} generated from the kit at build
 * time, else {@link #FALLBACK}. Pure.
 */
public record Palettes(Map<String, Inputs> presets, List<String> woods, List<String> stones, List<String> roofs, String origin) {
	/** A palette's inputs (short names without {@code minecraft:}); any may be null (the kit derives it). */
	public record Inputs(@Nullable String wood, @Nullable String stone, @Nullable String roof, @Nullable String accent) {
		public static final Inputs NONE = new Inputs(null, null, null, null);

		public Inputs {
			wood = shortName(wood);
			stone = shortName(stone);
			roof = shortName(roof);
			accent = shortName(accent);
		}

		public @Nullable String get(String field) {
			return switch (field) {
				case "wood" -> wood;
				case "stone" -> stone;
				case "roof" -> roof;
				case "accent" -> accent;
				default -> throw new IllegalArgumentException("palette field must be wood, stone, roof or accent: " + field);
			};
		}

		public Inputs with(String field, @Nullable String v) {
			return switch (field) {
				case "wood" -> new Inputs(v, stone, roof, accent);
				case "stone" -> new Inputs(wood, v, roof, accent);
				case "roof" -> new Inputs(wood, stone, v, accent);
				case "accent" -> new Inputs(wood, stone, roof, v);
				default -> throw new IllegalArgumentException("palette field must be wood, stone, roof or accent: " + field);
			};
		}

		/** Fields filled from {@code base} where this one has none. */
		public Inputs orElse(Inputs base) {
			return new Inputs(wood != null ? wood : base.wood, stone != null ? stone : base.stone, roof != null ? roof : base.roof,
				accent != null ? accent : base.accent);
		}

		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			if (wood != null) {
				o.addProperty("wood", wood);
			}
			if (stone != null) {
				o.addProperty("stone", stone);
			}
			if (roof != null) {
				o.addProperty("roof", roof);
			}
			if (accent != null) {
				o.addProperty("accent", accent);
			}
			return o;
		}

		/** Reads {@code wood/stone/roof/accent}; the kit's own palette object names them {@code wood, stoneName, roofName, accentWood}. */
		public static Inputs of(@Nullable JsonObject o) {
			if (o == null) {
				return NONE;
			}
			return new Inputs(first(o, "wood"), first(o, "stone", "stoneName"), first(o, "roof", "roofName"), first(o, "accent", "accentWood"));
		}
	}

	public static final List<String> FIELDS = List.of("wood", "stone", "roof", "accent");

	/** The kit's phase 1 presets and lists, for a jar built without node (the build normally generates palettes.json). */
	public static final Palettes FALLBACK = new Palettes(fallbackPresets(),
		List.of("oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "pale_oak", "bamboo", "crimson", "warped"),
		List.of("cobblestone", "mossy_cobblestone", "stone_bricks", "mossy_stone_bricks", "deepslate_bricks", "deepslate_tiles", "cobbled_deepslate",
			"bricks", "sandstone", "smooth_sandstone", "polished_andesite", "blackstone", "polished_blackstone_bricks", "nether_bricks", "mud_bricks"),
		List.of("oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry", "crimson", "warped", "deepslate_tiles", "bricks",
			"stone_bricks", "cobblestone", "smooth_sandstone", "nether_bricks", "mud_bricks", "blackstone"),
		"built-in");

	private static Map<String, Inputs> fallbackPresets() {
		Map<String, Inputs> m = new LinkedHashMap<>();
		m.put("rustic", new Inputs("spruce", "cobblestone", "dark_oak", "dark_oak"));
		m.put("oak", new Inputs("oak", "stone_bricks", "spruce", "spruce"));
		m.put("birch", new Inputs("birch", "polished_andesite", "dark_oak", "dark_oak"));
		m.put("dark", new Inputs("dark_oak", "deepslate_bricks", "deepslate_tiles", "spruce"));
		m.put("desert", new Inputs("jungle", "sandstone", "smooth_sandstone", "jungle"));
		m.put("brick", new Inputs("oak", "bricks", "deepslate_tiles", "dark_oak"));
		return m;
	}

	public Palettes {
		presets = java.util.Collections.unmodifiableMap(new LinkedHashMap<>(presets));
		woods = List.copyOf(woods);
		stones = List.copyOf(stones);
		roofs = List.copyOf(roofs);
	}

	/**
	 * Parses the JSON above. Presets may also be a list of {@code {name, ...inputs}} or carry an {@code inputs} object
	 * (the kit's describe tool). Lists missing in the JSON are filled from the presets plus {@link #FALLBACK}. Null when
	 * there is nothing usable.
	 */
	public static @Nullable Palettes parse(@Nullable JsonElement json, String origin) {
		if (json == null || !json.isJsonObject()) {
			return null;
		}
		JsonObject o = json.getAsJsonObject();
		Map<String, Inputs> presets = new LinkedHashMap<>();
		JsonElement p = o.has("presets") ? o.get("presets") : o.get("palettes");
		if (p != null && p.isJsonObject()) {
			for (var e : p.getAsJsonObject().entrySet()) {
				if (e.getValue().isJsonObject()) {
					presets.put(e.getKey(), inputsOf(e.getValue().getAsJsonObject()));
				}
			}
		} else if (p != null && p.isJsonArray()) {
			for (JsonElement e : p.getAsJsonArray()) {
				if (e.isJsonObject() && e.getAsJsonObject().has("name")) {
					presets.put(e.getAsJsonObject().get("name").getAsString(), inputsOf(e.getAsJsonObject()));
				}
			}
		}
		if (presets.isEmpty()) {
			return null;
		}
		List<String> woods = list(o, "woods");
		List<String> stones = list(o, "stones");
		List<String> roofs = list(o, "roofs");
		LinkedHashSet<String> w = new LinkedHashSet<>(woods.isEmpty() ? FALLBACK.woods : woods);
		LinkedHashSet<String> s = new LinkedHashSet<>(stones.isEmpty() ? FALLBACK.stones : stones);
		LinkedHashSet<String> r = new LinkedHashSet<>(roofs.isEmpty() ? FALLBACK.roofs : roofs);
		for (Inputs in : presets.values()) {
			addIf(w, in.wood());
			addIf(w, in.accent());
			addIf(s, in.stone());
			addIf(r, in.roof());
		}
		return new Palettes(presets, new ArrayList<>(w), new ArrayList<>(s), new ArrayList<>(r), origin);
	}

	private static Inputs inputsOf(JsonObject o) {
		return Inputs.of(o.has("inputs") && o.get("inputs").isJsonObject() ? o.getAsJsonObject("inputs") : o);
	}

	private static void addIf(LinkedHashSet<String> set, @Nullable String v) {
		if (v != null) {
			set.add(v);
		}
	}

	private static List<String> list(JsonObject o, String key) {
		List<String> out = new ArrayList<>();
		if (o.has(key) && o.get(key).isJsonArray()) {
			for (JsonElement e : o.getAsJsonArray(key)) {
				if (e.isJsonPrimitive()) {
					String s = shortName(e.getAsString());
					if (s != null) {
						out.add(s);
					}
				}
			}
		}
		return out;
	}

	/** The choices of an advanced dropdown: woods for wood and accent, stones, roofs. */
	public List<String> choices(String field) {
		return switch (field) {
			case "wood", "accent" -> woods;
			case "stone" -> stones;
			case "roof" -> roofs;
			default -> List.of();
		};
	}

	public @Nullable Inputs preset(@Nullable String name) {
		return name == null ? null : presets.get(name);
	}

	/** The preset whose inputs equal {@code in} (null fields compared as given), or null. */
	public @Nullable String presetMatching(Inputs in) {
		for (var e : presets.entrySet()) {
			if (e.getValue().equals(in)) {
				return e.getKey();
			}
		}
		return null;
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		JsonObject p = new JsonObject();
		presets.forEach((k, v) -> p.add(k, v.toJson()));
		o.add("presets", p);
		o.add("woods", array(woods));
		o.add("stones", array(stones));
		o.add("roofs", array(roofs));
		o.addProperty("origin", origin);
		return o;
	}

	private static JsonArray array(List<String> l) {
		JsonArray a = new JsonArray();
		l.forEach(a::add);
		return a;
	}

	static @Nullable String first(JsonObject o, String... keys) {
		for (String k : keys) {
			if (o.has(k) && o.get(k).isJsonPrimitive() && !o.get(k).getAsString().isBlank()) {
				return o.get(k).getAsString();
			}
		}
		return null;
	}

	static @Nullable String shortName(@Nullable String s) {
		if (s == null || s.isBlank()) {
			return null;
		}
		String t = s.strip();
		return t.startsWith("minecraft:") ? t.substring("minecraft:".length()) : t;
	}

	static boolean same(@Nullable String a, @Nullable String b) {
		return Objects.equals(a, b);
	}
}
