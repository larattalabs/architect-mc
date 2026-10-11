package dev.larattalabs.architect.api;

/**
 * How an API future fails for a typed refusal: {@link Reason#WORLD_STOPPED} (a future pending when the world stopped, or a call
 * made while no world runs), {@link Reason#OP_KEY_CONFLICT} (an operation key re-used with another body), and the region
 * refusals ({@link RegionRefused} is a subclass). Since 1.10.0.
 */
public class ArchitectRefused extends RuntimeException {
	private final Reason reason;
	private final String detail;

	public ArchitectRefused(Reason reason, String message) {
		this(reason, message, "");
	}

	/** With a sub-code ({@link #detail()}). Since 1.11.0. */
	public ArchitectRefused(Reason reason, String message, String detail) {
		super(message);
		this.reason = reason;
		this.detail = detail == null ? "" : detail;
	}

	public Reason reason() {
		return reason;
	}

	/**
	 * The refusal's sub-code ({@code ""} when it has none): {@link Reason#COPY_REFUSED} and {@link Reason#VERSION_REFUSED} name
	 * which rule refused. Since 1.11.0.
	 */
	public String detail() {
		return detail;
	}
}
