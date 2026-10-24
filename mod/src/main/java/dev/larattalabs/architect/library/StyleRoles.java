package dev.larattalabs.architect.library;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The Style fan-out (Style unification U0, docs/STYLE-UNIFY.md §1): how the four main rows (Wood / Stone / Roof / Accent) fill
 * a Style's roles, read back from them and are edited. The Java twin of {@code kit/lib/styles.mjs} {@code mainOf},
 * {@code editMain}, {@code provenanceOf} and {@code fanOut}, driven by the kit's table ({@code styleTable()}, the
 * {@code styles} member of {@code palettes.json}): the mod has no node. {@code StyleRolesTest} replays the kit's parity cases
 * ({@code kit/test/fixtures/style-parity.json}). Role ids are {@code minecraft:}-qualified; main rows are short names. Pure.
 */
public final class StyleRoles {
	public static final List<String> MAIN_FIELDS = List.of("wood", "stone", "roof", "accent");
	/** Provenance tags: set by the Style, following a main row, or set by hand. */
	public static final String STYLE = "style";
	public static final String FOLLOWS_WOOD = "follows_wood";
	public static final String FOLLOWS_STONE = "follows_stone";
	public static final String HAND = "hand";
	private static final Pattern VALUE = Pattern.compile("[a-z0-9_:]+");

	private final Map<String, List<String>> fanOut = new LinkedHashMap<>();
	private final Map<String, String> fixed = new LinkedHashMap<>();
	private final List<String> darkWoods = new ArrayList<>();
	private final Map<String, String> partOfRole = new LinkedHashMap<>();
	private final List<String> parts = new ArrayList<>();
	private final Map<String, Map<String, String>> woods = new LinkedHashMap<>();
	private final Map<String, String> woodOf = new LinkedHashMap<>();
	private final Map<String, String> stoneOf = new LinkedHashMap<>();
	/** block -> trim (a full block) or "" (stairs and slab, not a full block) */
	private final Map<String, String> stairsSlab = new LinkedHashMap<>();
	private final Map<String, String> fullOf = new LinkedHashMap<>();

	private static volatile @Nullable StyleRoles fallback;

	/** From the kit's table ({@code palettes.json} {@code styles}); throws when it is not one. */
	public StyleRoles(JsonObject t) {
		if (!t.has("woods") || !t.has("stairsSlab") || !t.has("fanOut")) {
			throw new IllegalArgumentException("not a Style fan-out table (no woods / stairsSlab / fanOut)");
		}
		for (var e : t.getAsJsonObject("fanOut").entrySet()) {
			List<String> l = new ArrayList<>();
			e.getValue().getAsJsonArray().forEach(x -> l.add(x.getAsString()));
			fanOut.put(e.getKey(), List.copyOf(l));
		}
		strings(t.getAsJsonObject("fixed"), fixed);
		if (t.has("darkWoods")) {
			t.getAsJsonArray("darkWoods").forEach(x -> darkWoods.add(x.getAsString()));
		}
		strings(t.getAsJsonObject("woodPartOfRole"), partOfRole);
		t.getAsJsonArray("woodParts").forEach(x -> parts.add(x.getAsString()));
		for (var e : t.getAsJsonObject("woods").entrySet()) {
			Map<String, String> m = new LinkedHashMap<>();
			for (var p : e.getValue().getAsJsonObject().entrySet()) {
				if (p.getValue().isJsonPrimitive()) {
					m.put(p.getKey(), p.getValue().getAsString());
				}
			}
			woods.put(e.getKey(), Collections.unmodifiableMap(m));
		}
		strings(t.getAsJsonObject("woodOf"), woodOf);
		strings(t.getAsJsonObject("stoneOf"), stoneOf);
		for (var e : t.getAsJsonObject("stairsSlab").entrySet()) {
			JsonObject o = e.getValue().getAsJsonObject();
			boolean cube = o.has("cube") && o.get("cube").getAsBoolean();
			stairsSlab.put(e.getKey(), cube && o.has("trim") ? o.get("trim").getAsString() : "");
		}
		strings(t.getAsJsonObject("fullOf"), fullOf);
	}

	private static void strings(@Nullable JsonObject o, Map<String, String> into) {
		if (o == null) {
			return;
		}
		for (var e : o.entrySet()) {
			if (e.getValue().isJsonPrimitive()) {
				into.put(e.getKey(), e.getValue().getAsString());
			}
		}
	}

	/** The table of a {@code palettes.json} (its {@code styles} member), or null. */
	public static @Nullable StyleRoles of(@Nullable JsonElement palettesJson) {
		if (palettesJson == null || !palettesJson.isJsonObject() || !palettesJson.getAsJsonObject().has("styles")) {
			return null;
		}
		try {
			return new StyleRoles(palettesJson.getAsJsonObject().getAsJsonObject("styles"));
		} catch (RuntimeException e) {
			return null;
		}
	}

