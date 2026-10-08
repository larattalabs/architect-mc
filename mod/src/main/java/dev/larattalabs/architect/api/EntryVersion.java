package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * One version of a library entry (docs/CONTRACT.md phase 5b "Entry versions on disk"): its number, when it was made, by what
 * ({@code design}, {@code polish}, {@code revert}, {@code migrated}), its parent version, the design that made it, a summary
 * (at most 200 chars), the sha256 of its {@code .nbt}, and whether a standing site pins it (a pinned version is never garbage
 * collected). Since 1.7.0.
 */
public record EntryVersion(int version, long createdAt, String by, @Nullable Integer parent, @Nullable String designId, String summary,
	String nbtSha256, boolean pinned) {
}
