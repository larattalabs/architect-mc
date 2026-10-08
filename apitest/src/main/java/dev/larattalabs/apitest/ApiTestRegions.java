package dev.larattalabs.apitest;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CellWrite;
import dev.larattalabs.architect.api.CoveredPolicy;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PrepareRequest;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.Regions;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.SiteEvents;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * The phase 6a API checks (docs/CONTRACT.md "# Phase 6 contract", API 1.8.0), through dev.larattalabs.architect.api only:
 * <pre>
 * api18                 version, the 6a features, the appended reasons, LoadPolicy.GENERATED_ONLY, CellWrite.Cond
 * rplan &lt;json&gt;          Regions.plan -> pending "rplan:&lt;tag&gt;"   {program, params?, claim: [x0,z0,x1,z1], seed?, load?: loaded|generated:n|bounded:n, owner?, tag?}
 * rprepare &lt;planId&gt; [inFlight]   Regions.prepare -> pending "rprepare:&lt;planId&gt;"
 * rrealise &lt;json&gt;       Regions.realise -> pending "rrealise:&lt;tag&gt;"   {planId, lots?: {id: entry}, load?, stages?, force?, tag?}
 * rget &lt;region&gt;         Regions.get
 * rlist [owner]         Regions.list
 * rremove &lt;region&gt; [keep|cascade|refuse] [force]   Regions.remove -> pending "rremove:&lt;region&gt;"
 * revents               the REGION_STATE / REGION_PROGRESS / PREPARE_PROGRESS events seen so far
 * </pre>
 */
final class ApiTestRegions {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
	private static final JsonArray EVENTS = new JsonArray();
	private static boolean hooked;

	private ApiTestRegions() {
	}

	static void hook() {
		if (hooked) {
			return;
		}
		hooked = true;
		SiteEvents.REGION_STATE.register(v -> event("REGION_STATE", v.id(), v.state().name()));
		SiteEvents.REGION_PROGRESS.register(v -> event("REGION_PROGRESS", v.id(), v.state().name()));
		SiteEvents.PREPARE_PROGRESS.register(v -> event("PREPARE_PROGRESS", v.planId(), v.state().name() + " " + v.chunksGenerated() + "/" + v.chunksTotal()));
	}

	private static void event(String kind, String id, String what) {
		JsonObject o = new JsonObject();
		o.addProperty("event", kind);
		o.addProperty("id", id);
		o.addProperty("what", what);
		synchronized (EVENTS) {
			EVENTS.add(o);
		}
	}

	static JsonElement json(Object o) {
		return JsonParser.parseString(GSON.toJson(o));
	}

