package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Whole sites as programs (docs/CONTRACT.md "# Phase 6 contract", phase 6a): a region program (a bundled id such as
 * {@code mega_bench}, or a file under {@code <gameDir>/architect/regions/programs}) is planned in the sidecar into a Region IR,
 * its claim is prepared (missing chunks generated under an MSPT governor, an explicit step), then it is realised through the
 * placement queue as journal tile entries, roads and LAYERed lots, as one site group whose stages are the program's stages.
 * {@link #remove} undoes it exactly. Overworld only, INSTANT only (a survival-toggle world refuses {@link Reason#NOT_ALLOWED}).
 * Server thread; futures complete on the server thread. Since 1.8.0 ({@code ArchitectApi.regions()}).
 *
 * <p>Since 1.9.0 (phase 6b): every plan carries the macro checker's report and the four previews ({@link RegionPlan#report()},
 * {@link RegionPlan#previews()}; {@code RegionPlanRequest.ext["architect_mc:check"] = false} skips both), {@link #check} and
 * {@link #previews} re-run them, {@link #design} picks a bundled program for a brief, and {@link #nudge} acts on what a region
 * waits for ({@link RegionView#actions()}). A plan whose IR needs a newer kit (IR {@code format} over 2, a {@code requires}
 * kind this kit lacks, or a newer {@code kitVersion}) refuses {@link Reason#PLAN_STALE} at plan accept, at realise start and
 * when a region resumes at world load, before any tile is requested.
 */
public interface Regions {
	/** Surveys the claim (sliced), plans it in the sidecar, and answers the plan (the IR's identity, lots, stages, budget). */
	CompletableFuture<RegionPlan> plan(RegionPlanRequest r);

	/**
	 * Generates every chunk of the plan's claim + 2 chunks that was never generated, governed (at most {@code inFlight}
	 * generation tickets; a new one only while recent ticks stay under 35 ms max / 20 ms mean; none for 40 ticks after a tick
	 * over 50 ms). Persistent across relogs. Completes when every chunk is generated, or it was cancelled. The plan's
	 * {@link RegionBudget#chunksToGenerate()} is the size estimate to show first; prepare never starts by itself.
	 */
	CompletableFuture<PrepareView> prepare(PrepareRequest r);

	/** Stops a running prepare (by plan or region id); what it generated stays. */
	void cancelPrepare(String regionOrPlanId);

	/** The prepare of a plan, if one ran or runs. */
	default Optional<PrepareView> prepareState(String planId) {
		return Optional.empty();
	}

	/** Queues the region's realise; completes with the region id once queued ({@link RegionView#groupId()} is its site group). */
	CompletableFuture<String> realise(RealiseRequest r);

	/** Undoes the whole region (every tile, path, road and lot, reverse stage order) as one group undo. */
	CompletableFuture<RemoveResult> remove(String regionId, RemoveOptions o);

	Optional<RegionView> get(String regionId);

	/** The regions of an owner (null: all). */
	List<RegionView> list(@Nullable String owner);

	/**
	 * Re-renders previews of a plan ({@code region.preview}) into the sidecar's plan dir. {@code views} empty: all four;
	 * {@code axes}: section lines (each 2+ points; at most 4 axes; empty: the program's default section). Since 1.9.0.
	 */
	default CompletableFuture<RegionPreviews> previews(String planId, Set<PreviewView> views, List<List<BlockPos>> axes) {
		throw new UnsupportedOperationException("Regions.previews needs Architect API 1.9.0");
	}

	/** Re-runs the macro checker over the plan ({@code region.check}); fires {@link SiteEvents#REGION_CHECKED}. Since 1.9.0. */
	default CompletableFuture<CheckReport> check(String planId) {
		throw new UnsupportedOperationException("Regions.check needs Architect API 1.9.0");
	}

	/**
	 * Starts a template-first region design ({@link RegionDesignRequest}); completes with the design id. The design
	 * ({@code Designs.get}) is of kind {@link Design.Kind#REGION}; its {@link Design#result()} is {@code {outcome:
	 * "PICKED"|"NO_TEMPLATE", fits, program, params, reason, cost, tries, planId?}}. With a fit the mod plans the picked program
	 * over the claim and names the {@code planId} once the plan is accepted (DESIGN_UPDATED fires again). Since 1.9.0.
	 */
	default CompletableFuture<String> design(RegionDesignRequest r) {
		throw new UnsupportedOperationException("Regions.design needs Architect API 1.9.0");
	}

	/**
	 * Acts on what region {@code regionId} waits for (Steward S8; the table in {@link WaitAction}): an action not offered for the
	 * current wait answers {@code done: false, "not applicable"}. {@code PREPARE} is the explicit start of a prepare, after the
	 * estimate was shown (S-6b-4): the first nudge answers {@code done: false} with the prepare's size and time estimate, and a
	 * second {@code PREPARE} nudge within 5 minutes starts it. Since 1.9.0.
	 */
	default CompletableFuture<NudgeResult> nudge(String regionId, WaitAction.Kind action) {
		throw new UnsupportedOperationException("Regions.nudge needs Architect API 1.9.0");
	}

	/**
	 * The plan an owner (null: the player) planned with this operation key ({@link RegionPlanRequest#opKey}), in any state, after a
	 * restart too (the key is kept in the plan's record). Empty: no such plan (or it is still planning, and nothing was kept yet). Since
	 * 1.14.0.
	 */
	default Optional<RegionPlan> planByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Regions.planByKey needs Architect API 1.14.0");
	}

	/**
	 * The region an owner (the plan's owner; null: the player) realised with this operation key ({@link RealiseRequest#opKey}), in any
	 * state, after a restart too, including a realise that was interrupted by a stop and resumed (its record is written before the
	 * future completes). Empty: none, or it was removed. Since 1.14.0.
	 */
	default Optional<RegionView> realiseByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Regions.realiseByKey needs Architect API 1.14.0");
	}

	/**
	 * (6c slice B) One terrain brush stroke ({@link BrushRequest}): the brush's box plus 8 is surveyed (and, for MELT, CAVE_CARVE or a
	 * mask with a block or class term, frozen as a volume with block ids), the bundled {@code brush} program plans it (no Claude
	 * call, no checker), and the plan is realised at once as one region ({@link RegionView#brush} names the kind). Completes, on the
	 * server thread, with the region's view once it is realised ({@link RegionState#PLACED}, or PARTIAL with what was skipped and
	 * why). {@link #remove} undoes it exactly, in any order with other strokes and sites.
	 * <p>Every cell is written only when it is natural, or one of the owner's own earlier strokes (layered over); with
	 * {@link Destruction#PLAYER_BLOCKS} also unowned non-natural cells. A cell any other journal entry owns (a site, road or delta, a
	 * crate, another region, another owner's stroke) is skipped and counted. Refusals ({@link ArchitectRefused}):
	 * {@link Reason#FIELD_LIMIT} (radius, strength, a missing or malformed owner), {@link Reason#NOT_ALLOWED} (outside the
	 * Overworld, or a survival-toggle world), {@link Reason#PERMISSION} (PLAYER_BLOCKS without an online actor at permission level 2),
	 * {@link Reason#PROTECTED} (an area of the owner), {@link Reason#NOT_LOADED} (a chunk of the box is not loaded: a stroke never
	 * prepares), {@link Reason#SIDECAR_UNAVAILABLE}. Since 1.21.0.
	 */
	default CompletableFuture<RegionView> brush(BrushRequest r) {
		throw new UnsupportedOperationException("Regions.brush needs Architect API 1.21.0");
	}

	/**
	 * (6c D3, D-S4) A dry beside check (docs/CONTRACT.md "Phase 6c slice D3" §7): a full {@link RegionPlanRequest} with {@code beside} set,
	 * run exactly as {@link #plan} runs it (the beside checks, both surveys, the held set, the kit's plan and check) but keeping nothing:
	 * no plan id, plan record or file, no opKey entry (an opKey in the request is ignored and noted), no blob, no world write, ticket or
	 * prepare. Completes with a {@link BesideVerdict}: fits with the join and the land, or the reason, message and the kit's code the plan
	 * would have failed with. The same request planned now gives the same answer (a snapshot). Without {@code beside} it refuses
	 * {@link Reason#NOT_ALLOWED}. Costs $0; it shares the plan queue. Since NEXT, feature {@code "besideCheck"}.
	 */
	default CompletableFuture<BesideVerdict> checkBeside(RegionPlanRequest r) {
		throw new UnsupportedOperationException("Regions.checkBeside needs the Architect API since NEXT");
	}

	// ------------------------------------------------------------------ (6c P0) plan check v0

	/**
	 * (6c P0) A $0 dry run of a geometric plan ({@code plan/0}) over one survey of the claim (docs/CONTRACT.md "Phase 6c slice P0"): the
	 * plan compiles through the bundled {@code plan_v0} program into one region plan (zones, relief, terraces, spikes, T2 routes), the
	 * macro checker runs, nothing is realised. Completes with a {@link PlanCheck}: one answer per part (fits, adjusted, refused,
	 * unsupported with its block id, blocked, malformed, incomplete), the cost, the capability catalogue, the light preview and, when
	 * READY or NEEDS_REPAIR, the artifact sha approval binds. Asynchronous and cancellable ({@code future.cancel(true)} or
	 * {@link #cancelCheck}: the future is cancelled, nothing persists but the per-owner cache). A malformed plan is an answer; only
	 * a plan over 64 KB as JSON, a bad anchor name or claim refuses ({@link Reason#FIELD_LIMIT}, {@link Reason#REGION_LIMIT},
	 * {@link Reason#NOT_ALLOWED} outside the Overworld, {@link Reason#SIDECAR_UNAVAILABLE}). An {@code opKey} returns the same check
	 * for the same body (in flight too) and refuses {@link Reason#OP_KEY_CONFLICT} for another. Since 1.23.0.
	 */
	default CompletableFuture<PlanCheck> checkPlan(PlanRequest r) {
		throw new UnsupportedOperationException("Regions.checkPlan needs Architect API 1.23.0");
	}

	/**
	 * (C38) The live capability catalogue, the one every {@link #checkPlan} answer carries ({@link PlanCheck#catalogue}), without a
	 * check: {@code catalogueVersion}, {@code api}, {@code kitVersion}, {@code schemaVersion} and {@code entries}, one
	 * {@code {id, state, sinceApi, schemaVersion, until?, retiredInApi?, replacedBy?, aliasOf?, limits?, note?}} per block id (docs/CONTRACT.md
	 * "Phase 6c slice P0" §4; new members need no API change). It is this build's own catalogue, read from the mod jar: it equals,
	 * entry for entry, the catalogue of a {@link #checkPlan} answer of the same build. Use it at world start to notice that a block
	 * has become {@code supported} (compare with the entries recorded earlier) without running a check over unloaded land.
	 * Synchronous and free of side effects: no sidecar, no survey, no claim, no loaded chunk is needed, and it works before any
	 * region exists and while the helper is unavailable. Any thread. Each call returns a fresh copy; changing it changes nothing.
	 * Since 1.31.0, feature {@code "planCatalogueView"}.
	 */
	default com.google.gson.JsonObject planCatalogue() {
		throw new UnsupportedOperationException("Regions.planCatalogue needs Architect API 1.31.0");
	}

	/** (6c P0) Cancels a running check by its key; true when one was running (its future is cancelled). Since 1.23.0. */
	default boolean cancelCheck(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Regions.cancelCheck needs Architect API 1.23.0");
	}

	/** (6c P0) The finished check an owner made with this key, after a restart too; empty while it runs, or when none. Since 1.23.0. */
	default Optional<PlanCheck> checkByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Regions.checkByKey needs Architect API 1.23.0");
	}

	/** (6c P0) The images of a check on request: 6b's views over the check's virtual world ({@link #previews} of its plan). Since 1.23.0. */
	default CompletableFuture<RegionPreviews> planImages(String checkId, Set<PreviewView> views) {
		throw new UnsupportedOperationException("Regions.planImages needs Architect API 1.23.0");
	}

	/** (6c P0) An artifact by its sha: its body, or a tombstone once removed; empty for an unknown sha. Since 1.23.0. */
	default Optional<PlanArtifact> artifact(String artifactSha) {
		throw new UnsupportedOperationException("Regions.artifact needs Architect API 1.23.0");
	}

	/**
	 * (VOC-c) The pre-check of an approved plan's palette rules with these lot entries ({@code lot -> id} or {@code id@version}, over the
	 * artifact's own): the measure {@link #realiseApproved} refuses {@link Reason#PALETTE} on, so a caller can re-bind or redesign one lot
	 * before the realise. Changes nothing. Empty for an unknown or removed artifact; an artifact with no palette rule over lots answers ok
	 * with no rules. Server thread. Since 1.37.0.
	 */
	default Optional<PaletteCheck> checkPalette(String artifactSha, java.util.Map<String, String> lotEntries) {
		throw new UnsupportedOperationException("Regions.checkPalette needs Architect API 1.37.0");
	}

	/**
	 * (6c P0) Realises an approved artifact ({@link ApprovedRealise}): no artifact with that sha (or a removed one) refuses
	 * {@link Reason#ARTIFACT_UNAPPROVED}; the claim is surveyed again at the artifact's resolution and the protection fingerprint
	 * recomputed: any changed column inside the plan's tiles, a changed protected area or region, or a provisional lot's entry past
	 * its fit box or cost range refuses {@link Reason#ARTIFACT_STALE} (naming them) and writes nothing. Then
	 * {@link #realise} of the artifact's own plan (its IR: never planned again), with the key. Completes with the region id once
	 * queued. {@link #remove} undoes it. Since 1.23.0.
	 */
	default CompletableFuture<String> realiseApproved(ApprovedRealise r) {
		throw new UnsupportedOperationException("Regions.realiseApproved needs Architect API 1.23.0");
	}

	/**
	 * (6c P0) Keeps an artifact for an owner (idempotent). An artifact is kept while an owner pins it or a standing region was realised
	 * from it; unpinning the last pin of an unreferenced one removes it, leaving a tombstone. Since 1.23.0.
	 */
	default void pinArtifact(String artifactSha, String owner) {
		throw new UnsupportedOperationException("Regions.pinArtifact needs Architect API 1.23.0");
	}

	/** (6c P0) Drops an owner's pin (idempotent); see {@link #pinArtifact}. Since 1.23.0. */
	default void unpinArtifact(String artifactSha, String owner) {
		throw new UnsupportedOperationException("Regions.unpinArtifact needs Architect API 1.23.0");
	}
}
