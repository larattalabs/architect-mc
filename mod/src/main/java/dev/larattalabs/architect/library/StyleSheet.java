package dev.larattalabs.architect.library;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) A Style's preview sheet: a small house elevation, every part painted with one of the Style's roles. The Style
 * browser's cards and detail pane, the Style editor and the Materials rows draw it. Theming rule (AGENTS.md "Everything generated is
 * themed"): a part whose role the Style lacks takes the nearest role it has ({@link #FALLBACK}), never a fixed block; the sky is the
 * UI's, and the ground is the {@code surface} role when the Style names one. Geometry is in a {@value #W} x {@value #H} canvas the client
 * scales. Pure.
 */
public final class StyleSheet {
	public static final int W = 100;
	public static final int H = 60;

	/** A part of the sheet: the role asked for, the role (and block) it was painted with, and where. {@code shade}: -1 darker .. +1 lighter. */
	public record Part(String part, String role, String block, int x, int y, int w, int h, int shade) {
	}

	/** Each part's role, then the roles it falls back to, nearest first. */
	static final Map<String, List<String>> FALLBACK = Map.ofEntries(
		Map.entry("surface", List.of()),
		Map.entry("path", List.of("foundation", "trim", "wall")),
		Map.entry("foundation", List.of("trim", "wall")),
		Map.entry("wall", List.of("wall_alt", "frame", "foundation")),
		Map.entry("wall_alt", List.of("wall", "trim")),
		Map.entry("frame", List.of("accent", "wall")),
		Map.entry("trim", List.of("foundation", "frame", "wall")),
		Map.entry("roof", List.of("trim", "accent", "wall")),
		Map.entry("accent", List.of("frame", "wall")),
		Map.entry("glass", List.of("wall_alt", "wall")),
		Map.entry("light", List.of("accent", "frame")));

	private StyleSheet() {
	}

	/** The role a part is painted with: its own when the Style has it, else the nearest fallback it has, else null (not drawn). */
	public static @Nullable String roleFor(String part, Map<String, String> roles) {
		if (roles.containsKey(part)) {
			return part;
		}
		for (String r : FALLBACK.getOrDefault(part, List.of())) {
			if (roles.containsKey(r)) {
				return r;
			}
		}
		return null;
	}

	/** The sheet's parts, back to front. */
	public static List<Part> parts(Map<String, String> roles) {
		List<Part> out = new ArrayList<>();
		// the ground, only from a role (a settlement Style's surface)
		add(out, roles, "surface", 0, 52, W, 8, 0);
		add(out, roles, "path", 43, 52, 14, 8, -1);
		add(out, roles, "foundation", 18, 46, 64, 6, 0);
		add(out, roles, "wall", 22, 26, 56, 20, 0);
		// the gable infill and the two storeys' beam
		add(out, roles, "wall_alt", 30, 22, 40, 4, 1);
		add(out, roles, "frame", 22, 34, 56, 2, -1);
		add(out, roles, "frame", 20, 26, 3, 20, -1);
		add(out, roles, "frame", 77, 26, 3, 20, -1);
		add(out, roles, "frame", 49, 26, 2, 8, -1);
		// windows and the door
		add(out, roles, "glass", 28, 28, 9, 5, 1);
		add(out, roles, "glass", 63, 28, 9, 5, 1);
		add(out, roles, "glass", 29, 38, 7, 5, 1);
		add(out, roles, "accent", 45, 37, 10, 9, 0);
		add(out, roles, "light", 58, 38, 2, 3, 1);
		// eaves, then the roof in steps (the top lighter: the light from above)
		add(out, roles, "trim", 14, 24, 72, 2, -1);
		int steps = 6;
		for (int i = 0; i < steps; i++) {
			int inset = 4 + i * 6;
			add(out, roles, "roof", 14 + inset - 4, 21 - i * 3, 72 - 2 * (inset - 4), 3, i >= steps - 2 ? 1 : i == 0 ? -1 : 0);
		}
		return out;
	}

	private static void add(List<Part> out, Map<String, String> roles, String part, int x, int y, int w, int h, int shade) {
		String role = roleFor(part, roles);
		if (role == null || w <= 0 || h <= 0) {
			return;
		}
		out.add(new Part(part, role, roles.get(role), x, y, w, h, shade));
	}
}
