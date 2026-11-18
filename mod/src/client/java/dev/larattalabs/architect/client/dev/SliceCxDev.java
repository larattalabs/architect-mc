package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ConnectorRequest;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.apiimpl.ConnectorPlace;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.Locale;
import net.minecraft.core.BlockPos;

/**
 * 7c slice CX DevBridge hooks (docs/DEVBRIDGE.md "7c CX"): a single connector through the public API ({@code Sites.placeConnector}) and the
 * one-part plan it makes ({@link ConnectorPlace#planOf}), so a gate can check the very plan for its bill. Headless (genHooks).
 */
public final class SliceCxDev {
	private SliceCxDev() {
	}

	public static void init() {
		DevBridge.register("dev.cx.place", 1_800_000, "{kind, from: [x,y,z], to: [x,y,z], styleId?, params?: {}, mode?: \"AUTO\" | \"INSTANT\" | \"CONSTRUCTION\", opKey, "
			+ "owner?, dimension?, typed?: bool, maxBill?: {item: n}, maxBillPerLot?: {lot: {item: n}}, ext?: {}} - (7c CX) Sites.placeConnector (owner and "
			+ "dimension go in params architect_mc:owner and architect_mc:dimension; (8b) typed: true sends them as the request's typed members instead; "
			+ "maxBill, maxBillPerLot and ext are the request's) -> {placed, siteId, "
			+ "refusals: [{reason, message}], notes, ms} or {refused, reason}", (req, mc) -> {
				Fields f = Fields.of(req);
				ConnectorRequest r = request(req, f);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().sites(s).placeConnector(r)).thenCompose(x -> x).thenApply(pr -> json(pr, t0));
			});
		DevBridge.register("dev.cx.check", 1_800_000, "(8b CK) dev.cx.place's request -> Sites.checkConnector: {fits, refusal: {reason, message}?, quote: {bom, exact}?, "
			+ "claim: [x0,y0,z0,x1,y1,z1], ends, say, ms}", (req, mc) -> {
				Fields f = Fields.of(req);
				ConnectorRequest r = request(req, f);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().sites(s).checkConnector(r)).thenCompose(x -> x).thenApply(ck -> {
					JsonObject o = new JsonObject();
					o.addProperty("fits", ck.fits());
					if (ck.refusal() != null) {
						JsonObject rf = new JsonObject();
						rf.addProperty("reason", ck.refusal().reason().name());
						rf.addProperty("message", ck.refusal().message());
						o.add("refusal", rf);
					}
					if (ck.quote() != null) {
						JsonObject q = new JsonObject();
						q.add("bom", ck.quote().bom());
						q.addProperty("exact", ck.quote().exact());
						o.add("quote", q);
					}
					JsonArray c = new JsonArray();
					for (int v : new int[] {ck.claim().minX(), ck.claim().minY(), ck.claim().minZ(), ck.claim().maxX(), ck.claim().maxY(), ck.claim().maxZ()}) {
						c.add(v);
					}
					o.add("claim", c);
					JsonArray e = new JsonArray();
					ck.ends().forEach(p -> e.add(pos(p)));
					o.add("ends", e);
					o.addProperty("say", ck.say());
					o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
					return o;
				});
			});
		DevBridge.register("dev.cx.plan", 60_000, "{kind, from: [x,y,z], to: [x,y,z], params?: {}, opKey?} - (7c CX) the one-part plan Sites.placeConnector checks: "
			+ "{plan, claim: [x0,z0,x1,z1], anchors: {cx_from: [x,y,z], cx_to: [x,y,z]}} or {refused, reason} (a bad request: FIELD_LIMIT's message)", (req, mc) -> {
				Fields f = Fields.of(req);
				ConnectorRequest r = request(req, f);
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					try {
						ConnectorPlace.Plan p = ConnectorPlace.planOf(r, s.overworld().getMinY(), s.overworld().getMaxY());
						o.add("plan", p.plan());
						JsonArray c = new JsonArray();
						c.add(p.claim().minX());
						c.add(p.claim().minZ());
						c.add(p.claim().maxX());
						c.add(p.claim().maxZ());
						o.add("claim", c);
						JsonObject an = new JsonObject();
						p.anchors().forEach((k, v) -> an.add(k, pos(v)));
						o.add("anchors", an);
					} catch (RuntimeException e) {
						o.addProperty("refused", "FIELD_LIMIT: " + e.getMessage());
					}
					return o;
				});
			});
	}

	private static ConnectorRequest request(JsonObject req, Fields f) {
		JsonObject params = req.get("params") instanceof JsonObject p ? p.deepCopy() : new JsonObject();
		boolean typed = req.has("typed") && req.get("typed").getAsBoolean();
		String owner = f.optStr("owner", null);
		if (owner != null && !typed) {
			params.addProperty(ConnectorPlace.PARAM_OWNER, owner);
		}
		String dim = f.optStr("dimension", null);
		if (dim != null && !typed) {
			params.addProperty(ConnectorPlace.PARAM_DIMENSION, dim);
		}
		Mode mode = Mode.valueOf(f.optStr("mode", "AUTO").toUpperCase(Locale.ROOT));
		ConnectorRequest r = new ConnectorRequest(f.nonBlank("kind"), at(req.getAsJsonArray("from")), at(req.getAsJsonArray("to")), f.optStr("styleId", null), params,
			mode, f.optStr("opKey", "dev.cx"));
		if (typed) {
			r = r.withParty(owner, dim == null ? null : net.minecraft.resources.ResourceKey.create(net.minecraft.core.registries.Registries.DIMENSION,
				net.minecraft.resources.Identifier.parse(dim)), null);
		}
		java.util.Map<String, Integer> cap = req.get("maxBill") instanceof JsonObject m ? counts(m) : null;
		java.util.Map<String, java.util.Map<String, Integer>> lotCaps = null;
		if (req.get("maxBillPerLot") instanceof JsonObject lm) {
			lotCaps = new java.util.LinkedHashMap<>();
			for (var e : lm.entrySet()) {
				lotCaps.put(e.getKey(), counts(e.getValue().getAsJsonObject()));
			}
		}
		if (cap != null || lotCaps != null) {
			r = r.withMaxBill(cap, lotCaps);
		}
		if (req.get("ext") instanceof JsonObject x) {
			r = r.withExt(x.deepCopy());
		}
		return r;
	}

	private static java.util.Map<String, Integer> counts(JsonObject m) {
		java.util.Map<String, Integer> o = new java.util.LinkedHashMap<>();
		m.entrySet().forEach(e -> o.put(e.getKey(), e.getValue().getAsInt()));
		return o;
	}

	private static BlockPos at(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	private static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	static JsonObject json(PlaceResult pr, long t0) {
		JsonObject o = new JsonObject();
		o.addProperty("placed", pr.placed());
		pr.siteId().ifPresent(id -> o.addProperty("siteId", id));
		JsonArray rs = new JsonArray();
		for (Refusal r : pr.refusals()) {
			JsonObject j = new JsonObject();
			j.addProperty("reason", r.reason().name());
			j.addProperty("message", r.message());
			rs.add(j);
		}
		o.add("refusals", rs);
		JsonArray ns = new JsonArray();
		pr.notes().forEach(ns::add);
		o.add("notes", ns);
		o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
		return o;
	}
}