	/** The table checked in with the mod ({@code assets/architect_mc/palettes-fallback.json}, generated from the kit). */
	public static StyleRoles fallback() {
		StyleRoles f = fallback;
		if (f == null) {
			JsonElement j = Palettes.fallbackJson();
			f = of(j);
			if (f == null) {
				throw new IllegalStateException("the mod's palettes-fallback.json has no Style table");
			}
			fallback = f;
		}
		return f;
	}

	/** The woods with a full set. */
	public List<String> woods() {
		return List.copyOf(woods.keySet());
	}

	/** Which roles each main row drives ({@code wood -> [wall, frame, floor]}, ...). */
	public Map<String, List<String>> fanOutRoles() {
		return Collections.unmodifiableMap(fanOut);
	}

	static String qualify(String b) {
		String s = b.strip();
		return s.contains(":") ? s : "minecraft:" + s;
	}

	static String shortOf(String b) {
		return b.startsWith("minecraft:") ? b.substring("minecraft:".length()) : b;
	}

	private String fullBlockOf(String b) {
		String q = qualify(b);
		return fullOf.getOrDefault(q, q);
	}

	public boolean isStoneBlock(@Nullable String b) {
		if (b == null) {
			return false;
		}
		String t = stairsSlab.get(qualify(b));
		return t != null && !t.isEmpty();
	}

	public boolean isRoofBlock(@Nullable String b) {
		return b != null && stairsSlab.containsKey(qualify(b));
	}

	private String trimOf(String stone) {
		String t = stairsSlab.get(qualify(stone));
		return t == null || t.isEmpty() ? qualify(stone) : t;
	}

	private @Nullable String woodFamilyOf(@Nullable String b) {
		return b == null ? null : woodOf.get(qualify(b));
	}

	private @Nullable String woodName(@Nullable String b) {
		if (b == null) {
			return null;
		}
		String s = shortOf(qualify(b));
		return woods.containsKey(s) ? s : woodFamilyOf(b);
	}

	private boolean sameStone(String block, String stone) {
		String fam = stoneOf.get(qualify(stone));
		return fam != null ? fam.equals(stoneOf.get(qualify(block))) : fullBlockOf(block).equals(qualify(stone));
	}

	/** The four main rows of these roles (kit mainOf): what {@code palette({bible: {roles}})} derives. */
	public Palettes.Inputs mainOf(Map<String, String> roles) {
		String wood = "oak";
		for (String k : List.of("wood", "frame", "accent", "floor", "wall", "wall_alt", "roof")) {
			String w = woodName(roles.get(k));
			if (w != null) {
				wood = w;
				break;
			}
		}
		String stone = "minecraft:cobblestone";
		for (String k : List.of("foundation", "wall", "trim", "wall_alt")) {
			String b = roles.get(k);
			if (b != null && isStoneBlock(fullBlockOf(b))) {
				stone = fullBlockOf(b);
				break;
			}
		}
		String roofBlock = roles.get("roof") != null ? fullBlockOf(roles.get("roof")) : "minecraft:dark_oak_planks";
		String rw = woodName(roofBlock);
		String roof = rw != null && roofBlock.equals("minecraft:" + rw + "_planks") ? rw : shortOf(roofBlock);
		String accent = woodName(roles.get("accent"));
		return new Palettes.Inputs(wood, shortOf(stone), roof, accent != null ? accent : wood);
	}

	/** The main row a role still follows ({@code wood} or {@code stone}), or null. */
	public @Nullable String follows(Map<String, String> roles, String role) {
		String b = roles.get(role);
		if (b == null) {
			return null;
		}
		if (fanOut.getOrDefault("wood", List.of()).contains(role)) {
			String w = woodFamilyOf(b);
			return w != null && w.equals(mainOf(roles).wood()) ? "wood" : null;
		}
		if (fanOut.getOrDefault("stone", List.of()).contains(role)) {
			return sameStone(b, mainOf(roles).stone()) ? "stone" : null;
		}
		return null;
	}

	/**
	 * One main row changed (kit editMain): the roles it drives that still follow it are re-derived; every other role stays. A new
	 * map in the input's order; throws {@link IllegalArgumentException} when the value cannot be that row.
	 */
	public Map<String, String> editMain(Map<String, String> roles, String field, String value) {
		if (!MAIN_FIELDS.contains(field)) {
			throw new IllegalArgumentException("editMain: field must be one of " + String.join(", ", MAIN_FIELDS) + " (got " + field + ")");
		}
		Map<String, String> q = new LinkedHashMap<>();
		roles.forEach((k, v) -> q.put(k, qualify(v)));
		Palettes.Inputs main = mainOf(q);
		List<String> following = new ArrayList<>();
		if (field.equals("wood")) {
			for (String role : fanOut.getOrDefault("wood", List.of())) {
				if (q.get(role) != null && main.wood().equals(woodFamilyOf(q.get(role)))) {
					following.add(role);
				}
			}
		} else if (field.equals("stone")) {
			for (String role : fanOut.getOrDefault("stone", List.of())) {
				if (q.get(role) != null && sameStone(q.get(role), main.stone())) {
					following.add(role);
				}
			}
		}
		return editMainFrom(roles, field, value, main.get(field), following);
	}

