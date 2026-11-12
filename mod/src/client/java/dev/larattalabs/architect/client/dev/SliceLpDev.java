package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionLinks;

/**
 * Phase 7b slice LP DevBridge hooks (docs/DEVBRIDGE.md "7b LP"): the link pass's counters (how many realises ran it, how many answered
 * NO_LINK) and the bypass the gate's GR byte item compares with (a realise as before LP: no link pass). Headless (genHooks).
 */
public final class SliceLpDev {
	private SliceLpDev() {
	}

	public static void init() {
		DevBridge.register("dev.lp.stats", 30_000, "{} - (7b LP) the link pass since the start -> {calls, noLinks, bypass}", (req, mc) -> ServerTasks
			.callOnServer(s -> RegionLinks.devStats()));
		DevBridge.register("dev.lp.bypass", 30_000, "{on} - (7b LP) realise as before LP (no link pass at all; the gate's GR byte item) -> {bypass}", (req, mc) -> {
			boolean on = req.has("on") && req.get("on").getAsBoolean();
			return ServerTasks.callOnServer(s -> {
				RegionLinks.devBypass(on);
				JsonObject o = new JsonObject();
				o.addProperty("bypass", on);
				return o;
			});
		});
	}
}
