package dev.larattalabs.architect.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * The rules of a design request (docs/CONTRACT.md "Protocol", {@code DesignRequest}), shared by the Design tab and its
 * tests: the building types, the style and feature chips, the limits, the S/M/L size presets per type, validation with the
 * sidecar's limits, the exact JSON sent, and the geometry of a marked plot. Pure logic, no Minecraft classes.
 */
public final class DesignSpec {
	/** A choice: wire id, label, one-line description. */
	public record Choice(String id, String label, String description) {
	}

	public static final List<Choice> TYPES = List.of(
		new Choice("house", "House", "a family home"),
		new Choice("cabin", "Cabin", "one or two rooms, cosy"),
		new Choice("cottage", "Cottage", "small, low, a garden feel"),
		new Choice("tower", "Tower", "tall, several floors"),
		new Choice("shop", "Shop", "a counter and a display front"),
		new Choice("tavern", "Tavern", "a hall with tables and a bar"),
		new Choice("barn", "Barn", "a wide door, a big open floor"),
		new Choice("smithy", "Smithy", "a forge and an open work side"),
		new Choice("chapel", "Chapel", "a nave, tall windows"),
		new Choice("gatehouse", "Gatehouse", "a passage through the middle"),
		new Choice("custom", "Custom", "described by your notes"));

	/** Style chips. Any text up to {@value #MAX_STYLE} characters is allowed too. */
	public static final List<Choice> STYLES = List.of(
		new Choice("rustic", "Rustic", "logs, stone, timber"),
		new Choice("medieval", "Medieval", "timber frame, plaster, steep roofs"),
		new Choice("modern", "Modern", "glass, concrete, flat roofs"),
		new Choice("fantasy", "Fantasy", "curves, colour, odd shapes"),
		new Choice("nordic", "Nordic", "dark wood, steep roofs"),
		new Choice("japanese", "Japanese", "light wood, paper walls, wide eaves"),
		new Choice("desert", "Desert", "sandstone, flat roofs, shade"),
		new Choice("cozy", "Cozy", "small windows, warm light"));

	/** Feature chips (at most {@value #MAX_FEATURES}). */
	public static final List<Choice> FEATURES = List.of(
		new Choice("porch", "Porch", "a covered porch at the entrance"),
		new Choice("chimney", "Chimney", "a fireplace and a chimney"),
		new Choice("balcony", "Balcony", "an upper-floor balcony"),
		new Choice("garden", "Garden", "planted ground around it"),
		new Choice("skylights", "Skylights", "light from the roof"),
		new Choice("courtyard", "Courtyard", "an open court inside"),
		new Choice("big_windows", "Big windows", "tall windows"),
		new Choice("basement", "Basement", "a floor below the ground"));

	/**
	 * The checker rules an open type's profile picks from (phase 4b, R4): the plain ones and a few parametrised examples
	 * ({@code min_interior_volume:<n>}, {@code passage:<w>x<h>}, {@code tall:<ratio>} take any value the pattern allows).
	 */
	public static final List<Choice> PROFILE_RULES = List.of(
		new Choice("door", "door", "an entrance a player can walk through"),
		new Choice("roof_closed", "roof closed", "no hole in the roof"),
		new Choice("floors_reachable", "floors reachable", "every floor reachable by stairs or ladders"),
		new Choice("lit", "lit", "no dark interior cells (needs interior)"),
		new Choice("no_floating", "no floating", "nothing hangs in the air"),
		new Choice("interior", "interior", "an enclosed interior"),
		new Choice("min_interior_volume:200", "volume ≥ 200", "at least 200 interior cells"),
		new Choice("passage:3x4", "passage 3×4", "a passage at least 3 wide and 4 high"),
		new Choice("tall:2", "tall ×2", "at least twice as tall as wide"));
	/** A non-preset type without a profile gets these. */
	public static final List<String> DEFAULT_PROFILE = List.of("door", "lit", "no_floating");
	/** An open type ({@code hellish_lair}). */
	public static final Pattern OPEN_TYPE = Blueprint.OPEN_TYPE;
	/** One profile rule. */
	public static final Pattern PROFILE_RULE = Pattern.compile(
		"door|roof_closed|floors_reachable|lit|no_floating|interior|min_interior_volume:\\d{1,5}|passage:\\d{1,2}x\\d{1,2}|tall:\\d+(\\.\\d+)?");
	public static final int MAX_PROFILE = 12;

