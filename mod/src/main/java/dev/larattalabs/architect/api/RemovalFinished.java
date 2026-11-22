package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (slice T4c) A removal finished: {@link SiteEvents#REMOVAL_FINISHED}'s payload. It fires once a removal is done, both for one whose call
 * answered at once and for a decided one whose call answered {@code SITE_BUSY held(decided)} and that finished by itself later (after a
 * restart too). At least once: listeners stay idempotent.
 *
 * (slice T4R) One logical completion per removal: a whole region's removal fires one event of kind {@code "region"} (never a {@code "group"}
 * one beside it); a group's or stage's is persisted with its txn and fired again after a restart until delivered.
 *
 * @param kind       {@code "site"} (a site, a road or a cell site), {@code "group"} (a whole group or one stage of it) or {@code "region"}
 * @param id         the site's, road's, group's or region's id
 * @param stage      the stage undone, for a stage's removal; else null
 * @param revisionId the rid of the region revision whose undo removed the stage ({@code Regions.undoRevision}, {@code RevisionView.rid}), when one did; else null
 * @param result     the removal's full result, its {@code owed} keys included (never PARTIAL: a removal that finishes is removed)
 * Since 1.72.0.
 */
public record RemovalFinished(String kind, String id, @Nullable String stage, @Nullable Integer revisionId, RemoveResult result) {
	public static final String SITE = "site";
	public static final String GROUP = "group";
	public static final String REGION = "region";
}
