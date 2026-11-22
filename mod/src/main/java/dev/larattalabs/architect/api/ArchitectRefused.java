package dev.larattalabs.architect.api;

/**
 * How an API future fails for a typed refusal: {@link Reason#WORLD_STOPPED} (a future pending when the world stopped, or a call
 * made while no world runs), {@link Reason#OP_KEY_CONFLICT} (an operation key re-used with another body), and the region
 * refusals ({@link RegionRefused} is a subclass). Since 1.10.0.
 */
public class ArchitectRefused extends RuntimeException {
	private final Reason reason;
	private final String detail;
	private final java.util.List<BuildHit> builds;
	private final @org.jspecify.annotations.Nullable Busy busy;

	public ArchitectRefused(Reason reason, String message) {
		this(reason, message, "");
	}

	/** With a sub-code ({@link #detail()}). Since 1.11.0. */
	public ArchitectRefused(Reason reason, String message, String detail) {
		this(reason, message, detail, java.util.List.of());
	}

	/** (PT) With the builds in the way ({@link Reason#PLAYER_BUILD}). */
	public ArchitectRefused(Reason reason, String message, String detail, java.util.List<BuildHit> builds) {
		this(reason, message, detail, builds, null);
	}

	/** (slice T4R-D, A7a) A {@link Reason#SITE_BUSY} refusal with its typed cause ({@link #busy()}); detail is its {@link Busy#token()}. Since NEXT. */
	public ArchitectRefused(Reason reason, String message, Busy busy) {
		this(reason, message, busy.token(), java.util.List.of(), busy);
	}

	private ArchitectRefused(Reason reason, String message, String detail, java.util.List<BuildHit> builds, @org.jspecify.annotations.Nullable Busy busy) {
		super(message);
		this.reason = reason;
		this.detail = detail == null ? "" : detail;
		this.builds = builds == null ? java.util.List.of() : java.util.List.copyOf(builds);
		this.busy = busy;
	}

	/**
	 * (slice T4R-D, Steward's A7a) For a {@link Reason#SITE_BUSY} refusal because of a removal: what blocks the call, typed (kind, blocking id,
	 * its kind, its owner); null for any other refusal. Since NEXT.
	 */
	public @org.jspecify.annotations.Nullable Busy busy() {
		return busy;
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

	/**
	 * (PT) For {@link Reason#PLAYER_BUILD}: the builds in the way, each with its blocking count and first 8 cells; empty
	 * otherwise.
	 */
	public java.util.List<BuildHit> builds() {
		return builds;
	}
}
