package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.PlaceRequest;

/**
 * (7b foundation) The site members ({@link DesignRequest#site()}, {@link PlaceRequest#site()}) exist before the slices that act on
 * them (DS designs, PL places). Until then a request carrying a site is refused with {@link UnsupportedOperationException}, as the
 * site methods' defaults throw: it is never designed or placed as a plain one. Each slice removes its own guard. Pure. Internal.
 */
public final class SiteGuards {
	private SiteGuards() {
	}

	/** A design request with a site: until slice DS. */
	public static void design(DesignRequest r) {
		if (r != null && r.site() != null) {
			throw new UnsupportedOperationException("DesignRequest.site needs the Architect API since NEXT (slice DS)");
		}
	}

	/** A group with an item that carries a site: until slice DS. */
	public static void group(GroupRequest g) {
		if (g != null) {
			for (GroupRequest.Item i : g.items()) {
				design(i.request());
			}
		}
	}

	/** A placement with a site: until slice PL. */
	public static void place(PlaceRequest r) {
		if (r != null && r.site() != null) {
			throw new UnsupportedOperationException("PlaceRequest.site needs the Architect API since NEXT (slice PL)");
		}
	}

	/** A batch with an item whose placement carries a site: until slice PL. */
	public static void batch(Batch b) {
		if (b != null) {
			for (Batch.Item i : b.items()) {
				place(i.request());
			}
		}
	}
}