	/** Whether {@code type} is one of the 11 preset types. */
	public static boolean isPreset(@Nullable String type) {
		return find(TYPES, type) != null;
	}

	/** Size choices of the form: presets, a marked plot, or a custom limit. */
	public static final List<String> SIZES = List.of("S", "M", "L", "plot", "custom");

	public static final int MIN_XZ = 7;
	public static final int MAX_XZ = 96;
	public static final int MIN_Y = 6;
	public static final int MAX_Y = 64;
	public static final int DEFAULT_PLOT_HEIGHT = 16;
	public static final int MAX_STYLE = 40;
	public static final int MAX_MATERIALS = 200;
	public static final int MAX_FEATURES = 6;
	public static final int MAX_NAME = 40;
	public static final int MAX_NOTES = 2000;
	private static final Pattern FEATURE_ID = Pattern.compile("[a-z][a-z0-9_]{0,31}");

	private DesignSpec() {
	}

	public static @Nullable Choice find(List<Choice> list, @Nullable String id) {
		for (Choice c : list) {
			if (c.id().equals(id)) {
				return c;
			}
		}
		return null;
	}

	public static List<String> ids(List<Choice> list) {
		return list.stream().map(Choice::id).toList();
	}

	// ------------------------------------------------------------------ size presets

	/**
	 * The size limit {x, y, z} of preset {@code size} (S, M or L) for a building type, in the template's frame (x along the
	 * entrance side). Most types: S 13x10x13, M 21x14x21, L 33x20x33. A tower is narrow and tall (S 9x18x9, M 11x26x11,
	 * L 15x36x15); a barn, tavern or chapel is a bit larger (S 17x12x17, M 25x16x29, L 37x22x41).
	 */
	public static int[] preset(String size, String type) {
		String s = size.toUpperCase(Locale.ROOT);
		int i = switch (s) {
			case "S" -> 0;
			case "M" -> 1;
			case "L" -> 2;
			default -> throw new IllegalArgumentException("size must be S, M or L");
		};
		int[][] table = switch (type) {
			case "tower" -> new int[][] {{9, 18, 9}, {11, 26, 11}, {15, 36, 15}};
			case "barn", "tavern", "chapel" -> new int[][] {{17, 12, 17}, {25, 16, 29}, {37, 22, 41}};
			default -> new int[][] {{13, 10, 13}, {21, 14, 21}, {33, 20, 33}};
		};
		return table[i].clone();
	}

	public static int clampXZ(int v) {
		return Math.max(MIN_XZ, Math.min(MAX_XZ, v));
	}

	public static int clampY(int v) {
		return Math.max(MIN_Y, Math.min(MAX_Y, v));
	}

	// ------------------------------------------------------------------ validation

	/** What the form would send (blank strings mean "omitted"). */
	public record Draft(String type, String style, @Nullable String materials, List<String> features, int maxX, int maxY, int maxZ,
		@Nullable Plot plot, @Nullable String remix, @Nullable String name, @Nullable String notes, List<String> profile, @Nullable String bible) {
		public Draft {
			features = List.copyOf(features);
			profile = profile == null ? List.of() : List.copyOf(profile);
		}

		/** The phase 1-3 draft (a preset type, no profile, no bible). */
		public Draft(String type, String style, @Nullable String materials, List<String> features, int maxX, int maxY, int maxZ, @Nullable Plot plot,
			@Nullable String remix, @Nullable String name, @Nullable String notes) {
			this(type, style, materials, features, maxX, maxY, maxZ, plot, remix, name, notes, List.of(), null);
		}
	}

