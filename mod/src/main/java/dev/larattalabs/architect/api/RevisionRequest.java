package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

/**
 * (6d RV) A revision of a standing region ({@link Regions#planRevision}): {@code program} the bundled {@code revise} program (GR: the region's
 * own program with {@code params.grow}); {@code params} its params ({@code revise}: {@code {spec: {parts: [{id, call}], refill: [lotId]}}},
 * docs/CONTRACT.md "Phase 6d slice RV" §2.4); {@code opKey} an operation key ({@code [A-Za-z0-9_.:-]{1,128}}, scoped by the region's owner:
 * the same key and body answer the same candidate, also after a restart); {@code actor} who asks (a player's UUID or a mod id), recorded.
 * Since NEXT.
 */
public record RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor) {
	public RevisionRequest {
		params = params == null ? new JsonObject() : params.deepCopy();
	}
}
