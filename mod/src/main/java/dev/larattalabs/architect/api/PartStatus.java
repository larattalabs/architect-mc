package dev.larattalabs.architect.api;

/** A named part's status in a blueprint delta ({@link BlueprintDelta}). Since 1.7.0. New values are only ever appended. */
public enum PartStatus {
	ADDED, REMOVED, CHANGED, UNCHANGED
}
