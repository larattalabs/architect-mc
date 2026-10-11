package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A region plan ({@link Regions#plan}). Since 1.8.0.
 *
 * @param program a bundled program id ({@code mega_bench}) or a path under {@code <gameDir>/architect/regions/programs}
 * @param claim the columns (x/z) of the region; its y range is ignored (the plan picks it from the survey); at most 1024x1024
 * @param seed null: {@code fnv64(program, params, claim)}
 * @param surveyLoad how the plan survey reads chunks (LOADED_ONLY: unloaded columns are missing to the program)
 * @param opKey (since 1.14.0) the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}), scoped by (owner, "region.plan", opKey); a
 *     null key is the old behaviour. The same key with the same body returns the existing plan, in any state (also while it is still
 *     planning); with a different body the future fails {@link ArchitectRefused} {@link Reason#OP_KEY_CONFLICT}. The body is the program,
 *     params, dimension, the claim's x/z columns, seed, bible and version, surveyLoad and ext (a claim's y range is ignored). Found after
 *     a restart by {@link Regions#planByKey}; kept as long as the plan exists (plans are not pruned).
 */
public record RegionPlanRequest(String program, JsonObject params, ServerLevel level, BoundingBox claim, @Nullable Long seed, @Nullable String bible,
	@Nullable Integer bibleVersion, LoadPolicy surveyLoad, @Nullable String owner, JsonObject ext, @Nullable String opKey) {
	public RegionPlanRequest {
		params = params == null ? new JsonObject() : params;
		surveyLoad = surveyLoad == null ? LoadPolicy.LOADED_ONLY : surveyLoad;
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The 1.13.0 constructor (no opKey). */
	public RegionPlanRequest(String program, JsonObject params, ServerLevel level, BoundingBox claim, @Nullable Long seed, @Nullable String bible,
		@Nullable Integer bibleVersion, LoadPolicy surveyLoad, @Nullable String owner, JsonObject ext) {
		this(program, params, level, claim, seed, bible, bibleVersion, surveyLoad, owner, ext, null);
	}
}
