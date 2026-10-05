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
 */
public record Bible(String id, String name, int version, List<Integer> versions, boolean builtin, String scope, Map<String, String> roles,
	Optional<String> prose, Optional<Path> sheetPath, List<String> components, Optional<String> owner, JsonObject ext) {
	public Bible {
		versions = List.copyOf(versions);
		roles = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(roles));
		components = List.copyOf(components);
		ext = ext == null ? new JsonObject() : ext;
	}

	public BiblePin pin() {
		return new BiblePin(id, version);
	}
}
