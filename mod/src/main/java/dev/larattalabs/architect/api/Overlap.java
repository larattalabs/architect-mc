package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * A standing site a placement's restore box overlaps ({@link Verdict#overlaps}): its owner, the cells shared, and whether it
 * blocks the placement under the request's policy. Since 1.5.0.
 */
public record Overlap(String siteId, @Nullable String owner, int cells, boolean blocking) {
}
