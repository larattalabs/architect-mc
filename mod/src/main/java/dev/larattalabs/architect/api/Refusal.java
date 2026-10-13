package dev.larattalabs.architect.api;

/**
 * Why a placement is refused: a typed reason and the message the player would see; (PT) for {@link Reason#PLAYER_BUILD}, the builds
 * in the way ({@code builds}: each with its blocking count and first 8 cells).
 */
public record Refusal(Reason reason, String message, java.util.List<BuildHit> builds) {
	public Refusal {
		builds = builds == null ? java.util.List.of() : java.util.List.copyOf(builds);
	}

	public Refusal(Reason reason, String message) {
		this(reason, message, java.util.List.of());
	}
}
