package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A realised (or realising) region: its group, state, per-stage progress, lots, cells written and skipped (per reason:
 * {@code condition}, {@code owned}, {@code claim}, {@code same}), what it waits for, and its prepare. Since 1.8.0.
 */
public record RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
	RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
	@Nullable PrepareView prepare) {
	public RegionView {
		ext = ext == null ? new JsonObject() : ext;
		stages = List.copyOf(stages);
		lots = List.copyOf(lots);
		cellsSkipped = Map.copyOf(cellsSkipped);
	}
}
