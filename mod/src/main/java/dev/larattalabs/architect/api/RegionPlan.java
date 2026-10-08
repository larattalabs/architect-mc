package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;

/**
 * A planned region ({@link Regions#plan}): the IR's identity ({@code irSha}: same inputs, same IR), its lots, stages,
 * anchors and budget. Since 1.8.0 (6b adds the checker report and previews).
 */
public record RegionPlan(String planId, String programId, String programSha, String irSha, String surveySha, long seed, List<LotSpec> lots,
	List<String> stages, Map<String, BlockPos> anchors, RegionBudget budget, List<String> notes) {
	public RegionPlan {
		lots = List.copyOf(lots);
		stages = List.copyOf(stages);
		anchors = Map.copyOf(anchors);
		notes = List.copyOf(notes);
	}
}
