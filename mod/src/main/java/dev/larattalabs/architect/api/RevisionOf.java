package dev.larattalabs.architect.api;

/**
 * (6d RV) What a revision plan revises ({@link RegionPlan#revisionOf()}): the standing region, the revision's id ({@code rid}: monotonic per
 * region, never reused), the place it takes in the head chain if accepted ({@code position}), and the parent it was planned on (its
 * {@code rid}, 0 for the realised plan, and its IR sha). A realise of the plan accepts it only while that parent is still the head
 * (otherwise {@link Reason#PLAN_STALE}, nothing written). Since 1.43.0.
 */
public record RevisionOf(String region, int rid, int position, int parentRid, String parentIrSha) {
}
