package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (6c P0) A plan check ({@link Regions#checkPlan}; docs/CONTRACT.md "Phase 6c slice P0" §2): the geometric plan ({@code plan/0},
 * kit/schemas/plan.json; at most 64 KB as JSON) over one claim (at most 1024 a side, the Overworld), with the caller's named
 * anchors ({@code stone}, {@code player}, {@code street_w}, ...: positions P0 never interprets; the built-in {@code claim_*} ones
 * need none), the owner (whose protected areas are keep-out, whose cache the check uses and whose keys scope {@code opKey}),
 * the style bible, the caps ({@link PlanBudget}; null: the defaults) and an operation key (scope (owner, "region.checkPlan",
 * key); the body is the plan's canonical JSON, the claim's x/z, the anchors, the bible and the budget). {@code ext} is the
 * caller's (namespaced; never read). Since 1.23.0.
 */
public record PlanRequest(JsonObject plan, ServerLevel level, BoundingBox claim, Map<String, BlockPos> anchors, @Nullable String owner, @Nullable String bible,
	@Nullable Integer bibleVersion, @Nullable PlanBudget budget, @Nullable String opKey, JsonObject ext) {
	public PlanRequest {
		plan = plan == null ? new JsonObject() : plan;
		anchors = anchors == null ? Map.of() : Map.copyOf(anchors);
		ext = ext == null ? new JsonObject() : ext;
	}
}
