package dev.larattalabs.architect.client.dev;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.AdoptRegionRequest;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.LotFit;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.RoadRequest;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionAdopt;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 6d slice AD DevBridge hooks (docs/DEVBRIDGE.md "6d AD"): a Steward-shaped VillageLayout settlement through the public API (Steward's
 * BatchPlanner shape: the street road items {@code street}, {@code street#2}, ... in stage {@code street}, each lot an item keyed by its lot id
 * fitted by {@code Sites.fitToLot}, {@code steward_mc:*} ext), Regions.adopt and Regions.unadopt, and every adopted site's membership as the
 * four records hold it. A refusal answers {@code refused: "<REASON>: message"}.
 */
public final class SliceAdDev {
	private SliceAdDev() {
	}

	public static void init() {
		DevBridge.register("dev.ad.settlement", 120_000, "{owner, entry, streetZ, y, lots: [{id, x, z, sx, sz, north}], spans: [[x0, x1]...], group?, settlement?, "
			+ "build?, keys?: [street item keys], stage?: stage1} - (6d AD) queues a Steward-shaped VillageLayout build as a batch (street first, then the lots) -> {batchId} or "
			+ "{refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String owner = f.optStr("owner", null);
				String entry = f.nonBlank("entry");
				int streetZ = req.get("streetZ").getAsInt();
				int y = req.get("y").getAsInt();
				String group = f.optStr("group", null);
				String settlement = f.optStr("settlement", "ad_town");
				String build = f.optStr("build", "b1");
				String lotStage = f.optStr("stage", "stage1");
				JsonArray lots = req.getAsJsonArray("lots");
				JsonArray spans = req.has("spans") ? req.getAsJsonArray("spans") : new JsonArray();
				JsonArray keys = req.has("keys") ? req.getAsJsonArray("keys") : null;
				return ServerTasks.callOnServer(s -> {
					var level = s.overworld();
					var sites = ArchitectApi.get().sites(s);
					List<Batch.Item> items = new ArrayList<>();
					List<Batch.StageSpec> stages = new ArrayList<>();
					List<String> streetKeys = new ArrayList<>();
					for (int i = 0; i < spans.size(); i++) {
						JsonArray sp = spans.get(i).getAsJsonArray();
						int x0 = sp.get(0).getAsInt(), x1 = sp.get(1).getAsInt();
						JsonObject ext = new JsonObject();
						ext.addProperty("steward_mc:settlement", settlement);
						ext.addProperty("steward_mc:street", true);
						ext.addProperty("steward_mc:street_z", streetZ);
						ext.addProperty("steward_mc:street_x0", x0);
						ext.addProperty("steward_mc:street_x1", x1);
						ext.addProperty("steward_mc:build", build);
						RoadRequest rr = new RoadRequest(level, List.of(new BlockPos(x0, y, streetZ), new BlockPos(x1, y, streetZ)), 3, null, null, true, false, Mode.INSTANT, owner,
							ext, null, false);
						String key = keys != null && i < keys.size() ? keys.get(i).getAsString() : i == 0 ? "street" : "street#" + (i + 1);
						items.add(Batch.Item.road(key, rr, "street", List.of()));
						streetKeys.add(key);
					}
					if (!streetKeys.isEmpty()) {
						stages.add(new Batch.StageSpec("street", streetKeys));
					}
					List<String> lotKeys = new ArrayList<>();
					for (JsonElement e : lots) {
						JsonObject l = e.getAsJsonObject();
						String id = l.get("id").getAsString();
						int x = l.get("x").getAsInt(), z = l.get("z").getAsInt(), sx = l.get("sx").getAsInt(), sz = l.get("sz").getAsInt();
						boolean north = l.get("north").getAsBoolean();
						BoundingBox lot = new BoundingBox(x, y + 1, z, x + sx - 1, y + 24, z + sz - 1);
						LotFit fit = sites.fitToLot(entry, lot, north ? Direction.SOUTH : Direction.NORTH, FitOptions.DEFAULT);
						JsonObject ext = new JsonObject();
						ext.addProperty("steward_mc:settlement", settlement);
						ext.addProperty("steward_mc:lot", id);
						ext.addProperty("steward_mc:role", l.has("role") ? l.get("role").getAsString() : "house");
						ext.addProperty("steward_mc:build", build);
						PlaceRequest pr = new PlaceRequest(entry, level, fit.origin(), fit.rotation(), Mode.INSTANT, owner, ext, false, null);
						items.add(new Batch.Item(id, pr, lotStage, List.of(), null, null, null));
						lotKeys.add(id);
					}
					stages.add(new Batch.StageSpec(lotStage, lotKeys));
					JsonObject bext = new JsonObject();
					bext.addProperty("steward_mc:settlement", settlement);
					bext.addProperty("steward_mc:build", build);
					Batch b = new Batch(null, owner, bext, group, items, stages, Batch.WaitPolicy.DEFAULT, dev.larattalabs.architect.api.LoadPolicy.LOADED_ONLY, null, false,
						true, false, null, null);
					return sites.queue(b);
				}).thenCompose(x -> x).handle((id, e) -> {
					JsonObject o = new JsonObject();
					if (e != null) {
						o.addProperty("refused", RegionDev.reason(e));
					} else {
						o.addProperty("batchId", id);
					}
					return o;
				});
			});
		DevBridge.register("dev.ad.batch", 10_000, "{batchId} - (6d AD) a batch's status, group and items (key, status, site, reason)", (req, mc) -> {
			String id = Fields.of(req).nonBlank("batchId");
			return ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				var v = ArchitectApi.get().sites(s).batch(id).orElse(null);
				if (v == null) {
					o.addProperty("missing", true);
					return o;
				}
				o.addProperty("status", v.status().name());
				o.addProperty("group", v.group());
				JsonArray items = new JsonArray();
				for (var i : v.items()) {
					JsonObject j = new JsonObject();
					j.addProperty("key", i.itemKey());
					j.addProperty("status", i.status().name());
					i.siteId().ifPresent(x -> j.addProperty("site", x));
					i.reason().ifPresent(x -> j.addProperty("reason", x.name() + ": " + i.message()));
					items.add(j);
				}
				o.add("items", items);
				return o;
			});
		});
		DevBridge.register("dev.ad.adopt", 900_000, "{owner?, claim: [x0,z0,x1,z1], geometry, roads: [siteId], lots: {lotId: siteId}, opKey?, ext?} - (6d AD) "
			+ "Regions.adopt -> {region, state, groupId, lots, ext, planId, irSha} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String owner = f.optStr("owner", null);
				JsonArray c = req.getAsJsonArray("claim");
				JsonObject geometry = req.getAsJsonObject("geometry").deepCopy();
				List<String> roads = new ArrayList<>();
				req.getAsJsonArray("roads").forEach(x -> roads.add(x.getAsString()));
				Map<String, String> lots = new LinkedHashMap<>();
				req.getAsJsonObject("lots").entrySet().forEach(x -> lots.put(x.getKey(), x.getValue().getAsString()));
				String key = f.optStr("opKey", null);
				JsonObject ext = req.get("ext") instanceof JsonObject e ? e.deepCopy() : new JsonObject();
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> {
					var level = s.overworld();
					BoundingBox claim = new BoundingBox(c.get(0).getAsInt(), level.getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(), level.getMaxY(), c.get(3).getAsInt());
					return ArchitectApi.get().regions().adopt(new AdoptRegionRequest(owner, Level.OVERWORLD, claim, AdoptRegionRequest.VILLAGE_LAYOUT, geometry, roads, lots, key,
						ext));
				}).thenCompose(x -> x).handle((v, e) -> {
					JsonObject o = new JsonObject();
					if (e != null) {
						o.addProperty("refused", RegionDev.reason(e));
					} else {
						o.addProperty("region", v.id());
						o.addProperty("state", v.state().name());
						o.addProperty("groupId", v.groupId());
						o.addProperty("planId", v.planId());
						o.addProperty("irSha", v.irSha());
						o.add("lots", new Gson().toJsonTree(v.lots()));
						o.add("ext", v.ext().deepCopy());
					}
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				});
			});
		DevBridge.register("dev.ad.unadopt", 300_000, "{region} - (6d AD) Regions.unadopt -> {groups: {site: group}, newGroups} or {refused}", (req, mc) -> {
			String region = Fields.of(req).nonBlank("region");
			return ServerTasks.callOnServer(s -> ArchitectApi.get().regions().unadopt(region)).thenCompose(x -> x).handle((r, e) -> {
				JsonObject o = new JsonObject();
				if (e != null) {
					o.addProperty("refused", RegionDev.reason(e));
				} else {
					o.add("groups", new Gson().toJsonTree(r.groups()));
					o.add("newGroups", new Gson().toJsonTree(r.newGroups()));
				}
				return o;
			});
		});
		DevBridge.register("dev.ad.state", 60_000, "{sites: [id]} - (6d AD, row 6b) each site's membership in its record, its head records and every journal entry; "
			+ "the groups that list it; agree (one owner per site); the journal's entry count and next id; the intent files", (req, mc) -> {
				List<String> sites = new ArrayList<>();
				req.getAsJsonArray("sites").forEach(x -> sites.add(x.getAsString()));
				return ServerTasks.callOnServer(s -> {
					try {
						JsonObject o = RegionAdopt.state(sites);
						var js = dev.larattalabs.architect.journal.WorldJournal.store();
						o.addProperty("entries", js.index().entries().size());
						o.addProperty("nextId", js.index().nextId());
						JsonArray intents = new JsonArray();
						java.nio.file.Path root = dev.larattalabs.architect.region.RegionStore.root(s.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT));
						if (java.nio.file.Files.isDirectory(root)) {
							try (var st = java.nio.file.Files.list(root)) {
								st.map(p -> p.getFileName().toString()).filter(n -> n.matches("(un)?adopt-.*\\.json")).sorted().forEach(intents::add);
							}
						}
						o.add("intents", intents);
						return o;
					} catch (java.io.IOException e) {
						throw new java.io.UncheckedIOException(e);
					}
				});
			});
	}
}
