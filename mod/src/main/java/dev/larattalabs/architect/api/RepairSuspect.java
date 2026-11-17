package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (DR) A site the auto-diagnose after an unclean start found lagging the journal ({@link Sites#suspects()}): its id, its region (or
 * null) and a short reason: {@code stuck}, {@code lagging}, {@code custody}, {@code repair_open} or {@code unread} (its journal or cells
 * could not be read: not known clean). Since 1.67.0.
 */
public record RepairSuspect(String siteId, @Nullable String regionId, String reason) {
}