	static LoadPolicy load(String s) {
		if (s == null || s.equals("loaded")) {
			return LoadPolicy.LOADED_ONLY;
		}
		if (s.startsWith("generated:")) {
			return LoadPolicy.GENERATED_ONLY(Integer.parseInt(s.substring(10)));
		}
		return LoadPolicy.LOAD_BOUNDED(Integer.parseInt(s.substring(8)));
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		hook();
		Regions regions = ArchitectApi.get().regions();
		switch (a[0]) {
			case "api18": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				JsonArray f = new JsonArray();
				ArchitectApi.get().features().forEach(f::add);
				o.add("features", f);
				JsonArray r = new JsonArray();
				for (Reason x : Reason.values()) {
					r.add(x.name());
				}
				o.add("reasons", r);
				LoadPolicy g = LoadPolicy.GENERATED_ONLY(64);
				o.addProperty("generatedOnly", g.maxChunks() + " " + g.loads() + " " + g.generates() + " " + LoadPolicy.LOAD_BOUNDED(8).generates());
				JsonArray conds = new JsonArray();
				for (CellWrite.Cond c : CellWrite.Cond.values()) {
					conds.add(c.name());
				}
				o.add("conds", conds);
				CellWrite w = new CellWrite(BlockPos.ZERO, Blocks.STONE.defaultBlockState(), null, CellWrite.Cond.IF_AIR_OR_FLUID);
				o.addProperty("cellCond", String.valueOf(w.cond()));
				o.addProperty("cellCondOld", String.valueOf(CellWrite.of(BlockPos.ZERO, Blocks.STONE.defaultBlockState()).cond()));
				JsonArray states = new JsonArray();
				for (RegionState s : RegionState.values()) {
					states.add(s.name());
				}
				o.add("regionStates", states);
				return o;
			}
			case "rplan": {
				JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
				JsonArray c = j.getAsJsonArray("claim");
				var level = src.getLevel();
				RegionPlanRequest r = new RegionPlanRequest(j.get("program").getAsString(), j.has("params") ? j.getAsJsonObject("params") : new JsonObject(),
					level, new BoundingBox(c.get(0).getAsInt(), level.getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(), level.getMaxY(), c.get(3).getAsInt()),
					j.has("seed") ? Long.parseUnsignedLong(j.get("seed").getAsString()) : null, null, null, load(j.has("load") ? j.get("load").getAsString() : null),
					j.has("owner") ? j.get("owner").getAsString() : null, new JsonObject());
				return ApiTest.later("rplan:" + (j.has("tag") ? j.get("tag").getAsString() : "last"), regions.plan(r).handle((p, e) -> e != null ? err(e)
					: json(p)));
			}
			case "rprepare":
				return ApiTest.later("rprepare:" + a[1], regions.prepare(new PrepareRequest(a[1], a.length > 2 ? Integer.parseInt(a[2]) : null)).handle((v,
					e) -> e != null ? err(e) : json(v)));
			case "rrealise": {
				JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
				Map<String, String> lots = new LinkedHashMap<>();
				if (j.has("lots")) {
					j.getAsJsonObject("lots").entrySet().forEach(e -> lots.put(e.getKey(), e.getValue().getAsString()));
				}
				java.util.List<String> stages = null;
				if (j.has("stages")) {
					stages = new java.util.ArrayList<>();
					for (JsonElement e : j.getAsJsonArray("stages")) {
						stages.add(e.getAsString());
					}
				}
				RealiseRequest r = new RealiseRequest(j.get("planId").getAsString(), Mode.INSTANT, src.getPlayer(), lots, j.has("load") ? load(j.get("load")
					.getAsString()) : null, true, stages, j.has("force") && j.get("force").getAsBoolean(), new JsonObject());
				return ApiTest.later("rrealise:" + (j.has("tag") ? j.get("tag").getAsString() : "last"), regions.realise(r).handle((id, e) -> {
					if (e != null) {
						return err(e);
					}
					JsonObject o = new JsonObject();
					o.addProperty("region", id);
					return o;
				}));
			}
			case "rget":
				return regions.get(a[1]).map(ApiTestRegions::json).orElse(com.google.gson.JsonNull.INSTANCE);
			case "rlist": {
				JsonArray out = new JsonArray();
				regions.list(a.length > 1 ? a[1] : null).forEach(v -> out.add(json(v)));
				return out;
			}
			case "rremove": {
				CoveredPolicy cp = a.length > 2 ? CoveredPolicy.valueOf(a[2].toUpperCase(java.util.Locale.ROOT)) : CoveredPolicy.KEEP;
				boolean force = a.length > 3 && "force".equals(a[3]);
				return ApiTest.later("rremove:" + a[1], regions.remove(a[1], new RemoveOptions(force, null, cp)).handle((r, e) -> e != null ? err(e)
					: ApiTest.removeJson(r)));
			}
			case "revents":
				synchronized (EVENTS) {
					return EVENTS.deepCopy();
				}
			default:
				throw new IllegalArgumentException("unknown region step " + a[0]);
		}
	}

	private static JsonObject err(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		o.addProperty("error", c.getClass().getSimpleName() + ": " + c.getMessage());
		if (c instanceof dev.larattalabs.architect.api.RegionRefused r) {
			o.addProperty("reason", r.reason().name());
		}
		return o;
	}
}
