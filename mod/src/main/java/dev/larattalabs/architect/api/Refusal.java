package dev.larattalabs.architect.api;

/**
 * Why a placement is refused: a typed reason and the message the player would see; (PT) for {@link Reason#PLAYER_BUILD}, the builds
 * in the way ({@code builds}: each with its blocking count and first 8 cells); (slice T1, Since 1.68.0) for {@link Reason#SITE_BUSY}, a
 * {@code detail} that tells a transaction's hold apart (docs/TXN-DESIGN.md §3.12.10-11): {@code held(decided) tx-<n>: <where>} (the
 * caller's own decided transaction is held and finishes later), {@code held(other) tx-<n>: <where>} (another transaction holds the
 * resource: nothing changed, try later), or empty (today's busy case, unchanged).
 */
public record Refusal(Reason reason, String message, java.util.List<BuildHit> builds, String detail) {
	public Refusal {
		builds = builds == null ? java.util.List.of() : java.util.List.copyOf(builds);
		detail = detail == null ? "" : detail;
	}

	/** The shape before slice T1: no detail. */
	public Refusal(Reason reason, String message, java.util.List<BuildHit> builds) {
		this(reason, message, builds, "");
	}

	public Refusal(Reason reason, String message) {
		this(reason, message, java.util.List.of(), "");
	}
}
