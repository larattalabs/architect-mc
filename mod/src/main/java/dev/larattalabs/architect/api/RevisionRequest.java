package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;

/**
 * (6d RV) A revision of a standing region ({@link Regions#planRevision}): {@code program} the bundled {@code revise} program, or (6d GR)
 * the region's own program with {@code params.grow} (a growth: {@code {grow: {lots, district?, prefer?, extend?}}}, mapped to
 * {@code revise}'s {@code spec.grow}); {@code params} its params ({@code revise}: {@code {spec: {parts: [{id, call}], refill: [lotId],
 * grow?}}}, docs/CONTRACT.md "Phase 6d slice RV" §2.4, "Phase 6d slice GR" §2.1); {@code opKey} an operation key
 * ({@code [A-Za-z0-9_.:-]{1,128}}, scoped by the region's owner: the same key and body answer the same candidate, also after a restart);
 * {@code actor} who asks (a player's UUID or a mod id), recorded; (6d GR) {@code ext} the caller's own data kept on the candidate plan
 * (e.g. Steward's {@code steward_mc:district}, {@code steward_mc:build}; {@code architect_mc:*} keys are Architect's and refused).
 * Since 1.43.0.
 */
public record RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor, JsonObject ext) {
	public RevisionRequest {
		params = params == null ? new JsonObject() : params.deepCopy();
		ext = ext == null ? new JsonObject() : ext.deepCopy();
	}

	/** (RV) Without an ext. */
	public RevisionRequest(String program, JsonObject params, @Nullable String opKey, @Nullable String actor) {
		this(program, params, opKey, actor, new JsonObject());
	}
}
