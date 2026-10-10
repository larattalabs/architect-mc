package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Something a caller can do about what a region waits for ({@link RegionView#actions()}, {@link Regions#nudge}; Steward S8,
 * docs/CONTRACT.md phase 6b §6.2):
 * <ul>
 * <li>{@code NOT_LOADED}: {@link Kind#MOVE_CLOSER}, {@code target} the waiting item's nearest chunk centre;</li>
 * <li>{@code NOT_GENERATED}: {@link Kind#PREPARE}, {@code detail} the prepare's size and time estimate;</li>
 * <li>{@code SIDECAR_UNAVAILABLE}: {@link Kind#START_SIDECAR};</li>
 * <li>{@code DRIFTED} (a stage held): {@link Kind#APPROVE_STAGE} ({@code detail} the stage) and {@link Kind#REPLAN};</li>
 * <li>{@code TILE_SLOW} (since 1.10.0): {@link Kind#RETRY} ({@link Regions#nudge} asks for the slow tiles again now).</li>
 * </ul>
 * Since 1.9.0.
 *
 * @param label a short line for a button or an inbox ("Walk to 120, -340", "Prepare 412 chunks (~3 min)")
 */
public record WaitAction(Kind kind, String label, @Nullable BlockPos target, @Nullable String detail) {
	/** New values are only ever appended. */
	public enum Kind { MOVE_CLOSER, PREPARE, START_SIDECAR, APPROVE_STAGE, REPLAN, RETRY }
}
