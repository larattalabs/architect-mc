package dev.larattalabs.architect.region;

import java.util.Set;
import org.jspecify.annotations.Nullable;

/** E-normal's {@code live} class (phase 6a), pure: which block-entity changes the world makes by itself. */
final class LiveBlocks {
	/**
	 * Block entities the world changes by itself, with no player and no Architect (bees entering and leaving a nest, a furnace
	 * burning, a hopper moving items, a campfire cooking, a spawner counting down, sculk listening, a brewing stand brewing).
	 * A same-block block-entity mismatch on anything else (a chest whose loot table resolved, a sign, a banner) is unexplained.
	 */
	/** (6b) Plants a grazing sheep eats down to air (its EatBlockGoal): E-normal's {@code grazed}, the world's doing. */
	static final Set<String> GRAZED = Set.of("minecraft:short_grass", "minecraft:tall_grass", "minecraft:fern", "minecraft:large_fern");

	/** (6b) Whether {@code was} -> {@code now} (block ids) is a grazed plant. */
	static boolean grazed(String was, String now) {
		return GRAZED.contains(block(was)) && "minecraft:air".equals(block(now));
	}

	static final Set<String> LIVE_BE = Set.of("minecraft:bee_nest", "minecraft:beehive", "minecraft:furnace", "minecraft:blast_furnace",
		"minecraft:smoker", "minecraft:hopper", "minecraft:brewing_stand", "minecraft:campfire", "minecraft:soul_campfire", "minecraft:spawner",
		"minecraft:trial_spawner", "minecraft:vault", "minecraft:sculk_sensor", "minecraft:calibrated_sculk_sensor", "minecraft:sculk_catalyst",
		"minecraft:sculk_shrieker", "minecraft:conduit", "minecraft:beacon", "minecraft:creaking_heart");

	private LiveBlocks() {
	}

	/** A cell value's block id ({@code minecraft:x[props]{nbt}} -> {@code minecraft:x}). */
	static String block(String v) {
		int a = v.indexOf('[');
		int b = v.indexOf('{');
		int e = a < 0 ? b : b < 0 ? a : Math.min(a, b);
		return e < 0 ? v : v.substring(0, e);
	}

	/**
	 * The class of a mismatch that keeps its block and changes its block entity: {@code live} on a block the world changes, else
	 * {@code none} (unexplained); null when the mismatch is not of that kind.
	 */
	static @Nullable String sameBlockChange(String was, String now) {
		String wb = block(was);
		if (!wb.equals(block(now)) || !(was.contains("{") || now.contains("{"))) {
			return null;
		}
		return LIVE_BE.contains(wb) ? "live" : "none";
	}
}
