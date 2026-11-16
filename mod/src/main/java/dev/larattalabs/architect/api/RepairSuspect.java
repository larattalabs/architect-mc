package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (DR) A site the auto-diagnose after an unclean start found lagging the journal ({@link Sites#suspects()}): its id, its region (or
 * null) and a short reason: {@code stuck}, {@code lagging}, {@code custody} or {@code repair_open}. Since NEXT.
 */
public record RepairSuspect(String siteId, @Nullable String regionId, String reason) {
}
