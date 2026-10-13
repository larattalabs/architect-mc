package dev.larattalabs.architect.journal;

import java.util.Objects;
import java.util.UUID;
import org.jspecify.annotations.Nullable;

/**
 * A cell's player-placed record as the journal keeps it (docs/CONTRACT.md "Phase 6c slice PT" §5): who placed the block that was
 * there before a write ({@code placer}; the nil UUID for an unknown placer) and the build it belonged to (null: incidental).
 * Undo and remove put it back with the block. Pure, immutable.
 */
public record Pt(UUID placer, @Nullable String build) {
	public Pt {
		Objects.requireNonNull(placer, "placer");
	}
}
