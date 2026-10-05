package dev.larattalabs.architect.api;

/**
 * {@link Sites#overlapMargin}: how far a design's restore box can reach past its template box, per side, in the worst case.
 * Sites refuse to overlap restore box against restore box, so two lots side by side with any gap (0 included: touching, not
 * sharing a cell) never overlap; only the front grows, by the approach ({@code length + extendMax} rows). Since 1.4.0.
 */
public record OverlapMargin(int front, int sides, int back) {
}
