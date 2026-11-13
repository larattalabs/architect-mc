package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.PlaceRequest;

/**
 * (7b foundation) The site members ({@link PlaceRequest#site()}) exist before the slices that act on them. Until then a request
 * carrying a site is refused with {@link UnsupportedOperationException}, as the site methods' defaults throw: it is never placed as a
 * plain one. Each slice removes its own guard: DS removed the design and group guards ({@code DesignRequest.site} is designed since
 * 1.53.0); the batch guard stays (PL). Pure. Internal.
 */
public final class SiteGuards {
	private SiteGuards() {
	}

	/**
	 * A placement with a site, as a batch item sees it: slice PL places a site through {@code Sites.place}, {@code check} and
	 * {@code fitToSite}; a batch (whose items are persisted and placed over ticks) still refuses one until a later slice carries the
	 * site through the queue.
	 */
	public static void place(PlaceRequest r) {
		if (r != null && r.site() != null) {
			throw new UnsupportedOperationException("PlaceRequest.site needs the Architect API since 1.53.0 (slice PL)");
		}
	}

	/** A batch with an item whose placement carries a site: still refused after slice PL (the queue does not persist a site yet). */
	public static void batch(Batch b) {
		if (b != null) {
			for (Batch.Item i : b.items()) {
				place(i.request());
			}
		}
	}
}
