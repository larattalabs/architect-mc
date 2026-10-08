package dev.larattalabs.architect.api;

/** How a {@link Regions} future fails for a typed refusal (DRIFTED, REGION_LIMIT, NOT_ALLOWED, ...). Since 1.8.0. */
public class RegionRefused extends RuntimeException {
	private final Reason reason;

	public RegionRefused(Reason reason, String message) {
		super(message);
		this.reason = reason;
	}

	public Reason reason() {
		return reason;
	}
}
