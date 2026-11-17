package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (DR) One finding of a diagnosis: its code, the site, region and ledger key it is about (each null when not applicable), how many cells
 * it covers ({@code lagging} of them repairable, {@code foreign} left), the first 64 {@link CellDiff}s and a line for people. Since 1.67.0.
 */
public record RepairFinding(RepairCode code, @Nullable String siteId, @Nullable String regionId, @Nullable String key, int cells, int lagging,
	int foreign, List<CellDiff> diffs, String message) {
	public RepairFinding {
		diffs = List.copyOf(diffs);
	}
}
