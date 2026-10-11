package dev.larattalabs.architect.api;

/**
 * How a {@link Regions} future fails for a typed refusal (DRIFTED, REGION_LIMIT, NOT_ALLOWED, ...). Since 1.8.0; since 1.10.0 a
 * subclass of {@link ArchitectRefused} (catch that for every typed refusal).
 */
public class RegionRefused extends ArchitectRefused {
	public RegionRefused(Reason reason, String message) {
		super(reason, message);
	}

	@Override
	public Reason reason() {
		return super.reason();
	}
}
