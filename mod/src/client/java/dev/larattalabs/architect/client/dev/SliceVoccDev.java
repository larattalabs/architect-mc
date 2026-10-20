package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.DeltaRequest;
import dev.larattalabs.architect.api.PaletteCheck;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.PaletteRules;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Phase 6c slice VOC-c DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT VOC-c §4, §9 items 5 and 6, S-VOCc-2, S-VOCc-3): the palette pre-check
 * through the API ({@code Regions.checkPalette}), an entry's block histogram as the mod measures it (the realise's and the check's
 * {@code lotBlocks}), a region's realise rows ({@code architect_mc:palette}), and a delta of a region's lot through the API
 * ({@code Sites.checkDelta} / {@code applyDelta}: the re-judge). Server work only (the headless server generates them too: devserver
 * genHooks).
 */
public final class SliceVoccDev {
	private SliceVoccDev() {
	}

	static JsonObject checkJson(PaletteCheck c) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", c.ok());
		JsonArray rules = new JsonArray();
		for (PaletteCheck.Rule r : c.rules()) {
			JsonObject x = new JsonObject();
			x.addProperty("rule", r.rule());
			x.addProperty("required", r.required());
			x.addProperty("family", r.family());
			JsonArray sh = new JsonArray();
			sh.add(r.shareMin());
			sh.add(r.shareMax());
			x.add("share", sh);
			x.addProperty("cells", r.cells());
			x.addProperty("familyCells", r.familyCells());
			x.addProperty("measured", r.share());
			x.addProperty("fits", r.fits());
			x.addProperty("worstLot", r.worstLot());
			JsonObject lots = new JsonObject();
			for (PaletteCheck.Lot l : r.lots()) {
				JsonObject lo = new JsonObject();
				lo.addProperty("entry", l.entry());
				lo.addProperty("cells", l.cells());
				lo.addProperty("familyCells", l.familyCells());
				lots.add(l.lot(), lo);
			}
			x.add("lots", lots);
			JsonArray p = new JsonArray();
			r.pendingLots().forEach(p::add);
			x.add("pendingLots", p);
			rules.add(x);
		}
		o.add("rules", rules);
		return o;
	}

	static JsonArray refusalsJson(List<Refusal> rs) {
		JsonArray a = new JsonArray();
		for (Refusal r : rs) {
			JsonObject o = new JsonObject();
			o.addProperty("reason", r.reason().name());
			o.addProperty("message", r.message());
			a.add(o);
		}
		return a;
	}

	public static void init() {
		DevBridge.register("dev.vocc.checkPalette", 30_000, "{sha, lotEntries?: {lot: entry}} - (6c VOC-c) Regions.checkPalette: the artifact's palette rules "
			+ "measured with these lot entries over its own -> {ok, rules: [{rule, required, family, share, cells, familyCells, measured, fits, worstLot, "
			+ "lots: {lot: {entry, cells, familyCells}}, pendingLots}]} or {missing}", (req, mc) -> {
				Fields f = Fields.of(req);
				String sha = f.nonBlank("sha");
				Map<String, String> lots = new LinkedHashMap<>();
				if (req.get("lotEntries") instanceof JsonObject le) {
					le.entrySet().forEach(e -> lots.put(e.getKey(), e.getValue().getAsString()));
				}
				return ServerTasks.callOnServer(s -> ArchitectApi.get().regions().checkPalette(sha, lots).map(SliceVoccDev::checkJson).orElseGet(() -> {
					JsonObject o = new JsonObject();
					o.addProperty("missing", sha);
					return o;
				}));
			});
		DevBridge.register("dev.vocc.histogram", 10_000, "{entry} - (6c VOC-c) the block histogram of the template a realise places for this entry (its "
			+ "current one's non-air blocks of the first palette, by id): what the check's lotBlocks and the realise measure -> {entry, blocks} or {missing}",
			(req, mc) -> {
				String entry = Fields.of(req).nonBlank("entry");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					var t = dev.larattalabs.architect.placement.Blueprints.template(entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry);
					if (t == null) {
						o.addProperty("missing", entry);
						return o;
					}
					JsonObject b = new JsonObject();
					PaletteRules.histogram(t).forEach(b::addProperty);
					o.addProperty("entry", entry);
					o.add("blocks", b);
					return o;
				});
			});
		DevBridge.register("dev.vocc.regionPalette", 10_000, "{region} - (6c VOC-c) a region's realise rows (its record's ext architect_mc:palette) -> {region, "
			+ "palette} (palette null when the plan had no palette rule over lots) or {missing}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("region");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					for (RegionsImpl.Live l : RegionsImpl.all()) {
						if (l.rec().id.equals(id)) {
							o.addProperty("region", id);
							o.add("palette", l.rec().ext != null && l.rec().ext.get(PaletteRules.EXT_PALETTE) != null ? l.rec().ext.get(PaletteRules.EXT_PALETTE).deepCopy() : null);
							return o;
						}
					}
					o.addProperty("missing", id);
					return o;
				});
			});
		DevBridge.register("dev.vocc.delta", 120_000, "{site, version?: 0 (the head), owner?, apply?: false} - (6c VOC-c) Sites.checkDelta (or applyDelta "
			+ "with apply) through the API, so a region lot's delta is judged against its palette rules -> {ok, refusals: [{reason, message}], notes} "
			+ "or {applied, refusals, notes}", (req, mc) -> {
				Fields f = Fields.of(req);
				String site = f.nonBlank("site");
				int v = f.optInt("version", 0, 0, 1_000_000);
				String owner = f.optStr("owner", null);
				boolean apply = f.optBool("apply", false);
				DeltaRequest r = new DeltaRequest(site, v, null, null, null, false, new JsonObject(), owner, null);
				if (!apply) {
					return ServerTasks.callOnServer(s -> {
						var verdict = ArchitectApi.get().sites(s).checkDelta(r);
						JsonObject o = new JsonObject();
						o.addProperty("ok", verdict.ok());
						o.add("refusals", refusalsJson(verdict.refusals()));
						JsonArray n = new JsonArray();
						verdict.notes().forEach(n::add);
						o.add("notes", n);
						return o;
					});
				}
				return ServerTasks.callOnServer(s -> ArchitectApi.get().sites(s).applyDelta(r)).thenCompose(x -> x).thenApply(res -> {
					JsonObject o = new JsonObject();
					o.addProperty("applied", res.applied());
					o.addProperty("written", res.written());
					o.add("refusals", refusalsJson(res.refusals()));
					JsonArray n = new JsonArray();
					res.notes().forEach(n::add);
					o.add("notes", n);
					return o;
				});
			});
	}
}
