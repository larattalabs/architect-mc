package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * (DR) What {@link Sites#diagnose} reads: a site, a region (its tiles, roads, lots and targets), the chunks within 4 of a position
 * ({@code here}) or everything. {@code continuation}: from a previous {@link Diagnosis#continuation()} (null: from the start). Since 1.67.0.
 */
public record DiagnoseScope(Kind kind, @Nullable String id, @Nullable ResourceKey<Level> dimension, @Nullable BlockPos center,
	@Nullable String continuation) {
	public enum Kind {
		SITE, REGION, HERE, ALL
	}

	public static DiagnoseScope site(String id) {
		return new DiagnoseScope(Kind.SITE, id, null, null, null);
	}

	public static DiagnoseScope region(String id) {
		return new DiagnoseScope(Kind.REGION, id, null, null, null);
	}

	public static DiagnoseScope here(ResourceKey<Level> dimension, BlockPos center) {
		return new DiagnoseScope(Kind.HERE, null, dimension, center.immutable(), null);
	}

	public static DiagnoseScope all() {
		return new DiagnoseScope(Kind.ALL, null, null, null, null);
	}

	public DiagnoseScope withContinuation(@Nullable String c) {
		return new DiagnoseScope(kind, id, dimension, center, c);
	}

	/** The scope as the commands write it ({@code site s12}, {@code region r3}, {@code here}, {@code all}). */
	public String describe() {
		return switch (kind) {
			case SITE -> "site " + id;
			case REGION -> "region " + id;
			case HERE -> "here";
			case ALL -> "all";
		};
	}
}
