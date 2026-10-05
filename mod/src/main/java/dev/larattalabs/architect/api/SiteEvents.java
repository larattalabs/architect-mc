package dev.larattalabs.architect.api;

import java.util.List;
import net.fabricmc.fabric.api.event.Event;
import net.fabricmc.fabric.api.event.EventFactory;

/**
 * Architect's Fabric events (R7). All fire on the server thread, and the UI and commands fire them as well as API calls.
 * The fields are static: {@code SiteEvents.SITE_PLACED.register(...)} works at any time (also through
 * {@code ArchitectApi.get().events()}). A listener that throws is logged and skipped; it never breaks Architect or the
 * other listeners.
 */
public interface SiteEvents {
	/** A site was placed (instantly or as a construction site). */
	Event<SitePlaced> SITE_PLACED = EventFactory.createArrayBacked(SitePlaced.class, ls -> v -> {
		for (SitePlaced l : ls) {
			Guard.run(() -> l.onPlaced(v), "SITE_PLACED");
		}
	});
	/** A site was removed (or deconstructed); the view is the site as it was. */
	Event<SiteRemoved> SITE_REMOVED = EventFactory.createArrayBacked(SiteRemoved.class, ls -> (v, r) -> {
		for (SiteRemoved l : ls) {
			Guard.run(() -> l.onRemoved(v, r), "SITE_REMOVED");
		}
	});
	/** A site moved (also "undo move"). */
	Event<SiteMoved> SITE_MOVED = EventFactory.createArrayBacked(SiteMoved.class, ls -> (a, b) -> {
		for (SiteMoved l : ls) {
			Guard.run(() -> l.onMoved(a, b), "SITE_MOVED");
		}
	});
	/** A placement attempt (API, UI confirm or command) was refused. Never fired for the ghost's live verdict. */
	Event<PlaceFailed> PLACE_FAILED = EventFactory.createArrayBacked(PlaceFailed.class, ls -> (r, why) -> {
		for (PlaceFailed l : ls) {
			Guard.run(() -> l.onFailed(r, why), "PLACE_FAILED");
		}
	});
	/** A construction site made progress (at most once per second per site). */
	Event<SiteProgress> SITE_PROGRESS = EventFactory.createArrayBacked(SiteProgress.class, ls -> v -> {
		for (SiteProgress l : ls) {
			Guard.run(() -> l.onProgress(v), "SITE_PROGRESS");
		}
	});
	/** A construction site finished building. */
	Event<SiteBuilt> SITE_BUILT = EventFactory.createArrayBacked(SiteBuilt.class, ls -> v -> {
		for (SiteBuilt l : ls) {
			Guard.run(() -> l.onBuilt(v), "SITE_BUILT");
		}
	});
	/** A design changed status or step. */
	Event<DesignUpdated> DESIGN_UPDATED = EventFactory.createArrayBacked(DesignUpdated.class, ls -> d -> {
		for (DesignUpdated l : ls) {
			Guard.run(() -> l.onUpdated(d), "DESIGN_UPDATED");
		}
	});
	/** A design finished (done, failed or cancelled); when done, its entry is loaded and carries the request's ext. */
	Event<DesignDone> DESIGN_DONE = EventFactory.createArrayBacked(DesignDone.class, ls -> d -> {
		for (DesignDone l : ls) {
			Guard.run(() -> l.onDone(d), "DESIGN_DONE");
		}
	});
	/** A variant was installed and loaded. */
	Event<VariantDone> VARIANT_DONE = EventFactory.createArrayBacked(VariantDone.class, ls -> e -> {
		for (VariantDone l : ls) {
			Guard.run(() -> l.onDone(e), "VARIANT_DONE");
		}
	});
	/** A job changed (protocol 2; not fired until jobs arrive). */
	Event<JobUpdated> JOB_UPDATED = EventFactory.createArrayBacked(JobUpdated.class, ls -> j -> {
		for (JobUpdated l : ls) {
			Guard.run(() -> l.onUpdated(j), "JOB_UPDATED");
		}
	});
	/** A job finished (protocol 2; not fired until jobs arrive). */
	Event<JobDone> JOB_DONE = EventFactory.createArrayBacked(JobDone.class, ls -> j -> {
		for (JobDone l : ls) {
			Guard.run(() -> l.onDone(j), "JOB_DONE");
		}
	});

	@FunctionalInterface
	interface SitePlaced {
		void onPlaced(SiteView site);
	}

	@FunctionalInterface
	interface SiteRemoved {
		void onRemoved(SiteView site, RemoveResult result);
	}

	@FunctionalInterface
	interface SiteMoved {
		void onMoved(SiteView before, SiteView after);
	}

	@FunctionalInterface
	interface PlaceFailed {
		void onFailed(PlaceRequest request, List<Refusal> refusals);
	}

	@FunctionalInterface
	interface SiteProgress {
		void onProgress(SiteView site);
	}

	@FunctionalInterface
	interface SiteBuilt {
		void onBuilt(SiteView site);
	}

	@FunctionalInterface
	interface DesignUpdated {
		void onUpdated(Design design);
	}

	@FunctionalInterface
	interface DesignDone {
		void onDone(Design design);
	}

	@FunctionalInterface
	interface VariantDone {
		void onDone(Library.Entry entry);
	}

	@FunctionalInterface
	interface JobUpdated {
		void onUpdated(Job job);
	}

	@FunctionalInterface
	interface JobDone {
		void onDone(Job job);
	}

	/** Runs one listener; a throw is logged, never passed on. */
	final class Guard {
		private Guard() {
		}

		static void run(Runnable r, String event) {
			try {
				r.run();
			} catch (Throwable t) {
				org.slf4j.LoggerFactory.getLogger("architect").warn("A {} listener failed", event, t);
			}
		}
	}
}
