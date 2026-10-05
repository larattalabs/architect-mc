package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
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
}
