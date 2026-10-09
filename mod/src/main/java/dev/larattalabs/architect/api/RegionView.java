package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A realised (or realising) region: its group, state, per-stage progress, lots, cells written and skipped (per reason:
 * {@code condition}, {@code owned}, {@code claim}, {@code same}), what it waits for, and its prepare. Since 1.8.0.
 *
 * <p>Since 1.9.0: {@code actions}, what a caller can do about {@code waiting} ({@link WaitAction}, {@link Regions#nudge});
 * empty when the region waits for nothing it can act on. {@code REGION_STATE} also fires when the actions change.
 */
public record RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
	RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
	@Nullable PrepareView prepare, List<WaitAction> actions) {
	public RegionView {
		ext = ext == null ? new JsonObject() : ext;
		stages = List.copyOf(stages);
		lots = List.copyOf(lots);
		cellsSkipped = Map.copyOf(cellsSkipped);
		actions = actions == null ? List.of() : List.copyOf(actions);
	}

	/** The 1.8.0 constructor: no actions. */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, List.of());
	}
}
