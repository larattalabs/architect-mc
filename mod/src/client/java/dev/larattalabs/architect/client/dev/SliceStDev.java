package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.FitMode;
import dev.larattalabs.architect.client.design.DesignFeature;
import dev.larattalabs.architect.client.design.SiteVariantHere;
import dev.larattalabs.architect.client.placement.BuildPlacement;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import dev.larattalabs.architect.client.placement.PlotMarker;

/**
 * Phase 7b slice ST DevBridge hooks (docs/DEVBRIDGE.md "7b ST"): the standalone player path's UI driven as the keys drive it: the fit
 * picker (F), Enter in any plot phase (a corner, or the frame), "Site variant here…" of a site-bound entry, and the state of all three.
 * Client only (the picker and the ghost are client UI; no genHooks).
 */
public final class SliceStDev {
	private SliceStDev() {
	}

	public static void init() {
		DevBridge.register("dev.plot.fit", 10_000, "{fit} - (7b ST) the plot's fit picker (F): on_pad (default), attach_to_cliff, carve_into, span, wrap_trunk, "
			+ "suspend -> dev.plot.state", (req, mc) -> {
				String w = Fields.of(req).nonBlank("fit");
				FitMode f = FitMode.of(w).orElseThrow(() -> new DevBridge.DevException("fit: one of on_pad, carve_into, attach_to_cliff, span, wrap_trunk, suspend"));
				return DevBridge.onClient(mc, () -> {
					try {
						PlotMarker.setFit(f);
					} catch (IllegalStateException e) {
						throw new DevBridge.DevException(e.getMessage());
					}
					return PlotMarker.state();
				});
			});
		DevBridge.register("dev.plot.enter", 10_000, "{} - (7b ST) Enter while marking: the corner looked at, or (the frame step) the frame confirmed "
			+ "-> dev.plot.state", (req, mc) -> DevBridge.onClient(mc, () -> {
				if (!PlotMarker.active()) {
					throw new DevBridge.DevException("not marking a plot");
				}
				PlotMarker.enter();
				return PlotMarker.state();
			}));
		DevBridge.register("dev.st.variant", 10_000, "{entryId} - (7b ST) Library ⋯ › Site variant here… of a site-bound entry: plot marking with "
			+ "its fit locked (then dev.plot.corner, dev.plot.enter; the variant is made and its ghost starts on the new site) -> dev.st.state",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("entryId");
				return DevBridge.onClient(mc, () -> {
					String why = SiteVariantHere.start(id, DesignFeature.reopen);
					if (why != null) {
						throw new DevBridge.DevException(why);
					}
					return state();
				});
			});
		DevBridge.register("dev.st.state", 10_000, "{blueprint?} - (7b ST) the standalone path: the variant flow (running, lastEntry, lastError), the "
			+ "plot marker, the placement's site, and a design's pinned site (PlacementFeature.siteOf)", (req, mc) -> {
				String bp = Fields.of(req).optStr("blueprint", null);
				return DevBridge.onClient(mc, () -> {
					JsonObject o = state();
					if (bp != null) {
						var s = PlacementFeature.siteOf(bp);
						o.add("pinned", s == null ? null : s.wire());
					}
					return o;
				});
			});
	}

	static JsonObject state() {
		JsonObject o = new JsonObject();
		o.addProperty("variantRunning", SiteVariantHere.running());
		o.addProperty("variantEntry", SiteVariantHere.lastEntry());
		o.addProperty("variantError", SiteVariantHere.lastError());
		o.add("plot", PlotMarker.state());
		var s = BuildPlacement.site();
		o.add("placingSite", s == null ? null : s.wire());
		return o;
	}
}
