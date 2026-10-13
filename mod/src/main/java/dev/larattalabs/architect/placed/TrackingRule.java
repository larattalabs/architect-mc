package dev.larattalabs.architect.placed;

/**
 * The world rule {@code architect.playerTracking} (docs/CONTRACT.md "Phase 6c slice PT" §9, default on): off, nothing is recorded
 * and nothing enforced; the data is kept. A class of its own (no game classes), so the feature list can read it anywhere.
 */
public final class TrackingRule {
	private TrackingRule() {
	}

	public static volatile boolean on = true;
}
