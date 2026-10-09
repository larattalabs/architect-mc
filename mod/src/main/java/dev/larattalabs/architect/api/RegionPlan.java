package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * A planned region ({@link Regions#plan}): the IR's identity ({@code irSha}: same inputs, same IR), its lots, stages,
 * anchors and budget. Since 1.8.0.
 *
 * <p>Since 1.9.0: {@code report} (the macro checker over the virtual world) and {@code previews} (the four views and the site
 * plan), both null when the request skipped them ({@code ext["architect_mc:check"] = false}); {@code irFormat} 1 or 2 (format
 * 2 only when the IR uses a format-2 member). {@code notes} also carries the plan's progress lines ("checking", "rendering
 * previews") and the volumes it read.
 */
public record RegionPlan(String planId, String programId, String programSha, String irSha, String surveySha, long seed, List<LotSpec> lots,
	List<String> stages, Map<String, BlockPos> anchors, RegionBudget budget, List<String> notes, @Nullable CheckReport report,
	@Nullable RegionPreviews previews, int irFormat) {
	public RegionPlan {
		lots = List.copyOf(lots);
		stages = List.copyOf(stages);
		anchors = Map.copyOf(anchors);
		notes = List.copyOf(notes);
		irFormat = irFormat <= 0 ? 1 : irFormat;
	}

	/** The 1.8.0 constructor: no report, no previews, IR format 1. */
	public RegionPlan(String planId, String programId, String programSha, String irSha, String surveySha, long seed, List<LotSpec> lots,
		List<String> stages, Map<String, BlockPos> anchors, RegionBudget budget, List<String> notes) {
		this(planId, programId, programSha, irSha, surveySha, seed, lots, stages, anchors, budget, notes, null, null, 1);
	}
}