	/**
	 * Field -> problem, in form order (empty = the sidecar accepts it). Field keys: type, style, materials, features, maxSize,
	 * remix, name, notes.
	 */
	public static Map<String, String> validate(Draft d) {
		Map<String, String> e = new LinkedHashMap<>();
		if (blank(d.type())) {
			e.put("type", "pick a building type, or type your own");
		} else if (!isPreset(d.type()) && !OPEN_TYPE.matcher(d.type()).matches()) {
			e.put("type", "your own type: a-z, 0-9 and _, starting with a letter, at most 40 (e.g. hellish_lair)");
		} else if (!isPreset(d.type())) {
			if (d.profile().size() > MAX_PROFILE) {
				e.put("type", "at most " + MAX_PROFILE + " profile rules");
			}
			for (String r : d.profile()) {
				if (!PROFILE_RULE.matcher(r).matches()) {
					e.put("type", "unknown profile rule " + r);
					break;
				}
			}
		}
		if (blank(d.style())) {
			e.put("style", "pick a style or type one");
		} else if (d.style().strip().length() > MAX_STYLE) {
			e.put("style", "at most " + MAX_STYLE + " characters (" + d.style().strip().length() + ")");
		}
		if (!blank(d.materials()) && d.materials().strip().length() > MAX_MATERIALS) {
			e.put("materials", "at most " + MAX_MATERIALS + " characters (" + d.materials().strip().length() + ")");
		}
		Set<String> seen = new HashSet<>();
		for (String f : d.features()) {
			if (!FEATURE_ID.matcher(f).matches()) {
				e.put("features", "bad feature id " + f);
				break;
			}
			if (!seen.add(f)) {
				e.put("features", "duplicate feature " + f);
				break;
			}
		}
		if (!e.containsKey("features") && d.features().size() > MAX_FEATURES) {
			e.put("features", "at most " + MAX_FEATURES + " features (" + d.features().size() + ")");
		}
		List<String> size = new ArrayList<>();
		if (d.maxX() < MIN_XZ || d.maxX() > MAX_XZ) {
			size.add("width " + d.maxX() + " is outside " + MIN_XZ + ".." + MAX_XZ);
		}
		if (d.maxY() < MIN_Y || d.maxY() > MAX_Y) {
			size.add("height " + d.maxY() + " is outside " + MIN_Y + ".." + MAX_Y);
		}
		if (d.maxZ() < MIN_XZ || d.maxZ() > MAX_XZ) {
			size.add("depth " + d.maxZ() + " is outside " + MIN_XZ + ".." + MAX_XZ);
		}
		if (!size.isEmpty()) {
			e.put("maxSize", String.join("; ", size));
		}
		if (!blank(d.remix()) && !Blueprint.ID.matcher(d.remix().strip()).matches()) {
			e.put("remix", "a library id (a-z, 0-9, _)");
		}
		if (!blank(d.name()) && d.name().strip().length() > MAX_NAME) {
			e.put("name", "at most " + MAX_NAME + " characters (" + d.name().strip().length() + ")");
		}
		if (d.notes() != null && d.notes().length() > MAX_NOTES) {
			e.put("notes", "at most " + MAX_NOTES + " characters (" + d.notes().length() + ")");
		}
		return e;
	}

	/**
	 * The {@code DesignRequest} JSON exactly as sent (docs/CONTRACT.md "Protocol"): optional fields are omitted when blank,
	 * never null; strings are stripped. Call after {@link #validate} found nothing.
	 */
	public static JsonObject requestJson(Draft d) {
		JsonObject r = new JsonObject();
		r.addProperty("type", d.type());
		r.addProperty("style", d.style().strip());
		if (!blank(d.materials())) {
			r.addProperty("materials", d.materials().strip());
		}
		JsonArray f = new JsonArray();
		d.features().forEach(f::add);
		r.add("features", f);
		JsonObject size = new JsonObject();
		size.addProperty("x", d.maxX());
		size.addProperty("y", d.maxY());
		size.addProperty("z", d.maxZ());
		r.add("maxSize", size);
		if (d.plot() != null) {
			r.add("plot", d.plot().toJson());
		}
		if (!blank(d.remix())) {
			r.addProperty("remix", d.remix().strip());
		}
		if (!blank(d.name())) {
			r.addProperty("name", d.name().strip());
		}
		if (!blank(d.notes()) ) {
			r.addProperty("notes", d.notes());
		}
		if (!isPreset(d.type())) {
			JsonArray p = new JsonArray();
			(d.profile().isEmpty() ? DEFAULT_PROFILE : d.profile()).forEach(p::add);
			r.add("profile", p);
		}
		if (!blank(d.bible())) {
			r.addProperty("bible", d.bible().strip());
		}
		return r;
	}

