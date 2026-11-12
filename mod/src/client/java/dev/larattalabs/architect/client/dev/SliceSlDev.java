package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
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
		// (7b SL, Steward's DS answers 2026-11-12) a massingFirst group with site items, approved through the API, read back
		DevBridge.register("dev.sl.group", 60_000, "{name, massingFirst?: true, items: [{key, site? (a site spec's wire), buildingType?, size?: [x, y, z]}]} - "
			+ "(7b SL) Designs.requestGroup (bible rustic) -> {groupId} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				java.util.List<GroupRequest.Item> items = new java.util.ArrayList<>();
				for (var e : req.getAsJsonArray("items")) {
					JsonObject it = e.getAsJsonObject();
					int[] sz = it.has("size") ? new int[] {it.getAsJsonArray("size").get(0).getAsInt(), it.getAsJsonArray("size").get(1).getAsInt(),
						it.getAsJsonArray("size").get(2).getAsInt()} : new int[] {20, 24, 20};
					DesignRequest r = new DesignRequest(it.has("buildingType") ? it.get("buildingType").getAsString() : "cabin", "rustic", null, java.util.List.of(),
						new BlockSize(sz[0], sz[1], sz[2]), null, null, null, null, null, null, null, null, null, java.util.List.of(), null, false, null, null, null, null,
						null, null, null, null, null);
					if (it.has("site") && it.get("site").isJsonObject()) {
						r = r.withSite(SiteSpec.fromWire(it.getAsJsonObject("site")));
					}
					items.add(GroupRequest.Item.of(it.get("key").getAsString(), r));
				}
				boolean mf = !req.has("massingFirst") || req.get("massingFirst").getAsBoolean();
				GroupRequest g = new GroupRequest(f.nonBlank("name"), "rustic", null, null, new JsonObject(), null, null, items, mf, null, null, null, null, null);
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().requestGroup(g)).thenCompose(x -> x).thenApply(id -> {
					JsonObject o = new JsonObject();
					o.addProperty("groupId", id);
					return o;
				}).exceptionally(e -> {
					Throwable t = e instanceof java.util.concurrent.CompletionException c && c.getCause() != null ? c.getCause() : e;
					JsonObject o = new JsonObject();
					o.addProperty("refused", String.valueOf(t.getMessage()));
					return o;
				});
			});
		DevBridge.register("dev.sl.groupState", 30_000, "{groupId} - (7b SL) Designs.group -> {known, status, awaiting, items: [{key, stage, status, designId, "
			+ "designIds, entryId, step}]}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("groupId");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					java.util.Optional<Group> g = ArchitectApi.get().designs().group(id);
					o.addProperty("known", g.isPresent());
					if (g.isEmpty()) {
						return o;
					}
					o.addProperty("status", g.get().status().name());
					JsonArray aw = new JsonArray();
					g.get().awaiting().forEach(aw::add);
					o.add("awaiting", aw);
					JsonArray a = new JsonArray();
					for (Group.Item it : g.get().items()) {
						JsonObject x = new JsonObject();
						x.addProperty("key", it.itemKey());
						x.addProperty("stage", it.stage().map(Enum::name).orElse(null));
						x.addProperty("status", it.status().name());
						x.addProperty("designId", it.designId());
						JsonArray ds = new JsonArray();
						it.designIds().forEach(ds::add);
						x.add("designIds", ds);
						x.addProperty("entryId", it.entryId().orElse(null));
						x.addProperty("step", it.step());
						a.add(x);
					}
					o.add("items", a);
					return o;
				});
			});
		DevBridge.register("dev.sl.approve", 30_000, "{groupId, approve: [keys]} - (7b SL) Designs.approveGroup -> {approved} or {refused}", (req, mc) -> {
			String id = Fields.of(req).nonBlank("groupId");
			java.util.List<String> keys = new java.util.ArrayList<>();
			req.getAsJsonArray("approve").forEach(e -> keys.add(e.getAsString()));
			return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().approveGroup(id, keys, java.util.Map.of(), java.util.List.of())).thenCompose(x -> x)
				.thenApply(ap -> {
					JsonObject o = new JsonObject();
					JsonObject m = new JsonObject();
					ap.approved().forEach(m::addProperty);
					o.add("approved", m);
					return o;
				}).exceptionally(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("refused", String.valueOf(e.getMessage()));
					return o;
				});
		});
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
