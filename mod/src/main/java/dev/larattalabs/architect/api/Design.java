package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.Optional;

/**
 * A design job, as the sidecar reports it.
 *
 * @param request the request as sent (plus {@code owner} and {@code ext} the mod kept)
 * @param entryId the library entry it produced, once done (never for a massing job: a massing is not a library entry)
 * @param owner the request's owner (kept by the mod), or empty
 * @param massing (since 1.3.0) a massing job: the massing version it makes ({@link Designs#massing}); its DESIGN_DONE carries
 *     no entry, and {@link SiteEvents#MASSING_DONE} fires once the version is installed. A failed massing job has no
 *     {@link Massing} record: it shows only as DESIGN_DONE with status FAILED and this set
 * @param conformance (since 1.3.0) a detail pass ({@code request.fromMassing}): the massing conformance of the result
 */
public record Design(String id, Status status, String step, Optional<String> entryId, Cost cost, Optional<String> error, JsonObject request,
	Optional<String> owner, long createdAt, long updatedAt, Optional<MassingRef> massing, Optional<Conformance> conformance) {
	/** The 1.2.0 constructor (no massing, no conformance). */
	public Design(String id, Status status, String step, Optional<String> entryId, Cost cost, Optional<String> error, JsonObject request,
		Optional<String> owner, long createdAt, long updatedAt) {
		this(id, status, step, entryId, cost, error, request, owner, createdAt, updatedAt, Optional.empty(), Optional.empty());
	}

	/** Whether this is a massing job (since 1.3.0). */
	public boolean isMassing() {
		return massing.isPresent();
	}

	/** The massing this design details ({@code request.fromMassing} and the pinned version), when it is a detail pass (since 1.3.0). */
	public Optional<MassingRef> fromMassing() {
		if (request == null || !request.has("fromMassing") || !request.get("fromMassing").isJsonPrimitive()) {
			return Optional.empty();
		}
		int v = request.has("massingVersion") && request.get("massingVersion").isJsonPrimitive() ? request.get("massingVersion").getAsInt() : 0;
		return Optional.of(new MassingRef(request.get("fromMassing").getAsString(), v));
	}

	/** {@code DesignStatus}. */
	public enum Status {
		QUEUED, DESIGNING, CHECKING, RENDERING, DONE, FAILED, CANCELLED, UNKNOWN;

		public boolean isFinal() {
			return this == DONE || this == FAILED || this == CANCELLED;
		}

		public static Status of(String s) {
			try {
				return s == null ? UNKNOWN : valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}
	}
}
