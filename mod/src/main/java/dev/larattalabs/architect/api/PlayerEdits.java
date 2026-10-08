package dev.larattalabs.architect.api;

/**
 * What a delta does with a cell of its delta set that the player changed since the site was placed or last updated
 * (docs/CONTRACT.md phase 5b "Player edits"): {@code KEEP} (default) leaves the player's block and reports it,
 * {@code OVERWRITE} writes the new version's block (in survival the player's block drops), {@code REFUSE} refuses the whole
 * delta with {@link Reason#PLAYER_EDITS}. Since 1.7.0. New values are only ever appended.
 */
public enum PlayerEdits {
	KEEP, OVERWRITE, REFUSE
}
