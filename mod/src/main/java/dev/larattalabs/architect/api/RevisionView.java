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
 */
public record RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt, List<String> stages,
	List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact, boolean survivalAllowed, @Nullable String waiting,
	List<String> sites) {
	public RevisionView {
		stages = List.copyOf(stages);
		lotsAdded = List.copyOf(lotsAdded);
		lotsRefilled = List.copyOf(lotsRefilled);
		sites = sites == null ? List.of() : List.copyOf(sites);
	}

	/** The contract's §11 shape (no sites). */
	public RevisionView(int rid, int position, int parentRid, String planId, String irSha, String state, long createdAt, List<String> stages,
		List<String> lotsAdded, List<String> lotsRefilled, long cells, @Nullable String artifact, boolean survivalAllowed, @Nullable String waiting) {
		this(rid, position, parentRid, planId, irSha, state, createdAt, stages, lotsAdded, lotsRefilled, cells, artifact, survivalAllowed, waiting, List.of());
	}
}
