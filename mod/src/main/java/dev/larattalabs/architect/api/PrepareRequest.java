package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/** {@link Regions#prepare}: the plan, and the governor's generation tickets at once (null: the config, default 2; 1-8). Since 1.8.0. */
public record PrepareRequest(String planId, @Nullable Integer inFlight) {
}
