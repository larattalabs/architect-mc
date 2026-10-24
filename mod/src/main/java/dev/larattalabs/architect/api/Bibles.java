package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import org.jspecify.annotations.Nullable;

/**
 * Style bibles (docs/CONTRACT.md phase 4b "Style bible (A1)", "4b review folded in"): what many separately designed buildings
 * share so they read as one place. Requests and revisions are Claude jobs on the sidecar ({@code bible.request},
 * {@code bible.revise}); progress and the result arrive as {@link SiteEvents#BIBLE_UPDATED} / {@link SiteEvents#BIBLE_DONE}
 * (deduplicated, also for jobs that finished while no world was loaded). The installed bibles are read from
 * {@code <gameDir>/architect/bibles/}; the built-in ones (the palette presets) come from the sidecar's index.
 * Calls are thread-safe; futures complete on the server thread. Since 1.2.0.
 *
 * <p>Since 1.6.0: {@link #delete} and {@link #archive} (library hygiene), and {@link Bible#restraint()} /
 * {@link Bible#archived()}. {@link #list} still lists archived bibles (the UI's pickers hide them).
 */
public interface Bibles {
	/**
	 * Starts a bible job; completes once the sidecar acked it with the job as it stands then (queued: its {@code bibleId} is
	 * reserved and {@code version} is 1). Fails when the helper is not running, does not speak 4b, or refuses the request.
	 */
	CompletableFuture<BibleJob> request(BibleRequest r);

	/** Revises a bible (version + 1, {@code notes} say what to change). Built-in bibles refuse: request one with a seedPreset. */
	CompletableFuture<BibleJob> revise(String bibleId, String notes);

	/**
	 * Revises a bible with a sheet critique at the end ({@code critique: {mode: report}}, a helper with {@code "critique"}) when
	 * {@code sheetCritique}. Since 1.6.0.
	 */
	CompletableFuture<BibleJob> revise(String bibleId, String notes, boolean sheetCritique);

	/**
	 * Deletes a bible and every version of it ({@code bible.delete}, a helper with {@code "bibleAdmin"}); completes with the
	 * versions deleted. Refused (the future fails, the message lists them) while any library entry, unfinished group, design or
	 * massing pins any of its versions, and for another owner's bible unless {@code owner} is that owner. Built-in bibles refuse.
	 * No force flag. Since 1.6.0.
	 */
	CompletableFuture<List<Integer>> delete(String bibleId, @Nullable String owner);

	/**
	 * Archives a bible (true: hidden from the pickers; its entries and re-skins are unaffected) or brings it back (false)
	 * ({@code bible.archive}, a helper with {@code "bibleAdmin"}). Since 1.6.0.
	 */
	CompletableFuture<Void> archive(String bibleId, boolean archived);

	/** Cancels a bible job (not a bible). */
	void cancel(String jobId);

	/** What a bible request would cost and take ({@code bible.estimate}); null = the sidecar's default request. */
	CompletableFuture<Estimate> estimate(@Nullable BibleRequest r);

	/** The bible's latest version (installed, else built in). Any thread. */
	Optional<Bible> get(String bibleId);

	/** One version of a bible. Any thread. */
	Optional<Bible> get(String bibleId, int version);

	/**
	 * The bibles whose owner is {@code owner}; null = every bible, installed ones (latest versions, by id) then the built-in
	 * ones. Any thread.
	 */
	List<Bible> list(@Nullable String owner);

	/** A bible job by id ({@code b<n>}). */
	Optional<BibleJob> job(String jobId);

	/** The bible jobs of {@code owner} (null: all), including the ones that finished while the caller was away. Newest first. */
	List<BibleJob> jobs(@Nullable String owner);

	/**
	 * Cancels a bible job and completes with the job, cancelled, at the helper's ack. Fails like {@link Designs#cancelGroup}:
	 * "no job", "already &lt;status&gt;", or {@link Reason#SIDECAR_UNAVAILABLE} ({@link ArchitectRefused}). BIBLE_DONE fires once,
	 * as for {@link #cancel}. Since 1.10.0.
	 */
	default CompletableFuture<BibleJob> cancelJob(String jobId) {
		throw new UnsupportedOperationException("Bibles.cancelJob needs Architect API 1.10.0");
	}

	/**
	 * The bible job requested with this operation key by this owner (null: the player), in any state
	 * ({@link BibleRequest#opKey}). Empty means the helper never received it. Fails {@link ArchitectRefused}
	 * {@link Reason#SIDECAR_UNAVAILABLE} while the helper is not connected (never "empty" then). Since 1.10.0.
	 */
	default CompletableFuture<Optional<BibleJob>> jobByKey(@Nullable String owner, String opKey) {
		throw new UnsupportedOperationException("Bibles.jobByKey needs Architect API 1.10.0");
	}

	/**
	 * (Style unification U1) Saves a hand-made Style ({@code bible.save}, a helper with {@code "bible.save"}): no Claude call, $0.
	 * Every save is a new version {@code <gameDir>/architect/bibles/<id>/versions/<v>/}; an existing version is never rewritten or
	 * removed. {@code style} is the Style's JSON: {@code name}, {@code roles} (the 11 core roles; built from a Style with
	 * {@code StyleRoles}' fan-out or by hand) and optionally {@code scope, tags, suggestedFeatures, blurb, basedOn {id, version},
	 * proportions, roofLanguage, silhouette, motifs, lighting, avoid, tiers, patterns, format, restraint, connectors, fluids, rarity};
	 * the helper validates it with the kit (the test house included) and sets {@code origin: hand}. {@code bibleId} null: a new
	 * Style ({@code bib_<slug of name>}, made unique). {@code owner} null = the player; an existing Style's owner must match.
	 * Fails (the message says why) for a built-in id, an id a bible job holds, another owner's Style, or roles the kit refuses.
	 * Completes with the saved version. Since NEXT.
	 */
	default CompletableFuture<Bible> save(@Nullable String bibleId, com.google.gson.JsonObject style, @Nullable String owner) {
		throw new UnsupportedOperationException("Bibles.save needs Architect API since NEXT");
	}

	/**
	 * (Style unification U1) The Styles a caller may design with, free and local (no helper call): the built-in ones, the player's
	 * (owner empty) and, when {@code owner} is set, that owner's; archived ones left out. The latest version of each (installed ones
	 * by id, then the built-in ones). Use {@link DesignRequest#withStyle} for a materials-only design with one. Any thread. Since NEXT.
	 */
	default List<Bible> usable(@Nullable String owner) {
		throw new UnsupportedOperationException("Bibles.usable needs Architect API since NEXT");
	}
}
