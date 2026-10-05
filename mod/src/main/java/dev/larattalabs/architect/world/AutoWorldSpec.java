package dev.larattalabs.architect.world;

import java.util.Locale;
import java.util.function.Function;

/**
 * Which world the dev client's AutoWorld opens or creates (pure; unit-tested in AutoWorldSpecTest).
 *
 * <pre>
 * ARCHITECT_AUTOWORLD_NAME    world (folder and level) name, default "Architect Dev"
 * ARCHITECT_AUTOWORLD_PRESET  normal (default: natural terrain, for placement on uneven ground) | flat (a superflat meadow)
 * ARCHITECT_AUTOWORLD_SEED    seed for a new world (number, or any text hashed like the vanilla seed box);
 *                              default: "architect-dev".hashCode() for flat, {@link #DEFAULT_NATURAL_SEED} for normal
 * </pre>
 *
 * An existing world is loaded as it is (preset and seed only apply when it is created).
 */
public record AutoWorldSpec(String name, Preset preset, long seed) {
	public enum Preset { FLAT, NORMAL }

	/** Natural-terrain default: spawn in a birch meadow on a hill (y~118), forest, lakes and a cherry grove within ~150 blocks. */
	public static final long DEFAULT_NATURAL_SEED = 2026L;
	public static final long DEFAULT_FLAT_SEED = "architect-dev".hashCode();
	/** The dev world's default name. */
	public static final String DEFAULT_NAME = "Architect Dev";

	/** Reads the three switches through {@code raw} (env var name -> trimmed value or null). */
	public static AutoWorldSpec from(Function<String, String> raw) {
		String name = raw.apply("ARCHITECT_AUTOWORLD_NAME");
		name = name == null || name.isBlank() ? DEFAULT_NAME : name.trim();
		if (!validName(name)) {
			throw new IllegalArgumentException("ARCHITECT_AUTOWORLD_NAME must be 1-64 characters without / \\ : * ? \" < > | or a leading dot: " + name);
		}
		String p = raw.apply("ARCHITECT_AUTOWORLD_PRESET");
		Preset preset = switch (p == null ? "normal" : p.trim().toLowerCase(Locale.ROOT)) {
			case "", "flat", "superflat" -> Preset.FLAT;
			case "normal", "natural", "default" -> Preset.NORMAL;
			default -> throw new IllegalArgumentException("ARCHITECT_AUTOWORLD_PRESET must be flat or normal: " + p);
		};
		String s = raw.apply("ARCHITECT_AUTOWORLD_SEED");
		long seed = s == null || s.isBlank() ? (preset == Preset.FLAT ? DEFAULT_FLAT_SEED : DEFAULT_NATURAL_SEED) : parseSeed(s.trim());
		return new AutoWorldSpec(name, preset, seed);
	}

	/** Like the vanilla "Seed" box: a number is used as is, other text is hashed. */
	public static long parseSeed(String s) {
		try {
			return Long.parseLong(s);
		} catch (NumberFormatException e) {
			return s.hashCode();
		}
	}

	static boolean validName(String name) {
		if (name.isEmpty() || name.length() > 64 || name.startsWith(".") || name.endsWith(" ") || name.endsWith(".")) {
			return false;
		}
		for (char c : name.toCharArray()) {
			if (c < 32 || "/\\:*?\"<>|".indexOf(c) >= 0) {
				return false;
			}
		}
		return true;
	}

}
