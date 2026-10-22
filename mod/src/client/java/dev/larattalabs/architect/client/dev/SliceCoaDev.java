package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.PlanRetention;

/**
 * Phase 6c close-out A DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT "Phase 6c close-out A" §2, §3, §14, gate items 1-3): a keyed artifact
 * pin, {@code Regions.discardPlan}, a plan's files and last use, the retention clock's offset (the gate's forced ages) and the world-start
 * sweeps run now, and {@code Regions.planByKey}. Server work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceCoaDev {
	private SliceCoaDev() {
	}

	public static void init() {
		DevBridge.register("dev.coa.pinKeyed", 10_000, "{sha, owner, opKey} - (6c close-out A) Regions.pinArtifact(sha, owner, opKey) -> {pins: [owners], "
			+ "removed}", (req, mc) -> {
				Fields f = Fields.of(req);
				String sha = f.nonBlank("sha"), owner = f.nonBlank("owner"), key = f.nonBlank("opKey");
				return ServerTasks.callOnServer(s -> {
					ArchitectApi.get().regions().pinArtifact(sha, owner, key);
					return artifact(sha);
				});
			});
		DevBridge.register("dev.coa.artifact", 10_000, "{sha} - (6c close-out A) an artifact's pins and whether it was removed -> {pins, removed, missing}",
			(req, mc) -> {
				String sha = Fields.of(req).nonBlank("sha");
				return ServerTasks.callOnServer(s -> artifact(sha));
			});
		DevBridge.register("dev.coa.discardPlan", 60_000, "{planId} - (6c close-out A) Regions.discardPlan -> {discarded: bool} or {refused, reason, detail}",
			(req, mc) -> {
				String planId = Fields.of(req).nonBlank("planId");
				return ServerTasks.callOnServer(s -> ArchitectApi.get().regions().discardPlan(planId)).thenCompose(f -> f).handle((v, e) -> {
					JsonObject o = new JsonObject();
					if (e != null) {
						Throwable c = e.getCause() != null ? e.getCause() : e;
						o.addProperty("refused", String.valueOf(c.getMessage()));
						if (c instanceof ArchitectRefused ar) {
							o.addProperty("reason", ar.reason().name());
							o.addProperty("detail", ar.detail());
						}
						return o;
					}
					o.addProperty("discarded", v);
					return o;
				});
			});
		DevBridge.register("dev.coa.planFiles", 10_000, "{planId} - (6c close-out A) a plan's files on the mod's side and its last use -> {plan, survey, key, "
			+ "used, lastUsed, discarded, prepare, pending, now}", (req, mc) -> {
				String planId = Fields.of(req).nonBlank("planId");
				return ServerTasks.callOnServer(s -> PlanRetention.files(s, planId));
			});
		DevBridge.register("dev.coa.clock", 5_000, "{days} - (6c close-out A) the retention clock's offset in days (last uses written and sweeps judged at "
			+ "now + days; 0 resets) -> {days}", (req, mc) -> {
				double days = req.has("days") ? req.get("days").getAsDouble() : 0;
				PlanRetention.clockOffset((long) (days * 24 * 3600 * 1000));
				JsonObject o = new JsonObject();
				o.addProperty("days", days);
				return java.util.concurrent.CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.coa.sweep", 60_000, "{} - (6c close-out A) the world-start sweeps now: keyed pins, then unrealised plans -> {pinsEnded, "
			+ "plans}", (req, mc) -> ServerTasks.callOnServer(PlanRetention::sweepNow));
		DevBridge.register("dev.coa.planByKey", 10_000, "{owner?, opKey} - (6c close-out A) Regions.planByKey (a use of the plan) -> {planId} or {planId: "
			+ "null}", (req, mc) -> {
				Fields f = Fields.of(req);
				String owner = f.optStr("owner", null), key = f.nonBlank("opKey");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					o.addProperty("planId", ArchitectApi.get().regions().planByKey(owner, key).map(p -> p.planId()).orElse(null));
					return o;
				});
			});
	}

	private static JsonObject artifact(String sha) {
		JsonObject o = new JsonObject();
		var a = ArchitectApi.get().regions().artifact(sha);
		if (a.isEmpty()) {
			o.addProperty("missing", true);
			return o;
		}
		com.google.gson.JsonArray p = new com.google.gson.JsonArray();
		a.get().pinnedBy().forEach(p::add);
		o.add("pins", p);
		o.addProperty("removed", a.get().removed());
		o.addProperty("planId", a.get().planId());
		return o;
	}
}
