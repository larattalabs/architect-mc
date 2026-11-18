package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A realised (or realising) region: its group, state, per-stage progress, lots, cells written and skipped (per reason:
 * {@code condition}, {@code owned}, {@code claim}, {@code same}), what it waits for, and its prepare. Since 1.8.0.
 *
 * <p>Since 1.9.0: {@code actions}, what a caller can do about {@code waiting} ({@link WaitAction}, {@link Regions#nudge});
 * empty when the region waits for nothing it can act on. {@code REGION_STATE} also fires when the actions change.
 *
 * <p>Since 1.67.0 (feature {@code "removalStop"}): {@code removalStop}, how its last removal stopped ({@link RemovalStop}: NOT_STARTED, nothing
 * written, apart from PARTIAL, part taken down), and {@code removalStopReason}, that removal's blockers joined (null with NONE).
 *
 * <p>(S-DRS-1, feature {@code "removalStopCause"}; Since NEXT) {@code removalStopCause}: that stop's typed cause ({@link RemovalStopCause}:
 * SAVE_REFUSED, PLAYER_IN_BOX, COVERED, CARGO, THINGS_IN_BOX, else OTHER), so a caller tells a refused save apart without parsing
 * {@code removalStopReason} (whose text is unchanged); null with {@link RemovalStop#NONE}.
 *
 * <p>(8b, Steward's S-8b-8; Since NEXT) {@code besideNote}: the typed home of ext {@code architect_mc:beside} ({@link BesideNote}; null for a
 * region not planned beside one); {@code land}: of ext {@code architect_mc:land} ({@link RegionLand}; null for a region that is not a
 * districts region). The ext keys stay.
 */
public record RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
	RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
	@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits, @Nullable String beside,
	@Nullable RegionBuild build, int position, @Nullable String busy, List<RevisionView> revisions, RemovalStop removalStop,
	@Nullable String removalStopReason, @Nullable RemovalStopCause removalStopCause, @Nullable BesideNote besideNote, @Nullable RegionLand land) {
	public RegionView {
		removalStop = removalStop == null ? RemovalStop.NONE : removalStop;
		ext = ext == null ? new JsonObject() : ext;
		stages = List.copyOf(stages);
		lots = List.copyOf(lots);
		cellsSkipped = Map.copyOf(cellsSkipped);
		actions = actions == null ? List.of() : List.copyOf(actions);
		buildHits = buildHits == null ? List.of() : List.copyOf(buildHits);
		revisions = revisions == null ? List.of() : List.copyOf(revisions);
	}

	/** The 1.67.0 constructor: no typed stop cause (null). */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits, @Nullable String beside,
		@Nullable RegionBuild build, int position, @Nullable String busy, List<RevisionView> revisions, RemovalStop removalStop,
		@Nullable String removalStopReason) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, buildHits,
			beside, build, position, busy, revisions, removalStop, removalStopReason, null, null, null);
	}

	/** The 1.43.0 constructor: no removal stop (since 1.67.0: {@link RemovalStop#NONE}, no reason). */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits, @Nullable String beside,
		@Nullable RegionBuild build, int position, @Nullable String busy, List<RevisionView> revisions) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, buildHits,
			beside, build, position, busy, revisions, RemovalStop.NONE, null);
	}

	/**
	 * The 1.38.0 constructor: no revisions (since 1.43.0, 6d RV: {@code position}, the head's place in the revision chain, 0 when unrevised;
	 * {@code busy}, {@code revising <rid>} or {@code undoing <opId>} while a revision writes or an undo runs, else null; {@code revisions},
	 * every revision but candidates, oldest first).
	 */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits, @Nullable String beside,
		@Nullable RegionBuild build) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, buildHits,
			beside, build, 0, null, List.of());
	}

	/**
	 * The 1.27.0 constructor: no build (since 1.38.0, 6c RS: a survival region's {@link RegionBuild}, its targets' progress per part; null for
	 * a creative region).
	 */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits, @Nullable String beside) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, buildHits,
			beside, null);
	}

	/**
	 * The 1.24.0 constructor: no beside (since 1.27.0: the standing region this region was planned beside, {@link RegionPlanRequest#beside};
	 * null for any other region; its join's end is reported as dangling in this region's ext {@code architect_mc:beside} once the
	 * standing region is removed).
	 */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush, List<BuildHit> buildHits) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, buildHits, null);
	}

	/** The 1.21.0 constructor (no build findings). */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt, @Nullable String brush) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, brush, List.of());
	}

	/**
	 * The 1.14.0 constructor: no brush (since 1.21.0: the {@link BrushKind} name of a brush stroke's region, {@link Regions#brush};
	 * null for any other region).
	 */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions, long removedAt) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, removedAt, null);
	}

	/** The 1.9.0 constructor: no removedAt (since 1.14.0: when a {@link RegionState#REMOVED} tombstone's removal finished, epoch ms; 0 for any other state). */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare, List<WaitAction> actions) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, actions, 0L);
	}

	/** The 1.8.0 constructor: no actions. */
	public RegionView(String id, String planId, String irSha, @Nullable String owner, JsonObject ext, String groupId, BoundingBox claim,
		RegionState state, List<StageProgress> stages, List<LotState> lots, long cellsWritten, Map<String, Long> cellsSkipped, @Nullable Refusal waiting,
		@Nullable PrepareView prepare) {
		this(id, planId, irSha, owner, ext, groupId, claim, state, stages, lots, cellsWritten, cellsSkipped, waiting, prepare, List.of());
	}
}
