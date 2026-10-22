package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BatchView;
import dev.larattalabs.architect.client.world.ServerTasks;

/**
 * Phase 6c slice FL DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT FL §10 item 6, S-FL-5): a region batch's items as Steward sees them
 * (BatchView.ItemView: key, stage, status and merged ext), so the gate reads each street road's {@code architect_mc:street}. Server work
 * only (the headless server generates it too: devserver genHooks).
 */
public final class SliceFlDev {
	private SliceFlDev() {
	}

	public static void init() {
		DevBridge.register("dev.region.items", 30_000, "{region, owner?} - (6c FL) the region's batch items as BatchView.ItemView (key, stage, status, "
			+ "ext): a street road's ext carries architect_mc:street {zone, district?} (S-FL-5) -> {batch, items: [{key, stage, status, ext}]}", (req, mc) -> {
				String region = req.get("region").getAsString();
				String owner = req.has("owner") ? req.get("owner").getAsString() : null;
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					JsonArray items = new JsonArray();
					for (BatchView b : ArchitectApi.get().sites(level.getServer()).batches(owner)) {
						if (!b.ext().has("architect_mc:region") || !region.equals(b.ext().get("architect_mc:region").getAsString())) {
							continue;
						}
						o.addProperty("batch", b.id());
						for (BatchView.ItemView i : b.items()) {
							JsonObject it = new JsonObject();
							it.addProperty("key", i.itemKey());
							it.addProperty("stage", i.stage());
							it.addProperty("status", String.valueOf(i.status()));
							it.add("ext", i.ext().deepCopy());
							items.add(it);
						}
					}
					o.add("items", items);
					return o;
				});
			});
	}
}
