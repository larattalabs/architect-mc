package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CellDiff;
import dev.larattalabs.architect.api.DiagnoseScope;
import dev.larattalabs.architect.api.Diagnosis;
import dev.larattalabs.architect.api.RepairFinding;
import dev.larattalabs.architect.api.RepairResult;
import dev.larattalabs.architect.api.RepairSuspect;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Repairs;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * Slice DR DevBridge hook (docs/DEVBRIDGE.md "Slice DR"): {@code dev.repair {op, scope?, planId?, apply?, actor?}}: diagnose, repair
 * (through the public API, as Steward calls it), the auto-diagnose's state and the repair records; {@code op: killAt} arms kill point DRK1.
 */
public final class SliceDrDev {
	private SliceDrDev() {
	}

	public static void init() {
		DevBridge.register("dev.repair", 120_000, "{op: diagnose|repair|state|log|killAt|snap|unwrite|ledger, scope?: {kind: site|region|here|all, id?, x?, y?, z?, "
			+ "continuation?}, planId?, apply?: false, actor?: player|none, armed?: true} - (DR) TEST: Sites.diagnose / Sites.repair through the API "
			+ "(actor: the first player, or none), the auto-diagnose's suspects, ops line and SITE_REPAIRED count (state), the repair records (log); "
			+ "killAt arms DRK1 (the next repair halts after its record is durable and half its cells are written; (DR2) point DRK1pt: before its first player's block, DRK2: after its record is final; (DR2 round after OVF) DRK0: the record durable, nothing written, DRK3: after the barrier, DRK4: the settling record durable, DRK6: released, nothing booked, DRK7: the credits saved, the record not final); (DR-S) snap {name, min, max} keeps a "
			+ "box's cells, unwrite {name, min, max} puts back the cells changed since (the lost-writes fault), ledger {owner, key, paid?, custody?} "
			+ "injects a paid record or custody, saved with the world", (req, mc) -> ServerTasks.callOnServer(
				s -> s).thenCompose(s -> run(s, req)));
	}

	private static java.util.concurrent.CompletableFuture<JsonObject> run(MinecraftServer s, JsonObject req) {
		String op = req.has("op") ? req.get("op").getAsString() : "state";
		var api = ArchitectApi.get().sites(s);
		return switch (op) {
			case "diagnose" -> ServerTasks.callOnServer(x -> api.diagnose(scope(req))).thenCompose(f -> f).thenApply(SliceDrDev::json);
			case "repair" -> ServerTasks.callOnServer(x -> {
				ServerPlayer p = "none".equals(req.has("actor") ? req.get("actor").getAsString() : "player") ? null : x.getPlayerList().getPlayers()
					.stream().findFirst().orElse(null);
				return api.repair(req.get("planId").getAsString(), p, req.has("apply") && req.get("apply").getAsBoolean());
			}).thenCompose(f -> f).thenApply(SliceDrDev::json);
			case "killAt" -> ServerTasks.callOnServer(x -> {
				// (DR2) point: DRK1 (default: half the cells), DRK1pt (before the first player's block), DRK2 (after the record is final)
				String point = req.has("point") ? req.get("point").getAsString() : "DRK1";
				if (!point.matches("DRK[0-46-7]|DRK1pt")) {
					throw new DevBridge.DevException("point must be DRK0..DRK4, DRK6, DRK7 or DRK1pt (DRK5, the taken-share split, moved to TXN T6)");
				}
				boolean armed = !req.has("armed") || req.get("armed").getAsBoolean();
				Repairs.killDRK1 = armed && "DRK1".equals(point);
				Repairs.killPoint = armed && !"DRK1".equals(point) ? point : null;
				JsonObject o = new JsonObject();
				o.addProperty("DRK1", Repairs.killDRK1);
				o.addProperty("point", Repairs.killPoint);
				return o;
			});
			case "snap", "unwrite" -> ServerTasks.callOnServer(x -> {
				// (DR-S, TEST) snap: a box's cells kept under an id; unwrite: the box's cells that changed since put back (the lost-writes fault)
				var level = x.overworld();
				BlockPos min = pos(req.getAsJsonArray("min")), max = pos(req.getAsJsonArray("max"));
				String id = req.get("name").getAsString(); // ("id" is the bridge's request id)
				JsonObject o = new JsonObject();
				o.addProperty("cells", "snap".equals(op) ? Repairs.testSnap(level, id, min, max) : Repairs.testUnwrite(level, id, min, max));
				return o;
			});
			case "ledger" -> ServerTasks.callOnServer(x -> {
				// (DR-S, TEST) a paid record and/or custody under a key, saved with the world (PAID_ORPHAN, CUSTODY)
				JsonObject o = new JsonObject();
				o.addProperty("ok", Repairs.testLedger(x, req.get("owner").getAsString(), req.get("key").getAsString(), counts(req, "paid"), counts(req,
					"custody")));
				return o;
			});
			case "log" -> ServerTasks.callOnServer(x -> {
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				Repairs.records(req.has("planId") ? req.get("planId").getAsString() : null).forEach(a::add);
				o.add("records", a);
				return o;
			});
			default -> ServerTasks.callOnServer(x -> {
				JsonObject o = new JsonObject();
				o.addProperty("startDone", Repairs.startDone());
				o.addProperty("pending", api.suspectsPending());
				JsonArray a = new JsonArray();
				for (RepairSuspect r : api.suspects()) {
					JsonObject j = new JsonObject();
					j.addProperty("site", r.siteId());
					j.addProperty("region", r.regionId());
					j.addProperty("reason", r.reason());
					a.add(j);
				}
				o.add("suspects", a);
				o.addProperty("opsLine", Repairs.opsLine());
				o.addProperty("repairedEvents", Repairs.repairedEvents);
				o.addProperty("autoMaxLoads", Repairs.autoMaxLoads); // (DR2) the most chunks the auto-diagnose loaded in one tick
				o.addProperty("lastRepairedSite", Repairs.lastRepairedSite);
				o.addProperty("lastRepairedRegion", Repairs.lastRepairedRegion);
				return o;
			});
		};
	}

