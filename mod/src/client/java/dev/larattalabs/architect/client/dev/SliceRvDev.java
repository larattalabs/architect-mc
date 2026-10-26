package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.RevisionRequest;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.Revisions;

/**
 * Phase 6d slice RV DevBridge hooks (docs/DEVBRIDGE.md "6d RV"): Regions.planRevision as the client's player, and the revision state
 * through {@link Revisions#dev}. A refusal answers {@code refused: "<REASON>: message"}. The realise is {@code dev.region.realise} of the
 * revision's plan id.
 */
public final class SliceRvDev {
	private SliceRvDev() {
	}

	private static void op(String name, String op, String doc) {
		DevBridge.register(name, 60_000, doc, (req, mc) -> ServerTasks.callOnServer(s -> {
			try {
				return Revisions.dev(s, op, req.deepCopy());
			} catch (java.io.IOException e) {
				throw new java.io.UncheckedIOException(e);
			}
		}));
	}

	public static void init() {
		DevBridge.register("dev.rv.plan", 900_000, "{region, spec: {parts: [{id, call}], refill?: [lotId], unsafe?}, opKey?, program?: revise} - (6d RV) "
			+ "Regions.planRevision -> {planId, irSha, revisionOf: {region, rid, position, parentRid, parentIrSha}, stages, ms} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String region = f.nonBlank("region");
				JsonObject params = new JsonObject();
				params.add("spec", req.has("spec") ? req.getAsJsonObject("spec").deepCopy() : new JsonObject());
				String key = f.optStr("opKey", null);
				String program = f.optStr("program", Revisions.PROGRAM);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().regions().planRevision(region, new RevisionRequest(program, params, key, "dev")))
					.thenCompose(x -> x).handle((p, e) -> {
						JsonObject o = new JsonObject();
						if (e != null) {
							o.addProperty("refused", RegionDev.reason(e));
						} else {
							o.addProperty("planId", p.planId());
							o.addProperty("irSha", p.irSha());
							o.add("stages", new com.google.gson.Gson().toJsonTree(p.stages()));
							if (p.revisionOf() != null) {
								o.add("revisionOf", new com.google.gson.Gson().toJsonTree(p.revisionOf()));
							}
						}
						o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
						return o;
					});
			});
		op("dev.rv.state", "state", "{region} - (6d RV) the head, position, busy, manifest and revision records (sites), the effective IR's head, parts and sha, "
			+ "its snapshot files, every manifest, the RegionView and the revision batches' items");
		op("dev.rv.history", "history", "{region, keys: [\"tx,tz\"]} - (6d RV, §3.4) historySha per key");
		op("dev.rv.standing", "standing", "{region} - (6d RV, §5.3) ctx.standing as a revision plan would send it");
		op("dev.rv.race", "race", "{at: [x,y,z] | null, state?: minecraft:cobblestone} - (6d RV, item 20) TEST: the next revision tile that writes that "
			+ "cell gets the block set there after its capture, before its write (the cell is then RACED, not written)");
		op("dev.rv.ir", "ir", "{region, rid} - (6d RV) a revision's IR (rev/<rid>/ir.json)");
	}
}
