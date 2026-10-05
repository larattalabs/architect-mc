package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.Optional;

/**
 * A design job, as the sidecar reports it.
 *
 * @param request the request as sent (plus {@code owner} and {@code ext} the mod kept)
 * @param entryId the library entry it produced, once done
 * @param owner the request's owner (kept by the mod), or empty
 */
public record Design(String id, Status status, String step, Optional<String> entryId, Cost cost, Optional<String> error, JsonObject request,
	Optional<String> owner, long createdAt, long updatedAt) {
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
