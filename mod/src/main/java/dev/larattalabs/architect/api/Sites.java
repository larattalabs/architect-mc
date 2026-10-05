package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * The placed sites of one world. Server thread.
 *
 * <p>Owner and requester are guardrails, not security: any mod in the same JVM can pass any string. They prevent accidental
 * removal of another mod's sites. The rule that matters (INSTANT in a survival world) is checked against a real actor.
 */
public interface Sites {
	/** Every site, in placement order. Server thread (the construction progress counts read the world). */
	List<SiteView> list();

	/** The sites whose owner equals {@code owner} (null: the player's own sites, those without an owner). Server thread. */
	List<SiteView> list(@Nullable String owner);

	Optional<SiteView> get(String siteId);

	/**
	 * Places a site: the same checks, snapshot and survival rules as the UI. A refused placement completes with
	 * {@code placed == false} and every typed refusal (and fires {@link SiteEvents#PLACE_FAILED}); a placed one fires
	 * {@link SiteEvents#SITE_PLACED}. Never loads or generates a chunk: an unloaded site is refused {@link Reason#NOT_LOADED}.
	 */
	CompletableFuture<PlaceResult> place(PlaceRequest r);

	/**
	 * Removes (in survival: deconstructs) a site and restores its terrain exactly. A site owned by someone other than
	 * {@code o.requester()} needs {@code o.force()}. Things in the box the site did not bring (the player's chests, pets,
	 * dropped items) always refuse with {@code blockers}: the API never destroys them, force or not.
	 */
	CompletableFuture<RemoveResult> remove(String siteId, RemoveOptions o);

	/** A dry run of {@link #place}: refusals, notes, the bill of materials and the boxes. No side effects, never loads a chunk. */
	Verdict check(PlaceRequest r);

	/**
	 * The world's survival toggle: construction sites on or off, the build speed, and who may change it. Server thread (any
	 * thread works; it reads a volatile). Changes fire {@link SiteEvents#WORLD_MODE_CHANGED}. Since 1.2.0.
	 */
	SurvivalInfo survival();

	// ------------------------------------------------------------------ 1.4.0: batches, site groups, stages (docs/CONTRACT.md phase 4d)
	// Default methods throw UnsupportedOperationException, so implementations written against 1.3.0 still link.

	/**
	 * Queues a batch: its items are placed over ticks under the per-tick time budget, near the players, in stage / after /
	 * list order (see {@link Batch}). Completes with the batch id once it is queued (and persisted); fails with an
	 * {@link IllegalArgumentException} when the batch itself is refused: duplicate item keys or stage names (also against the
	 * group it appends to), an unknown or cyclic {@code after}, an {@code after} pointing into a later stage, another owner's
	 * group, an id in use. A single item the world refuses for good (an actorless INSTANT in a survival world, an unknown
	 * design) does not refuse the batch: it fails at once with {@link SiteEvents#ITEM_FAILED}. Since 1.4.0.
	 */
	default CompletableFuture<String> queue(Batch batch) {
		throw new UnsupportedOperationException("Sites.queue needs Architect API 1.4.0");
	}

	/** A batch (running or finished; finished ones are kept until the world stops). Since 1.4.0. */
	default Optional<BatchView> batch(String batchId) {
		throw new UnsupportedOperationException("Sites.batch needs Architect API 1.4.0");
	}

	/** Every batch whose owner is {@code owner} (null: the player's). Since 1.4.0. */
	default List<BatchView> batches(@Nullable String owner) {
		throw new UnsupportedOperationException("Sites.batches needs Architect API 1.4.0");
	}

	/**
	 * Cancels a running batch: placed items stay placed (and in the group); the item being placed is rolled back from its
	 * snapshot, exactly; items not started are dropped, each with {@link SiteEvents#ITEM_FAILED} ({@link Reason#CANCELLED});
	 * then {@link SiteEvents#BATCH_DONE} (cancelled). Completes with the final view once the rollback finished. The group
	 * remains. Since 1.4.0.
	 */
	default CompletableFuture<BatchView> cancelBatch(String batchId) {
		throw new UnsupportedOperationException("Sites.cancelBatch needs Architect API 1.4.0");
	}

	/** The site groups whose owner is {@code owner} (null: the player's). Since 1.4.0. */
	default List<SiteGroup> groups(@Nullable String owner) {
		throw new UnsupportedOperationException("Sites.groups needs Architect API 1.4.0");
	}

	default Optional<SiteGroup> group(String groupId) {
		throw new UnsupportedOperationException("Sites.group needs Architect API 1.4.0");
	}

	/**
	 * Removes every site of a group in reverse placement order, over ticks under the same budget (survival sites deconstruct
	 * with refunds), after cancelling a batch of the group that is still running. Completes when all are restored: removed,
	 * with every refund; or not removed with the blockers of the site it stopped at (the player's things in its box; the
	 * sites before it stay removed). A player standing in a box is waited for (up to 10 min). Another owner's group needs
	 * {@code o.force()}. Since 1.4.0.
	 */
	default CompletableFuture<RemoveResult> removeGroup(String groupId, RemoveOptions o) {
		throw new UnsupportedOperationException("Sites.removeGroup needs Architect API 1.4.0");
	}

	/** Approves a planned stage: it places once the stages before it are finished. Throws {@link IllegalStateException} otherwise. Since 1.4.0. */
	default Stage approveStage(String groupId, String stage) {
		throw new UnsupportedOperationException("Sites.approveStage needs Architect API 1.4.0");
	}