	private static BlockPos pos(com.google.gson.JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	private static java.util.Map<String, Integer> counts(JsonObject req, String k) {
		java.util.Map<String, Integer> m = new java.util.TreeMap<>();
		if (req.has(k)) {
			req.getAsJsonObject(k).entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
		}
		return m;
	}

	private static DiagnoseScope scope(JsonObject req) {
		JsonObject sc = req.has("scope") ? req.getAsJsonObject("scope") : new JsonObject();
		String kind = sc.has("kind") ? sc.get("kind").getAsString() : "all";
		DiagnoseScope d = switch (kind) {
			case "site" -> DiagnoseScope.site(sc.get("id").getAsString());
			case "region" -> DiagnoseScope.region(sc.get("id").getAsString());
			case "here" -> DiagnoseScope.here(net.minecraft.world.level.Level.OVERWORLD, new BlockPos(sc.get("x").getAsInt(), sc.get("y").getAsInt(), sc
				.get("z").getAsInt()));
			default -> DiagnoseScope.all();
		};
		return sc.has("continuation") ? d.withContinuation(sc.get("continuation").getAsString()) : d;
	}

	static JsonObject json(Diagnosis d) {
		JsonObject o = new JsonObject();
		o.addProperty("scope", d.scope().describe());
		o.addProperty("planId", d.planId());
		o.addProperty("unread", d.unread());
		o.addProperty("continuation", d.continuation());
		JsonArray fs = new JsonArray();
		for (RepairFinding f : d.findings()) {
			JsonObject j = new JsonObject();
			j.addProperty("code", f.code().name());
			j.addProperty("site", f.siteId());
			j.addProperty("region", f.regionId());
			j.addProperty("key", f.key());
			j.addProperty("cells", f.cells());
			j.addProperty("lagging", f.lagging());
			j.addProperty("foreign", f.foreign());
			j.addProperty("message", f.message());
			JsonArray ds = new JsonArray();
			for (CellDiff c : f.diffs()) {
				ds.add(c.pos().getX() + "," + c.pos().getY() + "," + c.pos().getZ() + " " + c.expected() + " <- " + c.found());
			}
			j.add("diffs", ds);
			fs.add(j);
		}
		o.add("findings", fs);
		return o;
	}

	static JsonObject json(RepairResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("planId", r.planId());
		o.addProperty("applied", r.applied());
		o.addProperty("written", r.written());
		JsonObject c = new JsonObject();
		r.credited().forEach(c::addProperty);
		o.add("credited", c);
		o.addProperty("left", r.left());
		o.addProperty("record", r.recordPath());
		o.addProperty("refused", r.refused() == null ? null : r.refused().name());
		o.addProperty("message", r.message());
		JsonArray s = new JsonArray();
		r.sites().forEach(s::add);
		o.add("sites", s);
		return o;
	}
}