	public static boolean blank(@Nullable String s) {
		return s == null || s.isBlank();
	}

	// ------------------------------------------------------------------ plots

	/**
	 * A marked plot: the world rectangle {@code minX..minX+dx-1, minZ..minZ+dz-1} on the ground at {@code y} (the surface:
	 * the first open block above the ground), a height limit, the side facing the player who marked it ({@code front}, where
	 * the entrance should go) and the dimension.
	 */
	public record Plot(int minX, int y, int minZ, int dx, int dz, int height, String front, String dimension) {
		/** The plot spanned by two corner blocks (inclusive); the ground is the lower of the two corners' surfaces. */
		public static Plot of(int x1, int y1, int z1, int x2, int y2, int z2, int height, String front, String dimension) {
			return new Plot(Math.min(x1, x2), Math.min(y1, y2), Math.min(z1, z2), Math.abs(x2 - x1) + 1, Math.abs(z2 - z1) + 1, height, front,
				dimension);
		}

		public int maxX() {
			return minX + dx - 1;
		}

		public int maxZ() {
			return minZ + dz - 1;
		}

		/** Length of the entrance side (along the front) and the depth behind it. */
		public int width() {
			return frontAlongX() ? dx : dz;
		}

		public int depth() {
			return frontAlongX() ? dz : dx;
		}

		private boolean frontAlongX() {
			return front.equals("north") || front.equals("south");
		}

		/** The design's size limit {x, y, z} in the template's own frame (x along the entrance side), clamped to the limits. */
		public int[] maxSize() {
			return new int[] {clampXZ(width()), clampY(height), clampXZ(depth())};
		}

		public boolean tooSmall() {
			return dx < MIN_XZ || dz < MIN_XZ;
		}

		public boolean tooLarge() {
			return dx > MAX_XZ || dz > MAX_XZ;
		}

		/**
		 * Where a design goes on this plot: {ox, oy, oz, turns}: rotated so its entrance faces {@link #front}, its rotated
		 * footprint centred on the plot, its ground row on the plot's surface.
		 */
		public int[] placement(String bpFront, int sizeX, int sizeZ, int groundY) {
			int turns = BlueprintTransform.turnsToFace(bpFront, front);
			int rsx = BlueprintTransform.rotatedSizeX(sizeX, sizeZ, turns);
			int rsz = BlueprintTransform.rotatedSizeZ(sizeX, sizeZ, turns);
			return new int[] {minX + Math.floorDiv(dx - rsx, 2), y - groundY, minZ + Math.floorDiv(dz - rsz, 2), turns};
		}

		/** Whether that rotated footprint fits inside the plot. */
		public boolean fits(String bpFront, int sizeX, int sizeZ) {
			int turns = BlueprintTransform.turnsToFace(bpFront, front);
			return BlueprintTransform.rotatedSizeX(sizeX, sizeZ, turns) <= dx && BlueprintTransform.rotatedSizeZ(sizeX, sizeZ, turns) <= dz;
		}

		/** The plot as sent in a request (informational for the designer). */
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("minX", minX);
			o.addProperty("y", y);
			o.addProperty("minZ", minZ);
			o.addProperty("dx", dx);
			o.addProperty("dz", dz);
			o.addProperty("height", height);
			o.addProperty("front", front);
			o.addProperty("dimension", dimension);
			return o;
		}
	}
}
