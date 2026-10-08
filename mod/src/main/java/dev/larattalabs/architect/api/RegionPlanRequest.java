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
 */
public record RegionPlanRequest(String program, JsonObject params, ServerLevel level, BoundingBox claim, @Nullable Long seed, @Nullable String bible,
	@Nullable Integer bibleVersion, LoadPolicy surveyLoad, @Nullable String owner, JsonObject ext) {
	public RegionPlanRequest {
		params = params == null ? new JsonObject() : params;
		surveyLoad = surveyLoad == null ? LoadPolicy.LOADED_ONLY : surveyLoad;
		ext = ext == null ? new JsonObject() : ext;
	}
}
