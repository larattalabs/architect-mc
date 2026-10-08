package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/** A region lot: its site once placed; {@code state} is {@code pad}, {@code queued}, {@code placed} or {@code failed:<reason>}. Since 1.8.0. */
public record LotState(String id, @Nullable String siteId, String state) {
}
