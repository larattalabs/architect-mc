package dev.larattalabs.architect.api;

/**
 * What a design, a group or a bible job will probably cost and take ({@code design.estimate} / {@code bible.estimate},
 * docs/CONTRACT.md "4b review folded in" item 2): from the sidecar's measured per-model averages (rolling, seeded), the
 * concurrency and the current usage-limit state. Under the claude login the dollars are notional. Since 1.2.0.
 *
 * @param basis what it was computed from ("seed" values or "n measured" per model, the concurrency, a usage limit)
 */
public record Estimate(double usdLow, double usdHigh, double minutesLow, double minutesHigh, String basis) {
}
