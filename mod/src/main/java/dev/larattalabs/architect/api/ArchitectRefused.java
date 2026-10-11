package dev.larattalabs.architect.api;

/**
 * How an API future fails for a typed refusal: {@link Reason#WORLD_STOPPED} (a future pending when the world stopped, or a call
 * made while no world runs), {@link Reason#OP_KEY_CONFLICT} (an operation key re-used with another body), and the region
 * refusals ({@link RegionRefused} is a subclass). Since 1.10.0.
 */
public class ArchitectRefused extends RuntimeException {
	private final Reason reason;

	public ArchitectRefused(Reason reason, String message) {
		super(message);
		this.reason = reason;
	}

	public Reason reason() {
		return reason;
	}
}
