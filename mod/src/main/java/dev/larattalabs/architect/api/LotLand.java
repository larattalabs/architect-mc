package dev.larattalabs.architect.api;

/**
 * (6d LC) One lot's land in a {@link LandReport}: its site, its state (as {@link LotState#state()}), {@code standing}, the share of its
 * building's blocks that still stand by block (the world-start check's score: the building counts as standing at 0.8, a restore as
 * saved at 0.9; -1 when it can't be told: no site, no template, or a chunk of its box not loaded), and its cells the lot holds on top
 * that changed ({@code changed}: removed or another block, not a player's, volatile kinds aside) or carry a player's record
 * ({@code playerPlaced}). Since 1.51.0.
 */
public record LotLand(String lot, String siteId, String state, double standing, long changed, long playerPlaced) {
}
