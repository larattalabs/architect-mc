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
 */
public record Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
	Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext, int format, Restraint restraint,
	boolean archived, Optional<JsonObject> critique) {
	public Bible {
		versions = List.copyOf(versions);
		roles = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(roles));
		components = List.copyOf(components);
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
