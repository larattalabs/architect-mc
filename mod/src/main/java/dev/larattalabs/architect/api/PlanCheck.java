package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (6c P0) A plan check's answer ({@link Regions#checkPlan}; docs/CONTRACT.md "Phase 6c slice P0" §3, §4): one answer per part in
 * the shape of plan.json's {@code $defs/partAnswer} ({@code part, block, class, required, geometry, cost, provisional,
 * deviations, reasons, wouldFit, blockedBy, ext, cached, notes}; new members need no API change), the whole plan's cost (a
 * {@code range} when a part is provisional), the capability catalogue, the light preview ({@code bounds} per part, the 1:4
 * {@code classMap} PNG's {@code path}, the {@code siteplan}: images come on request, {@link Regions#planImages}) and, for
 * {@link Overall#READY} or {@link Overall#NEEDS_REPAIR}, the sha of the resolved artifact approval binds ({@link Regions#artifact}).
 * {@code checkId} names the check (its region plan's id: {@link Regions#planImages} renders over it). Since 1.23.0.
 */
public record PlanCheck(String checkId, String planSha, String surveySha, String kitVersion, String schemaVersion, Overall overall, List<JsonObject> parts,
	JsonObject cost, JsonObject catalogue, JsonObject preview, @Nullable String artifactSha, List<String> notes) {
	public PlanCheck {
		parts = parts == null ? List.of() : List.copyOf(parts);
		cost = cost == null ? new JsonObject() : cost;
		catalogue = catalogue == null ? new JsonObject() : catalogue;
		preview = preview == null ? new JsonObject() : preview;
		notes = notes == null ? List.of() : List.copyOf(notes);
	}

	/**
	 * The overall result (§3): MALFORMED (the plan itself failed the schema), INCOMPLETE (a part ran out of budget, time or memory),
	 * REQUIRED_BLOCKED (a required part is unsupported, refused, blocked or malformed), NEEDS_REPAIR (another part is not fits or adjusted),
	 * READY. Only READY and NEEDS_REPAIR make an artifact. New values are only ever appended.
	 */
	public enum Overall { READY, NEEDS_REPAIR, REQUIRED_BLOCKED, INCOMPLETE, MALFORMED }
}
