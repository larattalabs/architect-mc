package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * Building design requests (the Design tab's pipeline, {@code design.request} over the mod's sidecar link). Thread-safe;
 * futures complete on the server thread. Progress and the result arrive as {@link SiteEvents#DESIGN_UPDATED} and
 * {@link SiteEvents#DESIGN_DONE}; when a design is done its library entry is loaded and carries the request's {@code ext}.
 * Remix = a request with {@code remix} set.
 *
 * <p>Since 1.2.0, design groups (docs/CONTRACT.md phase 4b "Design groups (A2, R9)"): {@link #requestGroup} makes up to 24
 * designs with one style bible; {@link SiteEvents#GROUP_UPDATED} / {@link SiteEvents#GROUP_DONE} report the group (each item's
 * own design also fires the DESIGN_ events). These need a helper with the {@code "designGroups"} feature.
 *
 * <p>Since 1.3.0, massings (docs/CONTRACT.md "Phase 4c contract"; a helper with the {@code "massing"} feature): a request with
 * {@link DesignRequest#massing(boolean) massing} makes a coarse volume design ({@link SiteEvents#MASSING_DONE}), a request
 * {@link DesignRequest#fromMassing(String) fromMassing} details it, {@link #redirectMassing} makes a new version from notes; a
 * {@link GroupRequest#massingFirst massingFirst} group waits for {@link #approveGroup}
 * ({@link SiteEvents#GROUP_AWAITING_APPROVAL}).
 *
 * <p>Since 1.6.0, critique (docs/CONTRACT.md "Phase 5a contract"; a helper with {@code "critique"}): a request or a group with
 * a {@link CritiqueSpec} is critiqued after it renders ({@link CritiqueMode#LOOP} revises on the verdict and installs the best
 * round); {@link SiteEvents#DESIGN_CRITIQUED} fires once per round, and {@link Design#critique()} carries the rounds.
 * {@link #critique} critiques an installed library entry (report only).
 */
public interface Designs {
	/** Sends the request; completes with the design id once the sidecar acked it, or fails (helper not running, refused). */
	CompletableFuture<String> request(DesignRequest r);

	void cancel(String designId);

	/**
	 * A design the helper reports. Since 1.43.0 (7a K3), ordering: a design reads as DONE only once its entry's new version is
	 * installed and loaded on the server, the same moment {@link SiteEvents#DESIGN_DONE} fires (a listener of DESIGN_DONE already
	 * sees DONE here). Until then a design the helper has finished reads as its last non-final status (as this game last saw it;
	 * RENDERING when it saw none). FAILED and CANCELLED are reported as soon as they are final.
	 */
	Optional<Design> get(String designId);

	/** Designs requested with {@code owner} (null: all designs the helper reports), newest first. */
	List<Design> list(@Nullable String owner);

	/** Starts a design group; completes with the group id ({@code g<n>}) once the sidecar acked it. Since 1.2.0. */
	CompletableFuture<String> requestGroup(GroupRequest r);

	/** A group with its addressable items. Since 1.2.0. */
	Optional<Group> group(String groupId);

	/**
	 * The groups of {@code owner} (null: all), including the ones that finished while the caller was away (kept across game
	 * restarts). Newest first. Since 1.2.0.
	 */
	List<Group> listGroups(@Nullable String owner);

	/** Cancels a group: queued items are cancelled, running ones stopped; finished items stay. Since 1.2.0. */
	CompletableFuture<Void> cancelGroup(String groupId);

	/**
	 * Raises a group's hard budget to {@code budgetUsd} (above what it spent). A group paused at its soft budget stays paused:
	 * {@link #resumeGroup} next. Since 1.2.0. Since 1.12.0, {@link #extend} also says whether the new budget's soft line is
	 * still under the spend (the group pauses again at once) and the smallest budget that isn't.
	 */
	CompletableFuture<Void> extendGroup(String groupId, double budgetUsd);

	/**
	 * {@link #extendGroup}, with the re-pause warning ({@link Extension}, docs/CONTRACT.md phase 6c slice 0c §6). The extend
	 * happens even when {@code pausesAgain}. Since 1.12.0.
	 */
	default CompletableFuture<Extension> extend(String groupId, double budgetUsd) {
		throw new UnsupportedOperationException("Designs.extend needs Architect API 1.12.0");
	}

	/** Resumes a group paused at its soft budget ({@link Group.Status#PAUSED_BUDGET}). Since 1.2.0. */
	CompletableFuture<Void> resumeGroup(String groupId);

	/** What the group would probably cost and take ({@code design.estimate}), before submitting it. Since 1.2.0. */
	CompletableFuture<Estimate> estimate(GroupRequest r);

	/** What one design would probably cost and take. Since 1.2.0. */
	CompletableFuture<Estimate> estimate(DesignRequest r);

	// ------------------------------------------------------------------ 1.6.0: critique

	/**
	 * A report critique of a library entry ({@code design.critique}, a helper with {@code "critiqueReport"}): one critic call on
	 * the entry's installed files (re-rendering the views it lacks), about $0.1; no new entry, no design turn. The verdict is
	 * written to the entry's {@code critique.json} ({@link Library.Entry#critique()}). Completes when that report design is done,
	 * with its critique (its id is in {@link Design#critiqueOf()} records, as DESIGN_UPDATED / DESIGN_DONE); fails when it is
	 * refused (a bundled entry, a spec whose mode is not report) or fails (the critic failed twice), or after
	 * {@code architect.api.critiqueTimeoutMs} (default 15 min). {@code spec}: null = report with the defaults; its model, effort,
	 * views and extra criteria apply. Since 1.6.0.
	 */
	CompletableFuture<Critique> critique(String entryId, @Nullable CritiqueSpec spec);

	// ------------------------------------------------------------------ 1.3.0: massings

	/**
	 * The latest version of a massing this game knows (from {@code massing.upsert}, the helper's snapshot and its full list,
	 * fetched on every connect; persisted in {@code <gameDir>/architect/api-massings.json}). Empty once deleted or collected.
	 * Since 1.3.0.
	 */
	Optional<Massing> massing(String massingId);

	/**
	 * One version of a massing, when this game has seen it (every version installed while the game was connected, plus the
	 * latest version of each massing on every connect). Since 1.3.0.
	 */
	Optional<Massing> massing(String massingId, int version);

	/** The latest version of each massing of {@code owner} (null: all), newest first. Since 1.3.0. */
	List<Massing> listMassings(@Nullable String owner);

	/**
	 * A new version of a massing from its latest one plus {@code notes} ({@code massing.redirect}); completes at the ack with
	 * the massing job and the version it makes. A group's massing goes through the group's rules (a redirect round of its
	 * item; with approvalUi owner, use {@link #redirectMassing(String, String, String)} with the group's owner). Since 1.3.0.
	 */
	default CompletableFuture<Group.Redirected> redirectMassing(String massingId, String notes) {
		return redirectMassing(massingId, notes, null);
	}

	/** {@link #redirectMassing(String, String)} as {@code owner} (a group massing with approvalUi owner needs the group's owner). Since 1.3.0. */
	CompletableFuture<Group.Redirected> redirectMassing(String massingId, String notes, @Nullable String owner);

	/**
	 * Deletes a massing and every version of it now ({@code massing.delete}, its folder included); completes with how many
	 * versions were deleted. Refused while a job makes or details it, or while its group is not final. Since 1.3.0.
	 */
	CompletableFuture<Integer> deleteMassing(String massingId);

	/**
	 * A massingFirst group's approval ({@code group.approve}): the {@code approve} items start their detail pass (bound to their
	 * latest massing version), each {@code redirect} item (itemKey -> notes) gets a new massing version, the {@code cancel}
	 * items are dropped. Validated as a whole (nothing happens when any part is refused: an unknown or not-waiting item, a
	 * redirect past maxRedirects, a spent budget). A group with approvalUi owner refuses this form: use
	 * {@link #approveGroup(String, List, Map, List, String)} with its owner. Since 1.3.0.
	 */
	default CompletableFuture<Group.Approval> approveGroup(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel) {
		return approveGroup(groupId, approve, redirect, cancel, null);
	}

	/** {@link #approveGroup(String, List, Map, List)} as {@code owner} (must be the group's owner when its approvalUi is owner). Since 1.3.0. */
	CompletableFuture<Group.Approval> approveGroup(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel,
		@Nullable String owner);

	// ------------------------------------------------------------------ phase 5b: polish (API 1.7.0)

	/**
	 * Polishes an installed entry (docs/CONTRACT.md phase 5b "Polish"): a critique (reused when the entry's critique.json is not
	 * stale), then up to {@code maxSteps} targeted steps confined to the parts the issues name, each accepted only when a fresh
	 * critic marks its issue resolved; at most one new version installs ({@link SiteEvents#ENTRY_VERSIONED}). Completes with the
	 * design id at the helper's ack; DESIGN_DONE carries {@link Design#polish()}. Bundled entries refuse (make a variant first),
	 * imported ones too (no source). Since 1.7.0.
	 */
	default CompletableFuture<String> polish(PolishRequest r) {
		throw new UnsupportedOperationException("Designs.polish needs Architect API 1.7.0");
	}

	/** What a polish would cost and take, as its own fields ({@link Estimate#polish}). Since 1.7.0. */
	default CompletableFuture<Estimate> estimatePolish(PolishRequest r) {
		throw new UnsupportedOperationException("Designs.estimatePolish needs Architect API 1.7.0");
	}

	/**
	 * What a mix of originals, adapted and copied buildings (and a new bible) would cost and take, with a line per kind
	 * ({@link Estimate#byKind}; docs/CONTRACT.md 6c slice 0a §3). The lines sum to the totals. Since 1.10.0.
	 */
	default CompletableFuture<Estimate> estimate(EstimateRequest r) {
		throw new UnsupportedOperationException("Designs.estimate(EstimateRequest) needs Architect API 1.10.0");
	}

	/**
	 * The group requested with this operation key by this owner (null: the player), in any state ({@link GroupRequest#opKey}).
	 * Empty means the helper never received it. Fails {@link ArchitectRefused} {@link Reason#SIDECAR_UNAVAILABLE} while the
	 * helper is not connected (never "empty" then). Since 1.10.0.
	 */
	default CompletableFuture<Optional<Group>> groupByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Designs.groupByKey needs Architect API 1.10.0");
	}

	/**
	 * The design requested with this operation key by this owner (null: the player), in any state ({@link DesignRequest#opKey}), from
	 * the helper's persisted record (also once it is out of the recent list, and after a restart: a keyed design is kept at least 30
	 * days after it is final). Empty means the helper never received it. Fails {@link ArchitectRefused}
	 * {@link Reason#SIDECAR_UNAVAILABLE} while the helper is not connected (never "empty" then); a helper without
	 * {@code "design.opKeys"} fails it too. Ordering as {@link #get}: DONE only once the entry's new version is installed and loaded
	 * on the server, when {@link SiteEvents#DESIGN_DONE} fires (a DONE record this game had not reported yet is installed and
	 * reported first, then answered). Since 1.43.0.
	 */
	default CompletableFuture<Optional<Design>> designByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Designs.designByKey needs Architect API NEXT");
	}

	/**
	 * Cancels a design and answers what happened ({@link CancelOutcome}; a helper with {@code "design.opKeys"}).
	 * {@link CancelOutcome.Kind#CANCELLED} completes only once the helper has confirmed the design is final and will spend nothing
	 * more: a running designer turn has actually stopped (its process is gone) and its internal calls have ended; a cost a turn
	 * reports after the cancel is never added, so the outcome's design carries the final cost. A design already cancelled answers
	 * CANCELLED again (a retry is safe). {@link CancelOutcome.Kind#ALREADY_FINAL} answers the finished design (DONE or FAILED) with
	 * its cost; {@link CancelOutcome.Kind#UNKNOWN}: no such design. A confirmed cancel still fires {@link SiteEvents#DESIGN_DONE}
	 * with status CANCELLED. Fails exceptionally while the helper can't be reached ({@link ArchitectRefused}
	 * {@link Reason#SIDECAR_UNAVAILABLE}), or when the turn has not stopped within the helper's wait (15 s; the design stays
	 * cancelled: ask again). Ordering as {@link #get}: a DONE design only once installed and loaded on the server. The old
	 * {@link #cancel} is unchanged. Since 1.43.0.
	 */
	default CompletableFuture<CancelOutcome> cancelDesign(String designId) {
		throw new UnsupportedOperationException("Designs.cancelDesign needs Architect API NEXT");
	}

	/**
	 * Make a copy a FALLBACK original (since 1.11.0, a helper with {@code "copies"}): for a copy that did not fit its lot at
	 * placement ({@code fitToLot}), or one whose archetype failed ({@code source_failed}). Under massingFirst it is a detail pass
	 * bound to the archetype's approved massing (no new approval); it costs as an original. Completes with the group as it
	 * stands. Fails {@link ArchitectRefused} {@link Reason#COPY_REFUSED} for a non-copy ({@code not_copy}), a copy still
	 * building ({@code building}) or a final group or cancelled item ({@code final}).
	 */
	default CompletableFuture<Group> promoteCopy(String groupId, String itemKey, String reason) {
		throw new UnsupportedOperationException("Designs.promoteCopy needs Architect API 1.11.0");
	}

	// ------------------------------------------------------------------ 6d slice FS: updates follow the source (API NEXT)

	/**
	 * A COPY follows its source (docs/CONTRACT.md "Phase 6d slice FS" §3): its own recorded recipe (the bible pin and roles, the
	 * param, the mirror; the param over that source version's own values) re-run on the source's version {@code toSourceVersion}
	 * (0 = its head), at $0 with no Claude call. The result installs as the copy's head + 1 ({@code by: "follow"},
	 * {@code derivation.sourceVersion} the new source version, the recipe unchanged; {@link SiteEvents#ENTRY_VERSIONED} fires) only
	 * when it passes the pristine-kit check, the copy's frame (front and the entrance feet row equal to its head: its lots take the
	 * delta), its size bound (its request's maximum: {@code fit}), every standing region lot that holds the copy at its current
	 * version (the re-made version, placed as the delta places it, must lie inside the lot's box: {@code lot_too_small}, Since 1.52.0)
	 * and the variation bar against the new source version (2 of 3 levers, at least 10% of cells changed; for a copy whose recipe
	 * met it). Otherwise nothing installs and
	 * {@link FollowResult#refused} says why. Nothing is ever applied to a lot: the caller lists {@link Sites#outdated()} and runs
	 * {@code checkDelta} and {@code applyDelta} per lot.
	 *
	 * <p>A copy that already derives from that version (or a later one) answers {@code followed false, alreadyFollowed true} and
	 * installs nothing. The install is compare-and-set: a copy whose head moved while it was built answers {@code head_moved}.
	 * {@code opKey}: the same key returns the same result (also after a restart); another body under it fails
	 * {@link Reason#OP_KEY_CONFLICT}. Fails {@link ArchitectRefused} {@link Reason#NOT_ALLOWED} for an entry that does not follow:
	 * detail {@code not_copy} (a VARIANT, a RESKIN or an entry derived from nothing),
	 * {@code adopted} (a copy of an adopted entry); {@link Reason#UNKNOWN_BLUEPRINT} for an unknown entry. Needs a helper with
	 * {@code entry.follow} (feature {@code "followSource"}). Completes on the server thread once the library has reloaded the new
	 * version. Since 1.51.0. (7b DS, since 1.53.0) A SITE entry follows too: the source's version re-run on the entry's own site, checked
	 * on the composite (a site rule failing answers {@code check}, its message naming the rule); no variation bar and no frame check
	 * (a site-bound entry places only in its site's frame). Before NEXT a SITE entry was refused {@code until_7b}.
	 */
	default CompletableFuture<FollowResult> follow(String copyEntryId, int toSourceVersion, @Nullable String opKey) {
		throw new UnsupportedOperationException("Designs.follow needs Architect API NEXT");
	}

	/**
	 * Every COPY of the source that is behind, as one persisted operation: at its start the helper freezes the source version
	 * ({@code toSourceVersion}, or the head then) and the follower set (each COPY behind at that moment, with its head) before
	 * following any, so a copy made or versioned later is not in it, and a source version made meanwhile is not used. Each follower
	 * as {@link #follow}; one that fails is listed with its reason and left. A restart resumes the operation; {@code opKey} keys the
	 * whole operation. Completes with one result per frozen follower (empty when none is behind). Since 1.51.0.
	 */
	default CompletableFuture<java.util.List<FollowResult>> followAll(String sourceEntryId, int toSourceVersion, @Nullable String opKey) {
		throw new UnsupportedOperationException("Designs.followAll needs Architect API NEXT");
	}

	/**
	 * One follower's outcome (6d FS).
	 *
	 * @param entryId the copy
	 * @param followed a new version was installed
	 * @param fromVersion the copy's head when the follow started
	 * @param newVersion its head after (= {@code fromVersion} when nothing installed)
	 * @param sourceVersion the source version followed (the frozen one)
	 * @param refused null, or why nothing installed: {@code frame}, {@code check}, {@code bar}, {@code fit}, {@code bible_gone},
	 *     {@code source_gone}, {@code head_moved}, {@code lot_too_small} (Since 1.52.0: a standing region lot that holds the copy
	 *     could not hold the re-made version; {@code message} names the site and lot ids; nothing was installed)
	 * @param alreadyFollowed the copy already derived from that version or a later one (a no-op)
	 * @param message what happened, for a log or a toast
	 */
	record FollowResult(String entryId, boolean followed, int fromVersion, int newVersion, int sourceVersion, @Nullable String refused,
		boolean alreadyFollowed, String message) {
	}

	/**
	 * (7b) A site variant (docs/CONTRACT.md "Phase 7b", Steward's review change 1): the source entry's kit program re-run on another
	 * site, $0, deterministic, written as a {@code Derivation.Kind.SITE} entry bound to {@code site} ({@link SiteBinding}), and
	 * installed directly in the library (no group, no approval: its approval is the source's). Idempotent per {@code opKey}: the same
	 * key and body answers the first variant's entry id. Completes with the new entry's id, or exceptionally with
	 * {@link ArchitectRefused}: {@link Reason#SITE_UNFIT} when the re-run fails a site check ({@link ArchitectRefused#detail()} names the
	 * check: one of the kit's site rule ids, {@code site_bound} when the program can't be built into this site at all, e.g. another
	 * fit), {@link Reason#SITE_UNSUPPORTED} when the source has no program to re-run (detail {@code no_program}: an import or an entry
	 * without its source) or a program that is not site-aware (detail {@code not_site_aware}: it declares no fit);
	 * {@link Reason#UNKNOWN_BLUEPRINT} for an unknown entry. The key is scoped by the player's owner (none). The new entry copies the
	 * source's values, palette, bible, profile and ext, its request with the new site, and keeps the site's files. Built by slice DS
	 * (feature {@code "siteDesign"}). Since 1.53.0.
	 */
	default CompletableFuture<String> siteVariant(String entryId, SiteSpec site, String opKey) {
		throw new UnsupportedOperationException("Designs.siteVariant needs the Architect API since 1.53.0 (slice DS)");
	}

	// ------------------------------------------------------------------ M5 GP: given programs (API NEXT)

	/**
	 * (M5 GP, Steward's S-M5-1; docs/CONTRACT.md "M5 support") A design from the caller's own kit program, at $0 with no Claude call: the
	 * program runs through the same kit, checker and renders as a Claude-written design, in the region plan's sandbox (Node's permission
	 * model: it reads and writes only its scratch dir with a fresh copy of the pristine kit, no network, no child process, the plan's heap
	 * and time limits), and is installed directly as a new library entry (no group, no approval).
	 *
	 * <p>{@code source} is a kit design module, as {@code kit/designs/*.mjs} are written: {@code export const id} (the entry id's base;
	 * the installed copy's id is rewritten to the entry's), {@code export const params} (its parameter schema: {@code int},
	 * {@code bool}, {@code enum}; kit/lib/params.mjs) and a default export {@code build({palette, reserved, ...values})} returning a
	 * Blueprint; its kit imports are relative ({@code '../lib/kit.mjs'}). Its own {@code type} and {@code profile} stand (no request's
	 * type, profile or size is imposed). {@code params} are its values (checked against its schema; at most
	 * {@link Limits#PROGRAM_PARAMS_MAX} characters as JSON). {@code bible}: a Style's roles for the palette ({@code version 0}: its
	 * latest), null for the program's own default palette.
	 *
	 * <p>The entry records the program's sha (sha256 of {@code source}'s UTF-8 bytes, exactly as given) in its sidecar
	 * {@code givenProgram {sha, opKey, owner?}} and keeps the exact source as {@code program/source.mjs}; its {@code values},
	 * {@code bible} and the parts map are recorded as for any design. {@code opKey} keys the operation (scoped by the owner: none is the
	 * player's): the same key and body answers the first one's entry, also after a restart (a restart resumes one still running);
	 * another body under it fails {@link Reason#OP_KEY_CONFLICT}. Completes on the server thread with the new entry's id once the library
	 * has loaded it, or fails {@link ProgramRefused} ({@link Reason#PROGRAM_REFUSED}: the checker's typed findings and why, see there).
	 * Needs a helper with {@code "givenPrograms"}. Since NEXT.
	 */
	default CompletableFuture<String> fromProgram(String source, com.google.gson.JsonObject params, @Nullable BiblePin bible, String opKey) {
		return fromProgram(source, params, bible, opKey, null);
	}

	/** {@link #fromProgram(String, com.google.gson.JsonObject, BiblePin, String)} under an owner's key scope. Since NEXT. */
	default CompletableFuture<String> fromProgram(String source, com.google.gson.JsonObject params, @Nullable BiblePin bible, String opKey, @Nullable String owner) {
		throw new UnsupportedOperationException("Designs.fromProgram needs Architect API NEXT (slice GP)");
	}

	/**
	 * (M5 GP) A keyed variant of a given-program entry ({@link #fromProgram}, or a variant of one): its kept program re-run at $0 with
	 * {@code params} over the entry's values, {@code bible} (null: the entry's own Style, else the program's default palette;
	 * {@code version 0}: the latest) and the lot's {@code reserved} cells (null: none), in the same sandbox, checker and renders, and
	 * installed as a new entry ({@code <entryId>_kv}, {@code _kv_2}, ...; {@code derivation {source, sourceVersion, kind: "variant",
	 * recipe {values, bible?, reserved?, programSha, opKey}}}, the source's ext, the same {@code givenProgram.sha} and
	 * {@code program/source.mjs}, its {@code reserved} recorded).
	 *
	 * <p>{@code reserved} is in the lot's frame ({@link DesignRequest.Reserved}: the lot seen with its front to the south, u across, v
	 * from the back, y from the lot's floor; kit/lib/reserved.mjs): the program is given it ({@code build({reserved})}, so it can leave
	 * those cells open: {@code frameToTemplate} in kit/lib/reserved.mjs maps one to a template cell) and the checker refuses a design
	 * that puts a non-air block on one, placed as a lot places it ({@code reserved}).
	 *
	 * <p>{@code opKey} keys it (owner-scoped), as {@link #fromProgram}; {@link #variantByKey} finds it again. Fails
	 * {@link ProgramRefused} as {@link #fromProgram}, also with {@code not_given} (the entry is not a given program) and
	 * {@code program_stale} (its kept source's sha is not the recorded one); {@link Reason#UNKNOWN_BLUEPRINT} for an unknown entry.
	 * {@link Library#makeVariant} is unchanged. Needs {@code "givenPrograms"}. Since NEXT.
	 */
	default CompletableFuture<String> variant(String entryId, com.google.gson.JsonObject params, @Nullable BiblePin bible, DesignRequest.@Nullable Reserved reserved,
		String opKey) {
		return variant(entryId, params, bible, reserved, opKey, null);
	}

	/** {@link #variant(String, com.google.gson.JsonObject, BiblePin, DesignRequest.Reserved, String)} under an owner's key scope. Since NEXT. */
	default CompletableFuture<String> variant(String entryId, com.google.gson.JsonObject params, @Nullable BiblePin bible, DesignRequest.@Nullable Reserved reserved,
		String opKey, @Nullable String owner) {
		throw new UnsupportedOperationException("Designs.variant needs Architect API NEXT (slice GP)");
	}

	/**
	 * (M5 GP) The keyed variant made under {@code opKey} (the player's scope), from the helper's persisted operation (also after a
	 * restart): empty when this key never made one; the entry id once it is installed and loaded (a running one is waited for, as the
	 * call that made it); fails as that call did ({@link ProgramRefused}) when it was refused. Fails {@link ArchitectRefused}
	 * {@link Reason#SIDECAR_UNAVAILABLE} while the helper can't be reached (never "empty" then). Needs {@code "givenPrograms"}. Since NEXT.
	 */
	default CompletableFuture<Optional<String>> variantByKey(String opKey) {
		return variantByKey(null, opKey);
	}

	/** {@link #variantByKey(String)} in an owner's key scope. Since NEXT. */
	default CompletableFuture<Optional<String>> variantByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Designs.variantByKey needs Architect API NEXT (slice GP)");
	}
}
