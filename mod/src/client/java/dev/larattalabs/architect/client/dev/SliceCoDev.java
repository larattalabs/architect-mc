package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ComposeRequest;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.concurrent.CompletableFuture;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * (7c CO) DevBridge hooks for the standalone composer (docs/CONTRACT.md "Slice CO as built"; tools/gate7cco.mjs): {@code dev.region.compose}
 * calls {@link dev.larattalabs.architect.api.Regions#compose} through the public API and, with {@code wait}, answers once the settlement
 * design ended (and a PICKED one's plan is accepted or failed).
 */
public final class SliceCoDev {
	private SliceCoDev() {
	}

	private static String reason(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		if (c instanceof RegionsImpl.RegionException r) {
			return r.reason + ": " + r.getMessage();
		}
		if (c instanceof dev.larattalabs.architect.api.ArchitectRefused r) {
			return r.reason() + ": " + r.getMessage();
		}
		return c.getClass().getSimpleName() + ": " + c.getMessage();
	}

	public static void init() {
		DevBridge.register("dev.region.compose", 1_800_000, "{brief, claim: [x0,z0,x1,z1], style?, images?: false, budgetUsd?, opKey?, ext?: {...}, wait?: true}"
			+ " - (7c CO) Regions.compose (the claim in the Overworld); with wait (default) the answer comes when the settlement design ended and, for a"
			+ " PICKED one, its plan is accepted or failed -> {designId, status, kind, error?, result, costUsd, ms} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String brief = f.nonBlank("brief");
				JsonArray c = req.getAsJsonArray("claim");
				if (c == null || c.size() != 4) {
					throw new DevBridge.DevException("claim is [x0,z0,x1,z1]");
				}
				String style = f.optStr("style", null);
				boolean images = f.optBool("images", false);
				Double budget = f.optNum("budgetUsd");
				String opKey = f.optStr("opKey", null);
				JsonObject ext = req.get("ext") instanceof JsonObject e ? e.deepCopy() : new JsonObject();
				boolean wait = f.optBool("wait", true);
				long t0 = System.nanoTime();
				CompletableFuture<String> id = ServerTasks.callOnServer(s -> ArchitectApi.get().regions().compose(new ComposeRequest(brief, new BoundingBox(c.get(0)
					.getAsInt(), s.overworld().getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(), s.overworld().getMaxY(), c.get(3).getAsInt()), style, images,
					budget, opKey == null ? "dev.compose." + Long.toString(System.nanoTime(), 36) : opKey, ext))).thenCompose(x -> x);
				return id.thenCompose(designId -> wait ? RegionDev6b.waitDesign(designId, t0) : CompletableFuture.completedFuture(RegionDev6b.designJson(designId,
					null, t0))).exceptionally(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("refused", reason(e));
						return o;
					});
			});
	}
}
