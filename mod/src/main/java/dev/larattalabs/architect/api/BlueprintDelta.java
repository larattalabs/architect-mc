package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;

/**
 * Two versions of one entry compared template against template in design coordinates (docs/CONTRACT.md phase 5b "The blueprint
 * delta"): per part, the cell counts, whether the frame ({@code front} and the entrance's feet row) is kept (a delta with
 * {@code frameKept} false refuses {@link Reason#FRAME_CHANGED} on every site), whether the part labels are approximate (an entry
 * without a part map), and notes (the frame hint). Since 1.7.0.
 */
public record BlueprintDelta(String entryId, int from, int to, boolean frameKept, boolean approximate, Map<String, PartDelta> parts, int added,
	int removed, int changed, int unchanged, List<String> notes) {
	public BlueprintDelta {
		parts = Map.copyOf(parts);
		notes = List.copyOf(notes);
	}
}
