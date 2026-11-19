package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (6d RV) One revision of a region ({@link RegionView#revisions()}), docs/CONTRACT.md "Phase 6d slice RV" §4.1, §11. {@code rid}: its id
 * (never reused); {@code position}: its place in the head chain (0 is the realised plan); {@code parentRid}; {@code planId} and
 * {@code irSha}: its plan; {@code state}: {@code CANDIDATE}, {@code ACCEPTED}, {@code PLACING}, {@code PLACED}, {@code PARTIAL},
 * {@code FAILED}, {@code UNDOING}, {@code UNDONE} or {@code STALE} (a revision's outcome lives only here: the region reads its own
 * pre-revision state again once the revision ends); {@code stages}: its journal stages ({@code rv<rid>:<stage>}); {@code lotsAdded},
 * {@code lotsRefilled}; {@code cells} written; {@code artifact}: the plan artifact it was realised from, if any; {@code survivalAllowed};
 * {@code waiting}: what it waits for, or why it stopped; {@code sites}: every site it wrote (its tile cell sites, roads and lots, in
 * write order), each also carrying ext {@code architect_mc:revision {region, rid}}, so one revision is one history entry. Since 1.43.0.
 *
 * <p>(RVC, Steward's 8bS-1, feature {@code "revisionStopCause"}; Since 1.70.0) {@code removalStopCause}: the typed cause of {@code waiting}, as
 * {@link RegionView#removalStopCause()}: a revision left {@code UNDOING} by a stopped undo ({@link Regions#undoRevision}) carries its stage
 * removal's cause ({@link RemovalStopCause}: SAVE_REFUSED, PLAYER_IN_BOX, COVERED, CARGO, THINGS_IN_BOX, else OTHER), so a caller tells a
 * refused save apart without parsing {@code waiting} (whose text is unchanged). Null when {@code waiting} is null; any other wait (a
 * revision's own write that stopped) is OTHER.
 */
public record RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt, List<String> stages,
	List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact, boolean survivalAllowed, @Nullable String waiting,
	List<String> sites, @Nullable RemovalStopCause removalStopCause) {
	public RevisionView {
		removalStopCause = waiting == null ? null : removalStopCause == null ? RemovalStopCause.OTHER : removalStopCause;
		stages = List.copyOf(stages);
		lotsAdded = List.copyOf(lotsAdded);
		lotsRefilled = List.copyOf(lotsRefilled);
		sites = sites == null ? List.of() : List.copyOf(sites);
	}

	/** The 1.43.0 constructor: no typed stop cause (since 1.70.0: null when not waiting, else OTHER). */
	public RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt, List<String> stages,
		List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact, boolean survivalAllowed, @Nullable String waiting,
		List<String> sites) {
		this(rid, position, parentRid, planId, irSha, state, createdAt, stages, lotsAdded, lotsRefilled, cells, artifact, survivalAllowed, waiting, sites,
			null);
	}

	/** The contract's §11 shape (no sites). */
	public RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt, List<String> stages,
		List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact, boolean survivalAllowed, @Nullable String waiting) {
		this(rid, position, parentRid, planId, irSha, state, createdAt, stages, lotsAdded, lotsRefilled, cells, artifact, survivalAllowed, waiting, List.of());
	}
}
