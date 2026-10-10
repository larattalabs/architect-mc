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
}
