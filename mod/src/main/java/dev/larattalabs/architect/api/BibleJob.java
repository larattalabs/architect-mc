package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Locale;
import java.util.Optional;

/**
 * A bible job as the sidecar reports it ({@code bible.upsert}): a {@code bible.request} (a new bible) or a
 * {@code bible.revise} (version + 1). Since 1.2.0.
 *
 * @param kind {@code "request"} or {@code "revise"}
 * @param bibleId the bible it makes (reserved at once) or revises
 * @param version the version it makes
 * @param rounds component rounds so far
 * @param usageLimitUntil when a usage limit holds it: when the limit resets (epoch ms), else 0
 * @param bible when done: the installed bible
 * @param request the request as the sidecar recorded it (with {@code notes} for a revision)
 * @param opKey (since 1.10.0) the caller's operation key ({@link BibleRequest#opKey}), if it was sent with one
 */
public record BibleJob(String id, String kind, String bibleId, int version, Status status, String step, Optional<String> error, Cost cost,
	int rounds, long usageLimitUntil, Optional<Bible> bible, JsonObject request, long createdAt, long updatedAt, Optional<String> opKey) {
	public BibleJob {
		opKey = opKey == null ? Optional.empty() : opKey;
	}

	/** The 1.2.0 constructor (no opKey). */
	public BibleJob(String id, String kind, String bibleId, int version, Status status, String step, Optional<String> error, Cost cost,
		int rounds, long usageLimitUntil, Optional<Bible> bible, JsonObject request, long createdAt, long updatedAt) {
		this(id, kind, bibleId, version, status, step, error, cost, rounds, usageLimitUntil, bible, request, createdAt, updatedAt, Optional.empty());
	}
	/** {@code queued -> drafting -> components -> checking -> rendering -> done}; failed and cancelled. */
	public enum Status {
		QUEUED, DRAFTING, COMPONENTS, CHECKING, RENDERING, DONE, FAILED, CANCELLED, UNKNOWN;

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

	public boolean finished() {
		return status.isFinal();
	}

	/** The request's owner, if any. */
	public Optional<String> owner() {
		return request.has("owner") && request.get("owner").isJsonPrimitive() ? Optional.of(request.get("owner").getAsString()) : Optional.empty();
	}
}
