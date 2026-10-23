package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (6c D3, D-S4) The answer of {@link Regions#checkBeside} (docs/CONTRACT.md "Phase 6c slice D3" §7): a snapshot of what
 * {@link Regions#plan} would answer for the same request now, keeping nothing. {@code fits} with the {@link BesideJoin join} and the
 * land ({@code architect_mc:land}'s record for the plan, D-S3); or not, with the {@link Reason} the plan would have been refused with
 * (null for a plan the helper failed), its message, and {@code code}, the kit's named word with its bracketed kind ({@code NO_JOIN
 * [route]}, {@code NO_ROOM}, {@code NO_EDGE}, {@code PROTECTED}, {@code OVERLAP}). {@code ms}: the run's time (recorded, not judged).
 * A placeholder district's join and land are the placeholder's: the real first building plans again and may land elsewhere. Since NEXT.
 */
public record BesideVerdict(boolean fits, @Nullable Reason reason, @Nullable String code, String message, @Nullable BesideJoin join,
	com.google.gson.@Nullable JsonObject land, long ms) {
}
