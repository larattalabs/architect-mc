package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;

/**
 * A failing stretch of a road (docs/CONTRACT.md phase 6c slice 0c §3): the waypoint segments {@code fromPoint..toPoint} (point
 * indexes into {@link RoadRequest#points}; neighbouring failing segments merge), the first failure's reason
 * ({@link Reason#TOO_STEEP}, {@link Reason#DEEP_WATER}, {@link Reason#LAVA} or {@link Reason#PROTECTED}), its message and cell.
 * {@link Sites#checkRoad} lists every one in {@link Verdict#spans}; a partial road's {@link PlaceResult#skipped} lists the
 * dropped ones. Since 1.12.0.
 */
public record RoadSpan(int fromPoint, int toPoint, Reason reason, String message, BlockPos at) {
}
