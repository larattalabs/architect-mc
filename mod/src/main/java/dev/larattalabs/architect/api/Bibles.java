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
}
