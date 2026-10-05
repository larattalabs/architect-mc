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

	/** A bible job changed status or step (since 1.2.0). */
	Event<BibleUpdated> BIBLE_UPDATED = EventFactory.createArrayBacked(BibleUpdated.class, ls -> j -> {
		for (BibleUpdated l : ls) {
			Guard.run(() -> l.onUpdated(j), "BIBLE_UPDATED");
		}
	});
	/** A bible job finished (done: {@code bible()} is the installed bible), once per job (since 1.2.0). */
	Event<BibleDone> BIBLE_DONE = EventFactory.createArrayBacked(BibleDone.class, ls -> j -> {
		for (BibleDone l : ls) {
			Guard.run(() -> l.onDone(j), "BIBLE_DONE");
		}
	});
	/** A design group changed: status, an item's status or step, the cost (since 1.2.0). */
	Event<GroupUpdated> GROUP_UPDATED = EventFactory.createArrayBacked(GroupUpdated.class, ls -> g -> {
		for (GroupUpdated l : ls) {
			Guard.run(() -> l.onUpdated(g), "GROUP_UPDATED");
		}
	});
	/** A design group finished (done, failed or cancelled), once per group; its done items' entries are loaded (since 1.2.0). */
	Event<GroupDone> GROUP_DONE = EventFactory.createArrayBacked(GroupDone.class, ls -> g -> {
		for (GroupDone l : ls) {
			Guard.run(() -> l.onDone(g), "GROUP_DONE");
		}
	});
	/** A collection re-skin finished, once per re-skin; its new entries are loaded (since 1.2.0). */
	Event<ReskinDone> RESKIN_DONE = EventFactory.createArrayBacked(ReskinDone.class, ls -> r -> {
		for (ReskinDone l : ls) {
			Guard.run(() -> l.onDone(r), "RESKIN_DONE");
		}
	});
	/**
	 * A massing version was installed (a massing job or a redirect finished), once per version; since 1.3.0. A failed massing
	 * job has no record: it shows only as {@link #DESIGN_DONE} with status FAILED and {@code design.massing()} set.
	 */
	Event<MassingDone> MASSING_DONE = EventFactory.createArrayBacked(MassingDone.class, ls -> m -> {
		for (MassingDone l : ls) {
			Guard.run(() -> l.onDone(m), "MASSING_DONE");
		}
	});
	/**
	 * A massingFirst group waits for approval ({@link Group.Status#AWAITING_APPROVAL}; {@link Group#awaiting} lists the items,
	 * {@link Group#owner} says who approves when its approvalUi is owner); since 1.3.0. Fires on the change to
	 * awaiting_approval, and again only when an item waits with a massing version not reported before (after a redirect
	 * finished): never for a partial approval, a reconnect or a restart.
	 */
	Event<GroupAwaitingApproval> GROUP_AWAITING_APPROVAL = EventFactory.createArrayBacked(GroupAwaitingApproval.class, ls -> g -> {
		for (GroupAwaitingApproval l : ls) {
			Guard.run(() -> l.onAwaiting(g), "GROUP_AWAITING_APPROVAL");
		}
	});
	/**
	 * The world's survival toggle changed ({@code /architect survival}, the Status tab), or was set to its default at the
	 * world's first load with Architect (since 1.2.0).
	 */
	Event<WorldModeChanged> WORLD_MODE_CHANGED = EventFactory.createArrayBacked(WorldModeChanged.class, ls -> i -> {
		for (WorldModeChanged l : ls) {
			Guard.run(() -> l.onChanged(i), "WORLD_MODE_CHANGED");
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

	@FunctionalInterface
	interface BibleUpdated {
		void onUpdated(BibleJob job);
	}

	@FunctionalInterface
	interface BibleDone {
		void onDone(BibleJob job);
	}

	@FunctionalInterface
	interface GroupUpdated {
		void onUpdated(Group group);
	}

	@FunctionalInterface
	interface GroupDone {
		void onDone(Group group);
	}

	@FunctionalInterface
	interface ReskinDone {
		void onDone(Reskin reskin);
	}

	@FunctionalInterface
	interface MassingDone {
		void onDone(Massing massing);
	}

	@FunctionalInterface
	interface GroupAwaitingApproval {
		void onAwaiting(Group group);
	}

	@FunctionalInterface
	interface WorldModeChanged {
		void onChanged(SurvivalInfo info);
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
