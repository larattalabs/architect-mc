package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * A style bible (docs/CONTRACT.md phase 4b "Style bible (A1)", "4b review folded in" item 6): an artifact separate from
 * library entries, in {@code <gameDir>/architect/bibles/<id>/} (the latest version at the top, every version in
 * {@code versions/<v>/}). The built-in bibles are the kit's palette presets (id = the preset name, version 1, no prose,
 * no sheet). Since 1.2.0.
 *
 * @param versions every installed version, ascending ({@code [1]} for a built-in one)
 * @param builtin a built-in bible (a palette preset)
 * @param scope {@code "building"} or {@code "settlement"} (the latter also fills the macro roles rock, surface, ...)
 * @param roles role -> vanilla block id ({@code wall, wall_alt, trim, roof, floor, frame, accent, light, glass, foundation,
 *     path} plus any extra named roles)
 * @param prose {@code bible.md}, for designers (absent for built-in bibles)
 * @param sheetPath the rendered sample sheet ({@code sheet.png}) for review, when it exists
 * @param components the component names of its {@code components.mjs} ({@code window, door_surround, lantern_post,
 *     roof_trim, chimney} plus what it adds)
 * @param owner who asked for it ({@code <modid>:<thing>}), absent = the player
 * @param ext the request's namespaced extra data (a copy)
 * @param format (since 1.6.0) the bible format: 1 (4b) or 2 (5a, with restraint)
 * @param restraint (since 1.6.0) its effective restraint (a format-1 bible: the defaults, its first 3 motifs as heroes)
 * @param archived (since 1.6.0) hidden from the pickers ({@link Bibles#archive}); its entries and re-skins are unaffected
 * @param critique (since 1.6.0) the sheet critique ({@code bible.json critique}: overall, scores, issues), when the bible job had
 *     one ({@link BibleRequest#sheetCritique})
 * @param tags (since 1.41.0, Style unification U1) a Style's tags (empty: none, e.g. a bible from before U1)
 * @param suggestedFeatures (since 1.41.0) the features a new design with this Style starts with ({@code DesignSpec.FEATURES} ids, at
 *     most 6)
 * @param blurb (since 1.41.0) one line for the Style browser, or empty
 * @param basedOn (since 1.41.0) the Style it started from (a duplicate, or a hand edit of a built-in), or empty
 * @param origin (since 1.41.0) who made it: {@code builtin}, {@code claude} (a bible job; also every installed bible from before U1) or
 *     {@code hand} ({@link Bibles#save})
 * @param parts (since NEXT, Style unification U5) the Style's OWN parts: the components that bible set mode uses. Empty = none: a
 *     built-in Style other than rustic (whose library the kit ships), a hand-made Style without added parts ({@link Bibles#addParts}).
 *     A Style without parts never runs set mode: a design naming it as its bible gets its roles and shape hints (the hybrid).
 *     {@link #components} keeps its earlier meaning (the names a set-mode design would import) for compatibility.
 *
 * <p>Ownership (U1): {@code owner} empty, or a player UUID, is the player's: editable in Architect's UI. Any other owner (a mod's,
 * e.g. Steward's {@code steward_mc:settlement/<id>}) is Duplicate-only there, and only that owner saves new versions of it. Every save adds a version;
 * a version that anything pins is never rewritten or removed.
 */
public record Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
	Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext, int format, Restraint restraint,
	boolean archived, Optional<JsonObject> critique, List<String> tags, List<String> suggestedFeatures, Optional<String> blurb,
	Optional<BiblePin> basedOn, String origin, List<String> parts) {
	/**
	 * The 1.41.0 constructor (no {@code parts}: a Claude-made bible's are its components, any other Style has none). Kept for binary
	 * compatibility.
	 */
	public Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
		Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext, int format, Restraint restraint,
		boolean archived, Optional<JsonObject> critique, List<String> tags, List<String> suggestedFeatures, Optional<String> blurb,
		Optional<BiblePin> basedOn, String origin) {
		this(id, name, version, versions, builtin, scope, roles, prose, sheetPath, components, owner, ext, format, restraint, archived, critique, tags,
			suggestedFeatures, blurb, basedOn, origin, "claude".equals(origin) || (origin == null || origin.isBlank()) && !builtin ? components : List.of());
	}

	/** The 1.6.0 constructor (no Style fields: origin builtin for a built-in one, else claude). Kept for binary compatibility. */
	public Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
		Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext, int format, Restraint restraint,
		boolean archived, Optional<JsonObject> critique) {
		this(id, name, version, versions, builtin, scope, roles, prose, sheetPath, components, owner, ext, format, restraint, archived, critique, List.of(),
			List.of(), Optional.empty(), Optional.empty(), builtin ? "builtin" : "claude", builtin ? List.of() : components);
	}

	/** Whether the Style has its own parts ({@link #parts}): only then can a design run in bible set mode with it. Since NEXT. */
	public boolean hasParts() {
		return !parts.isEmpty();
	}

	/**
	 * Whether Architect's UI may edit it rather than only duplicate it: not built in, and the player's ({@link #modOwned} false). Since
	 * 1.41.0.
	 */
	public boolean editable() {
		return !builtin && !modOwned();
	}

	/**
	 * Whether a mod owns it: an owner that is set and is not a player UUID (e.g. Steward's {@code steward_mc:settlement/<id>}). No owner,
	 * or a player UUID, is the player's. A mod-owned Style is Duplicate-only in Architect's UI, saved only by that owner, and its versions
	 * are never garbage-collected. Since 1.41.0.
	 */
	public boolean modOwned() {
		return isModOwner(owner.orElse(null));
	}

	/** The ownership rule of {@link #modOwned} for an owner string (null = none). Since 1.41.0. */
	public static boolean isModOwner(@org.jspecify.annotations.Nullable String owner) {
		return owner != null && !owner.isEmpty() && !owner.matches("(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
	}

	public Bible {
		tags = tags == null ? List.of() : List.copyOf(tags);
		suggestedFeatures = suggestedFeatures == null ? List.of() : List.copyOf(suggestedFeatures);
		blurb = blurb == null ? Optional.empty() : blurb;
		basedOn = basedOn == null ? Optional.empty() : basedOn;
		origin = origin == null || origin.isBlank() ? (builtin ? "builtin" : "claude") : origin;
		versions = List.copyOf(versions);
		roles = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(roles));
		components = List.copyOf(components);
		parts = parts == null ? List.of() : List.copyOf(parts);
		ext = ext == null ? new JsonObject() : ext;
		format = format == 2 ? 2 : 1;
		restraint = restraint == null ? Restraint.DEFAULT : restraint;
		critique = critique == null ? Optional.empty() : critique;
	}

	/** The 1.2.0 constructor (format 1, the default restraint, not archived). */
	public Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
		Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext) {
		this(id, name, version, versions, builtin, scope, roles, prose, sheetPath, components, owner, ext, 1, Restraint.DEFAULT, false, Optional.empty());
	}

	/**
	 * A bible's restraint (docs/CONTRACT.md "Bible-set clutter", bible format 2): a bible is a restraint as much as a palette.
	 * Since 1.6.0.
	 *
	 * @param heroMotifs at most 3 of its motifs, on every building (other motifs at most once per building)
	 * @param accentShareMax the most of a design's cells in accent roles, 0.04-0.20 (default 0.12)
	 * @param detailDensity {@code sparse | moderate | rich} (default moderate)
	 * @param windowsPerFacadeMin readable windows per facade (default 2)
	 */
	public record Restraint(List<String> heroMotifs, double accentShareMax, String detailDensity, int windowsPerFacadeMin) {
		public static final Restraint DEFAULT = new Restraint(List.of(), 0.12, "moderate", 2);

		public Restraint {
			heroMotifs = heroMotifs == null ? List.of() : List.copyOf(heroMotifs);
			detailDensity = detailDensity == null ? "moderate" : detailDensity;
		}
	}

	public BiblePin pin() {
		return new BiblePin(id, version);
	}
}
