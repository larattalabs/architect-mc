package dev.larattalabs.architect.api;

/**
 * What a brush stroke may remove ({@link BrushRequest#destruction}, Noah's destruction rule, docs/CONTRACT.md "Phase 6c slice B"
 * §4). Not the {@link Reason#PLAYER_BLOCKS} refusal, which stays a refusal.
 * <ul>
 * <li>{@code NATURAL_ONLY} (the default): natural cells only (terrain, plants, trees, water), and the stroke owner's own earlier
 * strokes.</li>
 * <li>{@code PLAYER_BLOCKS}: also blocks no journal entry owns that are not natural (a player's or another mod's builds), block
 * entities included. The {@code actor} must be an online player with permission level 2 (else {@link Reason#PERMISSION}); the
 * server console reaches it through {@code /architect brush} only. Before states and block-entity data are journaled and nothing
 * drops: one undo restores them, contents included.</li>
 * </ul>
 * A cell another owner's journal entry owns is never touched, in either mode (skipped, counted as {@code owned}). Since 1.21.0.
 */
public enum Destruction {
	NATURAL_ONLY, PLAYER_BLOCKS
}