	/**
	 * (Style unification U2) The core of {@link #editMain} with the row's old value and the roles that follow it given (kit
	 * {@code editMainFrom}), not read back from the roles: {@link StyleForm} stores both, so a role set by hand never moves a main row.
	 */
	public Map<String, String> editMainFrom(Map<String, String> roles, String field, String value, @Nullable String old,
		java.util.Collection<String> following) {
		if (!MAIN_FIELDS.contains(field)) {
			throw new IllegalArgumentException("editMain: field must be one of " + String.join(", ", MAIN_FIELDS) + " (got " + field + ")");
		}
		if (value == null || !VALUE.matcher(value).matches()) {
			throw new IllegalArgumentException("editMain: " + field + " must be a wood or block name");
		}
		Map<String, String> out = new LinkedHashMap<>();
		roles.forEach((k, v) -> out.put(k, qualify(v)));
		String v = shortOf(value);
		switch (field) {
			case "wood", "accent" -> {
				if (!woods.containsKey(v)) {
					throw new IllegalArgumentException("editMain: unknown wood '" + value + "' (one of " + String.join(", ", woods.keySet()) + ")");
				}
				if (field.equals("accent")) {
					out.put("accent", woods.get(v).get("planks"));
					return out;
				}
				Map<String, String> from = old == null ? Map.of() : woods.getOrDefault(shortOf(old), Map.of());
				Map<String, String> to = woods.get(v);
				for (String role : fanOut.getOrDefault("wood", List.of())) {
					String b = out.get(role);
					if (b == null || !following.contains(role)) {
						continue;
					}
					String part = partOfRole.get(role);
					for (String p : parts) {
						if (b.equals(from.get(p))) {
							part = p;
							break;
						}
					}
					String nb = to.get(part);
					out.put(role, nb != null ? nb : to.get(partOfRole.get(role)));
				}
			}
			case "stone" -> {
				String s = qualify(v);
				if (!isStoneBlock(s)) {
					throw new IllegalArgumentException("editMain: stone '" + value + "' is not a full vanilla block with stairs and slab variants");
				}
				for (String role : fanOut.getOrDefault("stone", List.of())) {
					if (out.get(role) == null || !following.contains(role)) {
						continue;
					}
					out.put(role, role.equals("foundation") ? s : trimOf(s));
				}
			}
			default -> {
				String roof = woods.containsKey(v) ? "minecraft:" + v + "_planks" : qualify(v);
				if (!isRoofBlock(roof)) {
					throw new IllegalArgumentException("editMain: roof '" + value + "' has no stairs/slab variant (pick a wood, or a block with both)");
				}
				out.put("roof", roof);
			}
		}
		return out;
	}

	/** Each role's provenance (kit provenanceOf): follows_wood / follows_stone, else style (equal to {@code base}, or no base), else hand. */
	public Map<String, String> provenance(Map<String, String> roles, @Nullable Map<String, String> base) {
		Map<String, String> out = new LinkedHashMap<>();
		roles.forEach((role, b) -> {
			String f = follows(roles, role);
			if (f != null) {
				out.put(role, "follows_" + f);
			} else if (base == null || (base.get(role) != null && qualify(base.get(role)).equals(qualify(b)))) {
				out.put(role, STYLE);
			} else {
				out.put(role, HAND);
			}
		});
		return out;
	}

	/** The roles four inputs give with nothing else set (kit fanOut, = {@code palette(inputs).roles}); null inputs take the kit's defaults. */
	public Map<String, String> fanOut(Palettes.Inputs in) {
		String wood = in.wood() != null ? in.wood() : "oak";
		Map<String, String> w = woods.get(wood);
		if (w == null) {
			throw new IllegalArgumentException("unknown wood '" + wood + "'");
		}
		String s = qualify(in.stone() != null ? in.stone() : "cobblestone");
		String roofName = in.roof() != null ? in.roof() : darkWoods.contains(wood) ? (wood.equals("dark_oak") ? "spruce" : "dark_oak") : "dark_oak";
		String roofBlock = woods.containsKey(roofName) ? "minecraft:" + roofName + "_planks" : qualify(roofName);
		String acc = in.accent() != null ? in.accent() : woods.containsKey(roofName) ? roofName : wood;
		Map<String, String> a = woods.get(acc);
		Map<String, String> r = new LinkedHashMap<>();
		r.put("wall", w.get("planks"));
		r.put("wall_alt", fixed.get("wall_alt"));
		r.put("trim", trimOf(s));
		r.put("roof", roofBlock);
		r.put("floor", w.get("planks"));
		r.put("frame", w.get("log"));
		r.put("accent", a != null ? a.get("planks") : w.get("planks"));
		r.put("light", fixed.get("light"));
		r.put("glass", fixed.get("glass"));
		r.put("foundation", s);
		r.put("path", fixed.get("path"));
		return r;
	}

	static @Nullable JsonElement readResource(String path) {
		try (InputStream in = StyleRoles.class.getResourceAsStream(path)) {
			return in == null ? null : JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8));
		} catch (Exception e) {
			return null;
		}
	}
}
