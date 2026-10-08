package dev.larattalabs.architect.api;

/**
 * A standing site whose pinned version is older than its entry's head (Steward SHOULD 3: {@link Sites#outdated}, called at world
 * load because {@link SiteEvents#ENTRY_VERSIONED} events are missed while the world is closed). Since 1.7.0.
 */
public record OutdatedSite(String siteId, String entryId, int version, int headVersion) {
}
