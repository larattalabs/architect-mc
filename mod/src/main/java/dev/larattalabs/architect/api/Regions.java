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
	/**
	 * (TJ SCH-res) Where the mod jar carries Architect's plan/0 JSON Schema (kit/schemas/plan.json, byte for byte; the build fails when
	 * the jar's copy differs from the tree's): a consumer reads it from the classpath ({@link #planSchema()}) or, in a Node tool, from the
	 * pinned jar's entry {@code architect_mc/schemas/plan.json}, instead of keeping a hand copy. Architect owns this schema; its
	 * {@code x-catalogue} is what {@link #planCatalogue()} answers. Since 1.58.0.
	 */
	String PLAN_SCHEMA_RESOURCE = "/architect_mc/schemas/plan.json";

	/**
	 * (TJ SCH-res) The loaded Architect's plan/0 JSON Schema (the {@link #PLAN_SCHEMA_RESOURCE} resource) as UTF-8 text. Any thread.
	 * Since 1.58.0.
	 *
	 * @throws IllegalStateException when the resource is missing (not an Architect jar)
	 */
	static String planSchema() {
		try (java.io.InputStream in = Regions.class.getResourceAsStream(PLAN_SCHEMA_RESOURCE)) {
			if (in == null) {
				throw new IllegalStateException("the Architect jar has no " + PLAN_SCHEMA_RESOURCE);
			}
			return new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
		} catch (java.io.IOException e) {
			throw new java.io.UncheckedIOException(e);
		}
	}

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
	 * {@link Reason#NOT_ALLOWED}. Costs $0; it shares the plan queue. Since 1.40.0, feature {@code "besideCheck"}.
	 */
	default CompletableFuture<BesideVerdict> checkBeside(RegionPlanRequest r) {
		throw new UnsupportedOperationException("Regions.checkBeside needs the Architect API since 1.40.0");
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
	 * <p>(6c close-out A, §1) <b>The key after a refusal.</b> A realise refused before its region record is written ({@link
	 * Reason#ARTIFACT_UNAPPROVED}, {@link Reason#ARTIFACT_STALE}, {@link Reason#PALETTE}, {@link Reason#NOT_LOADED}, and what {@link
	 * #realise} refuses before it writes the record: {@link Reason#NOT_ALLOWED}, {@link Reason#CREATIVE_ONLY_BLOCK}) binds nothing to its
	 * opKey: the same key may realise another artifact (the one checked again after a stale refusal). Once a realise under the key has
	 * written its region record, the key is that region's while the region stands, in every state but REMOVED (as since C20, {@link
	 * #realiseByKey} is empty once it is removed, and the key is free again): the same body answers its
	 * id, another artifact {@link Reason#OP_KEY_CONFLICT}, and {@link #realiseByKey} finds it after a restart. A keyed {@link #checkPlan}
	 * answers its first check: check again unkeyed or under a new key. The realise ends every keyed pin under its key
	 * ({@link #pinArtifact(String, String, String)}).
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

	/**
	 * (6c P0) Drops an owner's pin (idempotent); see {@link #pinArtifact}. Since 1.23.0. (6c close-out A) It drops the owner's keyed pins on
	 * that artifact too.
	 */
	default void unpinArtifact(String artifactSha, String owner) {
		throw new UnsupportedOperationException("Regions.unpinArtifact needs Architect API 1.23.0");
	}

	/**
	 * (6c close-out A, §2) A keyed pin: keeps an artifact for an owner until the key's realise. {@code opKey} is the key the caller will
	 * pass to {@link #realiseApproved} ({@code [A-Za-z0-9_.:-]{1,128}}, scoped by the owner, the plan's owner); one key may pin several
	 * artifacts (the check's, then the re-check's). A keyed pin ends when a realise under {@code (owner, opKey)} writes its region record
	 * (every keyed pin under the key, on every artifact: the realised one is then held by its region, the others go to their tombstones),
	 * on {@link #unpinArtifact}, or at the world-start sweep 30 days after its last use (a pin or re-pin under the key, or a
	 * {@link #realiseApproved} attempt under it). Idempotent; a re-pin refreshes its last use. Unknown or removed artifacts: nothing.
	 * Server thread. Since 1.39.0.
	 */
	default void pinArtifact(String artifactSha, String owner, String opKey) {
		throw new UnsupportedOperationException("Regions.pinArtifact(sha, owner, opKey) needs Architect API 1.39.0");
	}

	/**
	 * (6c close-out A, §3) Discards an unrealised plan: the mod's plan files, its prepare record and the helper's plan dir (sent when the
	 * helper is connected, else at its next connect), and every artifact made from it that has no pin (to its tombstone). Completes true
	 * when discarded now, false for an unknown or already discarded plan. Refuses {@link Reason#OVERLAP_BUSY} with
	 * {@link ArchitectRefused#detail()} {@code realised} (a region that is not REMOVED was realised from it), {@code busy} (it is still
	 * being prepared or checked) or {@code pinned} (an artifact of it has a pin: unpin it first). A tombstone stays: a keyed plan's same
	 * key and body then refuses {@link Reason#PLAN_STALE} (detail {@code discarded}), {@link #planByKey} answers empty, and a
	 * {@link #realise} of the id refuses PLAN_STALE. The world-start sweep discards an unrealised plan 7 days after its last use (30
	 * with a plan key). Since 1.39.0.
	 */
	default CompletableFuture<Boolean> discardPlan(String planId) {
		throw new UnsupportedOperationException("Regions.discardPlan needs Architect API 1.39.0");
	}

	/**
	 * (6d RV) Plans an additive revision of a standing region (docs/CONTRACT.md "Phase 6d slice RV"): new parts, lots, refills and bodies
	 * evaluated alone and layered over the region; it never removes or changes a standing part, road, lot box or body. The region must
	 * stand (PLACED, PARTIAL, or FAILED with cells) and not be busy ({@link Reason#OVERLAP_BUSY}); the request's parts must keep off its
	 * paths, roads, lot boxes plus 1, bodies, held columns and beside regions' reach ({@link Reason#COVERED}, {@link Reason#OVERLAP},
	 * {@link Reason#PROTECTED}), and off its unfinished tiles ({@link Reason#NOT_ALLOWED}, {@code unfinished}); a non-additive request
	 * refuses {@link Reason#NOT_ALLOWED} ({@code not_additive}). Answers a candidate: a {@link RegionPlan} with {@link RegionPlan#revisionOf()}.
	 * Any number of candidates may stand on one parent; {@link #realise} of one accepts it (the parent must still be the head and the
	 * region's history at its tiles unchanged, else {@link Reason#PLAN_STALE}) and writes it as the region's next layers; the others go
	 * STALE. Since 1.43.0.
	 */
	default CompletableFuture<RegionPlan> planRevision(String regionId, RevisionRequest r) {
		throw new UnsupportedOperationException("Regions.planRevision needs Architect API 1.43.0");
	}

	/**
	 * (6d RV) Undoes the region's revisions above {@code toPosition}, whole and last first, in one recoverable operation (§4.4): a preflight
	 * over the whole suffix refuses with every reason found and nothing written ({@link Reason#OVERLAP_BUSY}, {@link Reason#OCCUPIED},
	 * {@link Reason#NOT_ALLOWED}: {@code joined}, {@code blockers}, fluids; {@code toPosition} not below the head); then the
	 * suffix's bodies drain and its sites are removed; afterwards the head is {@code toPosition} and every reader (the view, the land
	 * {@code architect_mc:land}, the beside data) reads the older effective IR. Once begun it is never abandoned: a call with the same
	 * target returns the running operation. Since 1.43.0.
	 *
	 * <p>In survival (RV §8, slice RU, since NEXT) a revision whose targets are not all built is cancelled by its undo, not refused: a
	 * revision still writing has its batch cancelled first (its waiting items fail {@code CANCELLED}), then its unbuilt targets and lots
	 * are removed with the rest: each refunds what of it stands paid (never more than its paid record), items delivered but not consumed
	 * stay in the stock (a target's reservation ends with it), and the land comes back as before the revision.
	 */
	default CompletableFuture<RemoveResult> undoRevision(String regionId, int toPosition, String actor) {
		throw new UnsupportedOperationException("Regions.undoRevision needs Architect API 1.43.0");
	}

	/**
	 * (6d LC) What has changed in a standing region since it was built (docs/CONTRACT.md "Phase 6d slice LC"), part by part and lot by lot:
	 * every cell the region holds on top (its tile, revision, road and gate mechanism entries; a cell counted once, for the writer on top of
	 * the journal there) against what the region wrote, attributed to its part by the realised record ({@link PartLand}), and every lot
	 * site's standing score and changed cells ({@link LotLand}). It reads and never writes (no journal, record, IR, answer or world
	 * change), loads no chunk (cells of unloaded chunks are counted in {@link LandReport#unloaded()}), takes no ticket and costs $0; it
	 * runs over ticks within the queue's budget. A player who flipped a gate mechanism's lever has not changed the land: a mechanism's
	 * moving and trigger cells and its blocks' dynamic properties are not judged. Cells a survival target, construction road or lot still
	 * building has not built yet are not counted. {@code part}: only that part (no lots); null: every part, and the lots. At most 4M
	 * cells per call: a larger region refuses {@link Reason#REGION_LIMIT} unasked a part (ask per part). An unknown region refuses
	 * {@link Reason#OTHER}; a removed one {@link Reason#NOT_ALLOWED}. Server thread; the future completes on it. Since 1.51.0, feature
	 * {@code "landCheck"}.
	 */
	default CompletableFuture<LandReport> landCheck(String regionId, @Nullable String part) {
		throw new UnsupportedOperationException("Regions.landCheck needs Architect API 1.51.0");
	}

	/**
	 * (6d AD) Adopts a standing VillageLayout settlement as a region (docs/CONTRACT.md "Phase 6d slice AD" §2) <b>without writing a cell</b>:
	 * no block, no journal cell, no ticket, no prepare. Checks first ({@link Reason#NOT_ALLOWED} naming the site): every site is the owner's,
	 * standing, inside the claim and in no region; the roads are 4e roads along the given street line; every lot site's box faces the street; a
	 * survival construction site (or one under a shared crate) is refused; the claim overlaps no other region and no other owner's protected
	 * area ({@link Reason#OVERLAP}, {@link Reason#PROTECTED}). Then the kit's {@code adopted_village} program describes the settlement as the
	 * region's IR (its lots, its street roads flagged {@code architect_mc:street {zone: "village"}}, V's graph, no parts), a plan/0 artifact is
	 * kept for it ({@code region.adopted: true}; its plan's zone {@code village} lists the lots, so a revision plan naming it as
	 * {@code parentArtifact} grows the village), and the sites move into the region's new group (stage {@code adopted}), crash safely: the
	 * journal's group of each of their entries and their head records, {@code architect-sites.json}, then the region record. Site ids never
	 * change; each site's membership becomes the region's ({@code lot:<id>}, {@code road:street_<n>}). While it runs the region reads
	 * {@link RegionState#PREPARING} and the sites refuse deltas and removal {@link Reason#SITE_BUSY}. Answers the region, {@link RegionState#PLACED},
	 * its ext {@code architect_mc:adopted} and {@code architect_mc:artifact}. Afterwards it grows ({@link #planRevision}, a revision plan of its
	 * artifact), revises and is removed ({@link #remove}) as any region. Needs the helper (sidecar). Server thread; the future completes on it.
	 * Since 1.52.0, feature {@code "regionAdopt"}.
	 */
	default CompletableFuture<RegionView> adopt(AdoptRegionRequest r) {
		throw new UnsupportedOperationException("Regions.adopt needs Architect API 1.52.0");
	}

	/**
	 * (6d AD, §3) Undoes an adoption: only an adopted region at position 0 (no revision accepted) in state {@link RegionState#PLACED}, else
	 * {@link Reason#NOT_ALLOWED}. Each site goes back to its old group's stage (or a stage {@code readopted} appended), keeping every change made
	 * to that group since; a site whose old group is gone gets a new standalone group (named in the result). Nothing is written to the world;
	 * the region record is deleted. Crash safe as adoption. Since 1.52.0, feature {@code "regionAdopt"}.
	 */
	default CompletableFuture<UnadoptResult> unadopt(String regionId) {
		throw new UnsupportedOperationException("Regions.unadopt needs Architect API 1.52.0");
	}

	/**
	 * (7b) The affordances a region plan found in its land ({@code affordances[]} in its plan JSON; docs/CONTRACT.md "Phase 7b" §2):
	 * read by this accessor, so {@link RegionPlan} gains no component. An empty list for a plan with none (every plan before slice
	 * AF, and every plan whose program never calls {@code r.affordances(box)}); empty (no list) for an unknown plan id. Kept with the plan
	 * record, so it answers after a world restart. Server thread. Built by slice AF (feature {@code "siteSurvey"}). Since 1.53.0.
	 */
	default Optional<java.util.List<Affordance>> affordances(String planId) {
		throw new UnsupportedOperationException("Regions.affordances needs the Architect API since 1.53.0 (slice AF)");
	}

	// ------------------------------------------------------------------ phase 7c: composition (docs/CONTRACT.md "Phase 7c" §2)

	/**
	 * (7c) The capability catalogue's long text for the named kinds (docs/CONTRACT.md "Phase 7c" §2, "catalogue text on demand"): the
	 * same envelope as {@link #planCatalogue()} ({@code catalogueVersion, api, kitVersion, schemaVersion}) with {@code entries} holding
	 * only the named kinds, in catalogue order, each the full entry {@link #planCatalogue()} answers plus {@code def}: the kind's plan/0
	 * definition with every description (its supported def, or a reserved kind's draft; absent when the kind has none), and
	 * {@code unknown}: the named ids the catalogue lacks, sorted. The compact plan/0 the plan writer reads ({@code plan/0#compact})
	 * carries one line per kind; this answers the rest for the kinds a plan uses or a check answers. Synchronous, read from the mod
	 * jar like {@link #planCatalogue()} (no sidecar, no claim); any thread; a fresh copy each call. Since 1.55.0.
	 */
	default com.google.gson.JsonObject planCatalogue(Set<String> kinds) {
		throw new UnsupportedOperationException("Regions.planCatalogue(kinds) needs Architect API 1.55.0 (slice 7cF)");
	}

	/**
	 * (7c) The standalone composer (docs/CONTRACT.md "Phase 7c" §2, slice CO, S-7c-2): a template pick first; without a fit, a
	 * structured job writes plan/0 parts from the brief, then {@link #checkPlan} and one repair round. Completes with a design id of
	 * kind {@code settlement}, whose result holds {@code outcome} ({@code PICKED}, {@code COMPOSED} or {@code NO_PLAN}), {@code plan},
	 * {@code check} and {@code cost}. For players and tests; (Noah, 2026-11-13) Architect owns the composer engine and Steward moves its plan
	 * writing onto this call later, with its card as the brief and {@link ComposeRequest}'s ext keys. Built by slice CO (feature
	 * {@code "compose"}); until then it throws. Since 1.55.0.
	 * <p>
	 * (7c CO, as built; docs/CONTRACT.md "Slice CO as built") The claim is in the Overworld (as {@link #checkPlan}'s); the design's owner
	 * is the player (the request has none), and the composed plan may name the built-in {@code claim_*} anchors and the caller's own
	 * ({@link ComposeRequest#EXT_HINTS}'s {@code anchors}). The pick is
	 * {@link #design}'s (TC's template catalogue and land check); a fit ends {@code PICKED} with {@code program}, {@code params} and, once
	 * the mod planned it, {@code planId}. Without one, each round's plan is checked by {@link #checkPlan} (the design's Style as the bible),
	 * and one repair round gets the typed answers: {@code COMPOSED} when a round checks READY ({@code check.artifactSha} is what
	 * {@link #realiseApproved} takes), else {@code NO_PLAN} with the best round's {@code plan}, {@code check} and {@code waits} (its parts not
	 * fits or adjusted, each with its {@code block} and the catalogue's {@code until}). {@code images}: the planning images ({@code result.images}
	 * blob ids) go to the composing job. The same {@code opKey} and body adopt the first design; another body refuses OP_KEY_CONFLICT. Since 1.58.0.
	 */
	default CompletableFuture<String> compose(ComposeRequest request) {
		throw new UnsupportedOperationException("Regions.compose is reserved: it throws until slice CO ships (feature compose)");
	}

	/**
	 * (7c) Program authoring (docs/CONTRACT.md "Phase 7c" §2, slice AU, S-7c-5): an authoring session writes a region program on the
	 * plan path only, checker-driven, at most 4 rounds. Completes with the authored program id; its result holds the outcome
	 * ({@code AUTHORED} or {@code NOT_SHOWN}), the rounds, the checker findings and the cost. Runs under the caller's budget and the
	 * player's approval. Built by slice AU (feature {@code "programAuthoring"}); until then it throws. Since 1.55.0.
	 */
	default CompletableFuture<String> authorProgram(AuthorRequest request) {
		throw new UnsupportedOperationException("Regions.authorProgram is reserved: it throws until slice AU ships (feature programAuthoring)");
	}

	/**
	 * (M5 QT, Steward's S-M5-7) A read-only, $0 quote of a plan's whole survival bill with these lot entries: what {@link #realise} of
	 * {@code planId} with {@code lotEntries} ({@code lot -> id} or {@code id@version}) would take from the owner's stockpile, per item, in the
	 * plan check's {@code cost.bom} shape ({@link Quote}): the region's paid cells, every bound lot entry (its construction bill at the fit the
	 * realise places it), the 4e roads, a first realise's gate mechanisms and the fluids' charge. A revision plan ({@link #planRevision}) is
	 * quoted against its standing region: its own parts, its lots and its refills (each refill lot needs its entry here, as the realise
	 * does). Nothing is consumed, reserved, journaled or written, no chunk is loaded and no helper is asked: the bill is measured over the land
	 * as it is now (loaded chunks; a lot in unloaded ones is not {@link Quote#exact() exact}). A creative (INSTANT) plan answers an empty bill
	 * with {@code survival} false. Refusals: an unknown or discarded plan {@link Reason#PLAN_STALE}; a survival plan planned before this
	 * API (no tile bill kept) {@link Reason#PLAN_STALE} (detail {@code no_bill}: plan it again); an entry not in the library
	 * {@link Reason#UNKNOWN_BLUEPRINT}; an entry too big for its lot {@link Reason#LOT_TOO_SMALL}; a site lot's entry that does not bind
	 * {@link Reason#SITE_MISMATCH}; a revision whose region is gone {@link Reason#OTHER}. Server thread; the future completes on it. Since
	 * 1.55.0, feature {@code "quote"}.
	 */
	default CompletableFuture<Quote> quote(String planId, java.util.Map<String, String> lotEntries) {
		throw new UnsupportedOperationException("Regions.quote needs Architect API 1.55.0");
	}

	/**
	 * (M5 QT, Steward's review change 1) {@link #quote} of an approved artifact, as {@link #realiseApproved} would realise it: its own plan,
	 * with the artifact's lot entries and then {@code lotEntries} over them ({@link #checkPalette}'s merge). The same {@link Quote}, read-only,
	 * $0: no pin, no retention touch, no key. An unknown or removed artifact refuses {@link Reason#ARTIFACT_UNAPPROVED}; otherwise as
	 * {@link #quote}. Server thread. Since 1.55.0, feature {@code "quote"}.
	 */
	default CompletableFuture<Quote> quoteApproved(String artifactSha, java.util.Map<String, String> lotEntries) {
		throw new UnsupportedOperationException("Regions.quoteApproved needs Architect API 1.55.0");
	}
}
