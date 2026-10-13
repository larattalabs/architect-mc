package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;
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

	/**
	 * Since 1.8.0: {@link #list(String)} hides a realised region's tile sites (its one row is {@code Regions.list}); with
	 * {@code includeTiles} they are listed too (debugging).
	 */
	default List<SiteView> list(@Nullable String owner, boolean includeTiles) {
		return list(owner);
	}

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

	/**
	 * A batch (running or finished). Since 1.4.0; since 1.10.0 finished batches are kept across restarts (the newest 256 per
	 * world and every one finished in the last 30 days, whichever keeps more), and batch ids are never reused.
	 */
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

	/**
	 * Predicts where a detail of a massing version will stand on a lot (docs/CONTRACT.md 6c slice 0a §4): the same fit as
	 * {@link #fitToLot}, on the massing version's template, with the normal verdict there. A detail of that version fitted to the
	 * same lot gets the same rotation and an origin within 2 on x and z (equal in y). An unknown massing or version is
	 * {@link Reason#UNKNOWN_BLUEPRINT}. No placement happens. Since 1.10.0.
	 */
	default LotFit fitMassingToLot(MassingRef massing, BoundingBox lot, Direction streetSide, FitOptions options) {
		throw new UnsupportedOperationException("Sites.fitMassingToLot needs Architect API 1.10.0");
	}

	/**
	 * The batch queued with this operation key by this owner (null: the player), in any state ({@link Batch#opKey}). Server
	 * thread. Since 1.10.0.
	 */
	default Optional<BatchView> batchByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Sites.batchByKey needs Architect API 1.10.0");
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

	// ------------------------------------------------------------------ phase 5b: delta apply (API 1.7.0)

	/**
	 * The verdict on a delta of a placed site to another version of its entry, before any write (Steward SHOULD 1: the preview as
	 * data). Changes nothing. Server thread. Since 1.7.0.
	 */
	default DeltaVerdict checkDelta(DeltaRequest r) {
		throw new UnsupportedOperationException("Sites.checkDelta needs Architect API 1.7.0");
	}

	/**
	 * Moves a placed site to another version of its entry by writing only the cells that differ, as a new journal layer
	 * (docs/CONTRACT.md phase 5b). Completes when the writes are done (a construction delta: when it starts; SITE_PROGRESS and
	 * SITE_BUILT follow). Refusals complete it with {@code applied} false. Fires SITE_UPDATED. Since 1.7.0.
	 */
	default CompletableFuture<DeltaResult> applyDelta(DeltaRequest r) {
		throw new UnsupportedOperationException("Sites.applyDelta needs Architect API 1.7.0");
	}

	/**
	 * Reverts a placed site to version {@code toVersion}: where INSTANT is allowed for {@code actor}, a version in the site's
	 * chain is reached by one undo of the deltas above it (last in, first out); any other target, and every revert in survival, is
	 * a (paid) forward delta. Fires SITE_UPDATED. Since 1.7.0.
	 */
	default CompletableFuture<DeltaResult> revert(String siteId, int toVersion, net.minecraft.server.level.@Nullable ServerPlayer actor) {
		throw new UnsupportedOperationException("Sites.revert needs Architect API 1.7.0");
	}

	/** A placed site's history, oldest first. Since 1.7.0. */
	default List<SiteVersion> history(String siteId) {
		throw new UnsupportedOperationException("Sites.history needs Architect API 1.7.0");
	}

	/**
	 * The standing sites of {@code owner} (null: the player's own) whose pinned version is older than their entry's head
	 * (Steward SHOULD 3): call it at world load, since ENTRY_VERSIONED is missed while the world is closed. Since 1.7.0.
	 */
	default List<OutdatedSite> outdated(@Nullable String owner) {
		throw new UnsupportedOperationException("Sites.outdated needs Architect API 1.7.0");
	}

	// ------------------------------------------------------------------ 1.12.0 (docs/CONTRACT.md phase 6c slice 0c)

	/**
	 * Marks a protected area (C17, §8): ops of {@code a.owner()} started from now on that would write into it are refused
	 * {@link Reason#PROTECTED}, whatever their {@code force}. The same (owner, id) replaces. Throws IllegalArgumentException for
	 * a missing owner or id, an area over 4,096 columns on a side, or a 1,025th area of one owner. Server thread. Since 1.12.0.
	 */
	default ProtectedArea protect(ProtectedArea a) {
		throw new UnsupportedOperationException("Sites.protect needs Architect API 1.12.0");
	}

	/** Lifts a protected area; false when there was none. Server thread. Since 1.12.0. */
	default boolean unprotect(String owner, String areaId) {
		throw new UnsupportedOperationException("Sites.unprotect needs Architect API 1.12.0");
	}

	/** The protected areas of {@code owner}, or (null) of every owner. Since 1.12.0. */
	default List<ProtectedArea> protectedAreas(@Nullable String owner) {
		throw new UnsupportedOperationException("Sites.protectedAreas needs Architect API 1.12.0");
	}

	/**
	 * The smallest lot {@link #fitToLot} accepts for a design (§2): {@code alongStreet × deep} fits, one block less on either
	 * axis is {@link Reason#LOT_TOO_SMALL}. {@code o}'s setback and approachIntoStreet apply as in fitToLot. Since 1.12.0.
	 */
	default LotSize minLotSize(String blueprintId, FitOptions o) {
		throw new UnsupportedOperationException("Sites.minLotSize needs Architect API 1.12.0");
	}

	/** {@link #minLotSize(String, FitOptions)} for a massing. Since 1.12.0. */
	default LotSize minLotSize(MassingRef massing, FitOptions o) {
		throw new UnsupportedOperationException("Sites.minLotSize(MassingRef) needs Architect API 1.12.0");
	}

	/**
	 * (C25) The waiting status of a construction target: a building site or a construction road (by id). Empty when the id is not a
	 * construction target. A built target answers {@code waiting=false} with an empty list. Server thread. Since 1.15.0.
	 */
	default java.util.Optional<SiteWait> waiting(String targetId) {
		throw new UnsupportedOperationException("Sites.waiting needs Architect API 1.15.0");
	}

	// ------------------------------------------------------------------ 1.17.0 (docs/CONTRACT.md phase 6c slice Y, C24)

	/**
	 * Creates the owner's stockpile (C24), or adds the named crates to it: idempotent per owner. Every new construction item of
	 * the owner then draws from it and places no crate of its own. Refuses ({@link ArchitectRefused}) NOT_ALLOWED with the
	 * survival toggle off, for another dimension than the stockpile's, or for a crate cell that is not air or replaceable or lies
	 * in a standing site's restore box; PROTECTED in another owner's protected area; NOT_LOADED for an unloaded cell;
	 * FIELD_LIMIT past {@link Limits#STOCKPILE_CRATES} or for a missing owner. Server thread. Since 1.17.0.
	 */
	default Stockpile createStockpile(StockpileRequest r) {
		throw new UnsupportedOperationException("Sites.createStockpile needs Architect API 1.17.0");
	}

	/** Adds one crate (the rules of {@link #createStockpile}). Since 1.17.0. */
	default Stockpile addStockpileCrate(String owner, net.minecraft.resources.ResourceKey<net.minecraft.world.level.Level> dimension, BlockPos at) {
		throw new UnsupportedOperationException("Sites.addStockpileCrate needs Architect API 1.17.0");
	}

	/**
	 * Removes a crate: its cell gets its before-state back. Not removed (blockers say why) while it would leave the stock over
	 * capacity, unless {@code force}, which drops the excess at that cell (its {@code refund}: what dropped); the last crate with
	 * targets building is never removed. Removing the last crate with nothing building ends the stockpile. Since 1.17.0.
	 */
	default RemoveResult removeStockpileCrate(String owner, BlockPos at, boolean force) {
		throw new UnsupportedOperationException("Sites.removeStockpileCrate needs Architect API 1.17.0");
	}

	/** The owner's stockpile (C24's "stock(owner)"), or empty. Server thread. Since 1.17.0. */
	default Optional<Stockpile> stockpile(String owner) {
		throw new UnsupportedOperationException("Sites.stockpile needs Architect API 1.17.0");
	}

	/** The owner's building targets (sites, roads, delta sites), first fed first. Since 1.17.0. */
	default List<String> feedOrder(String owner) {
		throw new UnsupportedOperationException("Sites.feedOrder needs Architect API 1.17.0");
	}

	/**
	 * Moves the listed target ids to the front of the feed order, in that order (the others keep their relative order); returns
	 * the new order. Unknown or finished ids refuse FIELD_LIMIT naming them. Since 1.17.0.
	 */
	default List<String> setFeedOrder(String owner, List<String> ids) {
		throw new UnsupportedOperationException("Sites.setFeedOrder needs Architect API 1.17.0");
	}

	/**
	 * Takes credit (stock beyond what every building target still needs) out into the player's inventory; what doesn't fit drops
	 * at the player. Asking for more than the credit gives the credit. Returns what came out. Since 1.17.0.
	 */
	default Map<Item, Integer> withdraw(String owner, Map<Item, Integer> items, net.minecraft.server.level.ServerPlayer to) {
		throw new UnsupportedOperationException("Sites.withdraw needs Architect API 1.17.0");
	}

	/**
	 * Moves the owner's legacy crates (a site's own, a group's shared one, a delta's) into its stockpile: their stock joins it,
	 * their cells are restored, and their targets draw from the stockpile from now on. Idempotent. Since 1.17.0.
	 */
	default Stockpile adoptCrates(String owner) {
		throw new UnsupportedOperationException("Sites.adoptCrates needs Architect API 1.17.0");
	}

	/**
	 * Ends the owner's stockpile (an abandoned settlement): every unit, reserved or not, goes to {@code to} (its inventory, the
	 * overflow dropped at the player) or, with null, drops at a crate; every crate block is restored. Its building targets keep
	 * their state and wait with no stockpile. Returns what went out. Since 1.17.0.
	 */
	default Map<Item, Integer> dissolveStockpile(String owner, net.minecraft.server.level.@Nullable ServerPlayer to) {
		throw new UnsupportedOperationException("Sites.dissolveStockpile needs Architect API 1.17.0");
	}

	// ------------------------------------------------------------------ 6c slice SCH: Sponge schematics (API 1.18.0)

	/**
	 * Exports a site's current cells as a Sponge Schematic version 3 file ({@code <dir>/<siteId>.schem}, gzipped NBT;
	 * docs/CONTRACT.md "Phase 6c slice SCH"): every position of the site's box as the world holds it now (air included, in the
	 * world's orientation: the site's rotation is applied), with its block entities. {@code Offset} puts the entrance feet row at
	 * y 0; {@code Metadata} is {@code {Name, Author: "Architect", Date: now}}. Entities and biomes are not written. Fails
	 * {@link ArchitectRefused} {@link Reason#UNKNOWN_BLUEPRINT} for an unknown site, {@link Reason#NOT_LOADED} when a chunk of
	 * its box is not loaded and {@link Reason#WORLD_STOPPED} without a running world; an I/O error fails it as is. Completes on
	 * the server thread with the file written. Since 1.18.0.
	 */
	default java.util.concurrent.CompletableFuture<java.nio.file.Path> exportSiteSchematic(String siteId, java.nio.file.Path dir) {
		throw new UnsupportedOperationException("Sites.exportSiteSchematic needs Architect API 1.18.0");
	}

	// ------------------------------------------------------------------ 1.19.0 (docs/CONTRACT.md C29)

	/**
	 * Pauses ({@code paused} true) or resumes a building construction target (a site or a road; a stockpile's or one with its own
	 * crate), as the crate screen's Pause button does. A paused target places nothing, so it consumes nothing and reserves nothing
	 * in its stockpile's feed (others are fed past it), and keeps its state; resumed, it re-enters the feed at its old position in
	 * the order. The state is saved with the target. Idempotent. Refuses {@link ArchitectRefused} FIELD_LIMIT for an id that is no
	 * construction target building, NOT_ALLOWED for a target being removed. Server thread. Since 1.19.0.
	 */
	default void pause(String targetId, boolean paused) {
		throw new UnsupportedOperationException("Sites.pause needs Architect API 1.19.0");
	}

	// ------------------------------------------------------------------ 6c slice PT: player-placed tracking and builds (API 1.24.0)

	/**
	 * Who placed the block at {@code pos} and the build it is in (docs/CONTRACT.md "Phase 6c slice PT" §9). Empty when the cell is
	 * not tracked, or its chunk is not loaded. Blocks placed before tracking, by commands, dispensers or other mods' tools are
	 * never guessed as a player's. Server thread. Since 1.24.0.
	 */
	default Optional<PlacedBy> playerPlaced(ResourceKey<Level> dim, BlockPos pos) {
		throw new UnsupportedOperationException("Sites.playerPlaced needs Architect API 1.24.0");
	}

	/** The tracked cells of a box (loaded chunks only): counts, per placer, and the builds it meets. Server thread. Since 1.24.0. */
	default PlacedBox playerPlaced(ResourceKey<Level> dim, BoundingBox box) {
		throw new UnsupportedOperationException("Sites.playerPlaced needs Architect API 1.24.0");
	}

	/**
	 * The builds of a dimension (null: every dimension) meeting {@code within} (null: anywhere), by id; merged and gone builds are
	 * left out (S-PT-5's {@code builds(box)}). Server thread. Since 1.24.0.
	 */
	default List<Build> builds(@Nullable ResourceKey<Level> dim, @Nullable BoundingBox within) {
		throw new UnsupportedOperationException("Sites.builds needs Architect API 1.24.0");
	}

	/** One build by id; an alias of a merged build resolves to the survivor. Empty when unknown or gone. Since 1.24.0. */
	default Optional<Build> build(String id) {
		throw new UnsupportedOperationException("Sites.build needs Architect API 1.24.0");
	}

	/**
	 * "Claim my build" (§8): every non-air cell of {@code box} owned by no journal entry and not another placer's is marked as
	 * {@code actor}'s (null: the console, the nil placer) and the cells are one build in state CLAIMED (no promote bar, never
	 * demoted). For builds placed before tracking. A non-op actor: a box of at most 32x32x32 within 64 blocks of them, at most 8
	 * claims; ops: up to 4,096x4,096 columns. Refuses {@link ArchitectRefused} FIELD_LIMIT (the box), PERMISSION (the limits),
	 * NOT_LOADED. Server thread. Since 1.24.0.
	 */
	default Build claimBuild(ResourceKey<Level> dim, BoundingBox box, net.minecraft.server.level.@Nullable ServerPlayer actor) {
		throw new UnsupportedOperationException("Sites.claimBuild needs Architect API 1.24.0");
	}

	/**
	 * Releases a build (§8), by one of its placers or an op (null: the console): it becomes RELEASED; its cells stay tracked but
	 * incidental, and are not promoted again unless claimed or grown by 25% since. Refuses FIELD_LIMIT for an unknown id,
	 * PERMISSION for another player. Server thread. Since 1.24.0.
	 */
	default Build releaseBuild(String id, net.minecraft.server.level.@Nullable ServerPlayer actor) {
		throw new UnsupportedOperationException("Sites.releaseBuild needs Architect API 1.24.0");
	}

	// ------------------------------------------------------------------ 6c slice PT2: adopt a build as a site (API 1.26.0 placeholder)

	/**
	 * Adopts a standing player build as a site (docs/CONTRACT.md "Phase 6c slice PT2"): its cells (and the air in its columns) are
	 * captured as version 1 of a new library entry ({@code adopted_<8 hex>}, a captured source so {@code versionOf} works) and a new
	 * site stands on them, <b>without writing a block</b>. Updates, {@code versionOf}, {@code revert}, {@code outdated} and remove then
	 * work as on any site; a remove (or undo) of the adoption only un-adopts: the house stays. The build stays a build, state
	 * {@link BuildState#ADOPTED} with {@link Build#siteId()}, and keeps its protection; its site's own operations are implicitly
	 * consented for the site's own cells. Needs no mode, no items and no INSTANT permission.
	 *
	 * <p>{@code consent} must name the build and carry an actor who placed at least 10% of its cells or holds permission 2.
	 * {@code ext}: the caller's namespaced keys (at most 4096 characters as JSON), on the site; the mod then sets
	 * {@code architect_mc:adopted = {build, entry, at}}. {@code owner}: the site's owner (stockpile and {@code outdated} key on it).
	 * Completes exceptionally with {@link ArchitectRefused}: ADOPT_REFUSED ({@code not_a_build}, {@code provisional},
	 * {@code consent}, {@code already_adopted}, {@code tracking_off}), NOT_LOADED, OVERLAP (a tracked cell of the build is
	 * journal-owned), TOO_LARGE (over 96x64x96 or 262,144 captured cells), FIELD_LIMIT ({@code ext}), JOURNAL_UNAVAILABLE,
	 * WORLD_STOPPED, SITE_BUSY (a large capture that could not settle in 3 passes: retry). Since PT2.
	 */
	default CompletableFuture<AdoptResult> adopt(String buildId, @Nullable String owner, BuildConsent consent, com.google.gson.JsonObject ext) {
		throw new UnsupportedOperationException("Sites.adopt needs Architect API 1.26.0");
	}

	/** The site standing on a build (an alias resolves to its survivor), if it is adopted. Server thread. Since PT2. */
	default Optional<String> adoptedSite(String buildId) {
		throw new UnsupportedOperationException("Sites.adoptedSite needs Architect API 1.26.0");
	}
}
