package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.LotSpec;
import dev.larattalabs.architect.api.RegionPlan;
import dev.larattalabs.architect.api.SiteFrame;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.api.SiteView;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionRec;
import dev.larattalabs.architect.region.RegionsImpl;

/**
 * Phase 7b slice SL DevBridge hooks (docs/DEVBRIDGE.md "7b SL"): a plan's lots as {@code RegionPlan.lots()} carries them
 * ({@code LotSpec.site} as its wire) and a realised site lot's record (its placement in the site's frame and its binding). Headless
 * (genHooks).
 */
public final class SliceSlDev {
	private SliceSlDev() {
	}

	public static void init() {
		DevBridge.register("dev.sl.plan", 60_000, "{plan} - (7b SL) the plan's RegionPlan.lots(): [{id, stage, box, floorY, front, max, site (LotSpec.site's "
			+ "wire) | null}] -> {known, lots}", (req, mc) -> {
				String plan = Fields.of(req).nonBlank("plan");
				return ServerTasks.callOnServer(s -> {
					RegionPlan p = RegionsImpl.planView(plan);
					JsonObject o = new JsonObject();
					o.addProperty("known", p != null);
					JsonArray a = new JsonArray();
					if (p != null) {
						for (LotSpec l : p.lots()) {
							JsonObject x = new JsonObject();
							x.addProperty("id", l.id());
							x.addProperty("stage", l.stage());
							x.add("box", SiteSpec.box(l.lot()));
							x.addProperty("floorY", l.floorY());
							x.addProperty("front", l.front().getSerializedName());
							JsonArray m = new JsonArray();
							m.add(l.max().x());
							m.add(l.max().y());
							m.add(l.max().z());
							x.add("max", m);
							x.add("site", l.site() == null ? JsonNull.INSTANCE : l.site().wire());
							a.add(x);
						}
					}
					o.add("lots", a);
					return o;
				});
			});
		DevBridge.register("dev.sl.lot", 60_000, "{region, lot} - (7b SL) a region lot's record and its placed site: {known, state, entry, siteId, site: "
			+ "{blueprint, origin, rotation, box, restoreBox, state, ext} | null}", (req, mc) -> {
				Fields f = Fields.of(req);
				String region = f.nonBlank("region"), lot = f.nonBlank("lot");
				return ServerTasks.callOnServer(s -> {
					RegionsImpl.Live r = RegionsImpl.live(region);
					RegionRec.Lot l = r == null ? null : r.rec().lots.get(lot);
					JsonObject o = new JsonObject();
					o.addProperty("known", l != null);
					if (l == null) {
						return o;
					}
					o.addProperty("state", l.state);
					o.addProperty("entry", l.entry);
					o.addProperty("siteId", l.siteId);
					SiteView v = l.siteId == null ? null : ArchitectApi.get().sites(s).get(l.siteId).orElse(null);
					if (v == null) {
						o.add("site", JsonNull.INSTANCE);
						return o;
					}
					JsonObject sv = new JsonObject();
					sv.addProperty("blueprint", v.blueprintId());
					JsonArray origin = new JsonArray();
					origin.add(v.box().minX());
					origin.add(v.box().minY());
					origin.add(v.box().minZ());
					sv.add("origin", origin);
					sv.addProperty("rotation", SiteFrame.rotationWire(v.rotation()));
					sv.add("box", SiteSpec.box(v.box()));
					sv.add("restoreBox", SiteSpec.box(v.restoreBox()));
					sv.addProperty("state", v.state().name());
					sv.add("ext", v.ext());
					o.add("site", sv);
					return o;
				});
			});
	}
}
