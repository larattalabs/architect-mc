package dev.larattalabs.architect.api;

/**
 * What {@link Regions#nudge} did: {@code done} when it acted (a prepare started, the helper asked to start, the stage
 * approved); otherwise the message says what the caller should do ("walk to x, z", "replan with Regions.plan",
 * "not applicable"). Since 1.9.0.
 */
public record NudgeResult(boolean done, String message) {
}
