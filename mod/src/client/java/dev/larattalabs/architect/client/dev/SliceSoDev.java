package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;

/**
 * Phase 7b slice SO DevBridge hooks (docs/DEVBRIDGE.md "7b SO", TEST): the support order's watch (a support-order construction site's
 * built set recorded each time its count crosses a multiple of {@code every}, for the survival gate's connectivity scans) and a site's
 * {@code architect:scaffold} journal entries. Server work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceSoDev {
	private SliceSoDev() {
	}

	public static void init() {
		DevBridge.register("dev.so.watch", 10_000, "{every?: 100 (0: off)} - (7b SO, TEST) records every support-order construction site's built set "
			+ "each time its built count crosses a multiple of every (the records cleared) -> {every}", (req, mc) -> {
				int every = Fields.of(req).optInt("every", 100, 0, 100_000);
				return ServerTasks.callOnServer(s -> {
					dev.larattalabs.architect.site.Builder.soWatch(every);
					JsonObject o = new JsonObject();
					o.addProperty("every", every);
					return o;
				});
			});
		DevBridge.register("dev.so.snapshots", 60_000, "{site} - (7b SO, TEST) the watch's records of a site -> {every, bySupport?, queued?, built?, "
			+ "snapshots: [{built, cells: [[x,y,z]...]}]}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> dev.larattalabs.architect.site.Builder.soSnapshots(s, id));
			});
		DevBridge.register("dev.so.scaffold", 10_000, "{site} - (7b SO, TEST) a site's architect:scaffold journal entries -> {entries: [{id, policy, "
			+ "status, cells, group, box}]}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					o.add("entries", dev.larattalabs.architect.site.Builder.soScaffold(id));
					return o;
				});
			});
	}
}
