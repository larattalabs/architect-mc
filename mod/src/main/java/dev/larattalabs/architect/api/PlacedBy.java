package dev.larattalabs.architect.api;

import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A player-placed cell (docs/CONTRACT.md "Phase 6c slice PT" §9): who placed the block ({@code placer}; the nil UUID for an unknown
 * placer, e.g. a console claim or the 255th distinct placer in one chunk) and the build it belongs to ({@code buildId}, an alias
 * resolved to its survivor; null = incidental: it counts as natural for every write). Since PT.
 */
public record PlacedBy(UUID placer, @Nullable String buildId) {
}
