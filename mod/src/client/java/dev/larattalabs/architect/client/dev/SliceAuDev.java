package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.AuthorRequest;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.Authors;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.concurrent.CompletableFuture;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;

/**
 * (7c AU) DevBridge hooks for program authoring (docs/CONTRACT.md "Slice AU as built"; tools/gate7cau.mjs): {@code dev.region.author} calls
 * {@link dev.larattalabs.architect.api.Regions#authorProgram} through the public API and, with {@code wait}, answers once the program design
 * ended (an AUTHORED one installed); {@code dev.au.store} answers the world-local store's path (the gate edits a source there).
 */
public final class SliceAuDev {
	private SliceAuDev() {
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
		DevBridge.register("dev.region.author", 1_800_000, "{brief, claim: [x0,z0,x1,z1], planId?, partId?, budgetUsd?, opKey?, ext?: {...}, wait?: true}"
			+ " - (7c AU) Regions.authorProgram (the claim in the Overworld); with wait (default) the answer comes when the program design ended"
			+ " -> {designId, status, kind, error?, result, costUsd, ms} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String brief = f.nonBlank("brief");
				JsonArray c = req.getAsJsonArray("claim");
				if (c == null || c.size() != 4) {
					throw new DevBridge.DevException("claim is [x0,z0,x1,z1]");
				}
				String planId = f.optStr("planId", null);
				String partId = f.optStr("partId", null);
				Double budget = f.optNum("budgetUsd");
				String opKey = f.optStr("opKey", null);
				JsonObject ext = req.get("ext") instanceof JsonObject e ? e.deepCopy() : new JsonObject();
				boolean wait = f.optBool("wait", true);
				long t0 = System.nanoTime();
				CompletableFuture<String> id = ServerTasks.callOnServer(s -> ArchitectApi.get().regions().authorProgram(new AuthorRequest(brief, new BoundingBox(c.get(0)
					.getAsInt(), s.overworld().getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(), s.overworld().getMaxY(), c.get(3).getAsInt()), planId, partId,
					budget, opKey == null ? "dev.author." + Long.toString(System.nanoTime(), 36) : opKey, ext))).thenCompose(x -> x);
				return id.thenCompose(designId -> wait ? RegionDev6b.waitDesign(designId, t0) : CompletableFuture.completedFuture(RegionDev6b.designJson(designId,
					null, t0))).exceptionally(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("refused", reason(e));
						return o;
					});
			});
		DevBridge.register("dev.au.store", 10_000, "{} - (7c AU) the world-local authored program store's path -> {dir}", (req, mc) -> ServerTasks.callOnServer(s -> {
			JsonObject o = new JsonObject();
			o.addProperty("dir", Authors.dir(s.getWorldPath(LevelResource.ROOT)).toAbsolutePath().normalize().toString());
			return o;
		}));
	}
}