	/** Skips a stage that has not started placing: its items fail {@link Reason#CANCELLED}. Since 1.4.0. */
	default Stage skipStage(String groupId, String stage) {
		throw new UnsupportedOperationException("Sites.skipStage needs Architect API 1.4.0");
	}

	/**
	 * Reorders the group's planned stages: {@code names} lists every planned stage exactly once, in the new order; they take
	 * the planned stages' places, the other stages keep theirs. Returns every stage. Since 1.4.0.
	 */
	default List<Stage> reorderStages(String groupId, List<String> names) {
		throw new UnsupportedOperationException("Sites.reorderStages needs Architect API 1.4.0");
	}

	/** {@link #undoStage(String, String, boolean)} without force. Since 1.4.0. */
	default CompletableFuture<RemoveResult> undoStage(String groupId, String stage) {
		return undoStage(groupId, stage, false);
	}

	/**
	 * Removes a placed (or partial) stage's sites in reverse placement order, over ticks; the stage becomes {@code UNDONE}.
	 * Refused (a failed future, {@link IllegalStateException}) while a later stage is placed, unless {@code force}. Since 1.4.0.
	 */
	default CompletableFuture<RemoveResult> undoStage(String groupId, String stage, boolean force) {
		throw new UnsupportedOperationException("Sites.undoStage needs Architect API 1.4.0");
	}

	/** The group's stockpile: delivered, credit, the outstanding bill of materials per site and in total. Since 1.4.0. */
	default Stock stock(String groupId) {
		throw new UnsupportedOperationException("Sites.stock needs Architect API 1.4.0");
	}

	/**
	 * Fits a design to a lot (MUST 1 of Steward's 4d review): the rotation that makes the entrance face {@code streetSide}, the
	 * box centred across the street, set back from the street edge, at the lot's ground height ({@code lot.minY()}), plus
	 * the normal verdict there. {@code streetSide}: the lot side the street runs along (NORTH = the lot's minZ edge). No
	 * placement happens. Since 1.4.0.
	 */
	default LotFit fitToLot(String blueprintId, BoundingBox lot, Direction streetSide, FitOptions options) {
		throw new UnsupportedOperationException("Sites.fitToLot needs Architect API 1.4.0");
	}

	/** How far a design's restore box reaches past its template box in the worst case (sides and back: 0). Since 1.4.0. */
	default OverlapMargin overlapMargin(String blueprintId) {
		throw new UnsupportedOperationException("Sites.overlapMargin needs Architect API 1.4.0");
	}

	// ------------------------------------------------------------------ 1.5.0: journal-backed sites (docs/CONTRACT.md phase 4e)
	// place, check and queue honour PlaceRequest.overlap / Batch.overlap; remove, removeGroup and undoStage honour
	// RemoveOptions.covered. Default methods throw UnsupportedOperationException, so implementations written against 1.4.0 link.

	/**
	 * Places a road along a polyline (docs/CONTRACT.md phase 4e "Roads as sites"): a CELL site whose undo restores a cell only
	 * where the world still holds the road's block. A road never layers over buildings or roads: it skips every cell a site or
	 * road owns (and notes it); it layers over cell sites ({@link Reason#OVERLAP_OWNED} over another owner's, unless forced).
	 * Refusals: {@link Reason#TOO_STEEP}, {@link Reason#DEEP_WATER}, {@link Reason#OTHER} (too long: split it), the actor rules.
	 * Fires SITE_PLACED. Since 1.5.0.
	 */
	default java.util.concurrent.CompletableFuture<PlaceResult> placeRoad(RoadRequest r) {
		throw new UnsupportedOperationException("Sites.placeRoad needs Architect API 1.5.0");
	}

	/** A dry run of {@link #placeRoad}: refusals, notes, the cell count and box. Never loads a chunk. Since 1.5.0. */
	default Verdict checkRoad(RoadRequest r) {
		throw new UnsupportedOperationException("Sites.checkRoad needs Architect API 1.5.0");
	}

	/**
	 * Places a caller's cell list as a site (docs/CONTRACT.md phase 4e "Cell sites"). INSTANT only: refused
	 * {@link Reason#NOT_ALLOWED} for CONSTRUCTION, and where INSTANT is not allowed; {@link Reason#TOO_LARGE} over 1,000,000
	 * cells. Written over ticks. Fires SITE_PLACED. Since 1.5.0.
	 */
	default java.util.concurrent.CompletableFuture<PlaceResult> placeCells(CellsRequest r) {
		throw new UnsupportedOperationException("Sites.placeCells needs Architect API 1.5.0");
	}

	/** A dry run of {@link #placeCells}. Since 1.5.0. */
	default Verdict checkCells(CellsRequest r) {
		throw new UnsupportedOperationException("Sites.checkCells needs Architect API 1.5.0");
	}

	/**
	 * {@link #undoStage(String, String, boolean)} with remove options: {@code force} and the covered policy (cells of the stage's
	 * sites another site covers: KEEP, CASCADE or REFUSE). Since 1.5.0.
	 */
	default java.util.concurrent.CompletableFuture<RemoveResult> undoStage(String groupId, String stage, RemoveOptions o) {
		throw new UnsupportedOperationException("Sites.undoStage(RemoveOptions) needs Architect API 1.5.0");
	}

	/** The stack at a cell: every standing site's layer there, bottom first (the last one is what the world shows). Since 1.5.0. */
	default List<Layer> stack(net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> dimension, net.minecraft.core.BlockPos pos) {
		throw new UnsupportedOperationException("Sites.stack needs Architect API 1.5.0");
	}
}
