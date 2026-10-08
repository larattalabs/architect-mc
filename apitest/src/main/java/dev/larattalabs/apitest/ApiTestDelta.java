package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlueprintDelta;
import dev.larattalabs.architect.api.DeltaRequest;
import dev.larattalabs.architect.api.DeltaResult;
import dev.larattalabs.architect.api.DeltaVerdict;
import dev.larattalabs.architect.api.EntryVersion;
import dev.larattalabs.architect.api.KeptCell;
import dev.larattalabs.architect.api.OutdatedSite;
import dev.larattalabs.architect.api.OverlapPolicy;
import dev.larattalabs.architect.api.PartDelta;
import dev.larattalabs.architect.api.PlayerEdits;
import dev.larattalabs.architect.api.Polish;
import dev.larattalabs.architect.api.PolishApply;
import dev.larattalabs.architect.api.PolishRequest;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.SiteVersion;
import dev.larattalabs.architect.api.Sites;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;

/**
 * The phase 5b API checks (docs/CONTRACT.md "Phase 5b gate" 4 and 7), through dev.larattalabs.architect.api only:
 * <pre>
 * checkdelta &lt;site&gt; &lt;version&gt; [keep|overwrite|refuse] [layer] [owner|-] [force]   Sites.checkDelta
 * applydelta &lt;site&gt; &lt;version&gt; [keep|overwrite|refuse] [layer] [owner|-] [force] [actor]  Sites.applyDelta -> pending "delta:&lt;site&gt;:&lt;v&gt;"
 * srevert &lt;site&gt; &lt;version&gt; [actor]         Sites.revert -> pending "revert:&lt;site&gt;:&lt;v&gt;"
 * shistory &lt;site&gt;                           Sites.history
 * outdated [owner|-]                         Sites.outdated
 * eversions &lt;entry&gt;                         Library.versions and the entry's version
 * edelta &lt;entry&gt; &lt;from&gt; &lt;to&gt;                Library.delta -> pending "edelta:&lt;entry&gt;"
 * erevert &lt;entry&gt; &lt;version&gt;                Library.revertEntry -> pending "erevert:&lt;entry&gt;"
 * polish &lt;entry&gt; [steps] [preview|apply|none] [notes...]   Designs.polish -> pending "polish:&lt;entry&gt;" (the design id)
 * polishest &lt;entry&gt; [steps]                 Designs.estimatePolish -> pending "polishest:&lt;entry&gt;"
 * api17                                      the version and the 1.7.0 features, reasons and enum orders
 * </pre>
 */
final class ApiTestDelta {
	private ApiTestDelta() {
	}

	static void register() {
		SiteEvents.SITE_UPDATED.register((a, b, r) -> {
			JsonObject o = ApiTest.site(b);
			o.add("result", result(r));
			o.addProperty("fromVersion", a.version());
			event("SITE_UPDATED", o);
		});
		SiteEvents.ENTRY_VERSIONED.register((e, from) -> {
			JsonObject o = new JsonObject();
			o.addProperty("entry", e.id());
			o.addProperty("version", e.version());
			o.addProperty("from", from);
			event("ENTRY_VERSIONED", o);
		});
	}

	private static void event(String name, JsonObject o) {
		ApiTest.event(name, o);
	}

	static DeltaRequest request(String[] a, int from, ServerPlayer player) {
		PlayerEdits e = null;
		OverlapPolicy ov = null;
		String owner = null;
		boolean force = false;
		boolean actor = false;
		for (int i = from; i < a.length; i++) {
			switch (a[i].toLowerCase(Locale.ROOT)) {
				case "keep", "overwrite", "refuse" -> e = PlayerEdits.valueOf(a[i].toUpperCase(Locale.ROOT));
				case "layer" -> ov = OverlapPolicy.LAYER;
				case "force" -> force = true;
				case "actor" -> actor = true;
				case "-" -> owner = null;
				default -> owner = a[i];
			}
		}
		return new DeltaRequest(a[1], Integer.parseInt(a[2]), e, ov, actor ? player : null, force, new JsonObject(), owner);
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		Sites sites = ArchitectApi.get().sites(src.getServer());
		ServerPlayer player = src.getPlayer();
		switch (a[0]) {
			case "checkdelta":
				return verdict(sites.checkDelta(request(a, 3, player)));
			case "applydelta":
				return ApiTest.later("delta:" + a[1] + ":" + a[2], sites.applyDelta(request(a, 3, player)).thenApply(ApiTestDelta::result));
			case "srevert":
				return ApiTest.later("revert:" + a[1] + ":" + a[2], sites.revert(a[1], Integer.parseInt(a[2]), a.length > 3 && a[3].equals("actor") ? player
					: null).thenApply(ApiTestDelta::result));
			case "shistory": {
				JsonArray out = new JsonArray();
				for (SiteVersion v : sites.history(a[1])) {
					JsonObject o = new JsonObject();
					o.addProperty("version", v.version());
					o.addProperty("kind", v.kind().name());
					o.addProperty("revertible", v.revertible());
					out.add(o);
				}
				return out;
			}
			case "outdated": {
				JsonArray out = new JsonArray();
				for (OutdatedSite s : sites.outdated(a.length > 1 && !a[1].equals("-") ? a[1] : null)) {
					JsonObject o = new JsonObject();
					o.addProperty("site", s.siteId());
					o.addProperty("entry", s.entryId());
					o.addProperty("version", s.version());
					o.addProperty("head", s.headVersion());
					out.add(o);
				}
				return out;
			}
			case "eversions": {
				var lib = ArchitectApi.get().library();
				JsonObject o = new JsonObject();
				o.addProperty("version", lib.get(a[1]).map(e -> e.version()).orElse(0));
				JsonArray vs = new JsonArray();
				for (EntryVersion v : lib.versions(a[1])) {
					JsonObject x = new JsonObject();
					x.addProperty("n", v.version());
					x.addProperty("by", v.by());
					x.addProperty("parent", v.parent());
					x.addProperty("summary", v.summary());
					x.addProperty("pinned", v.pinned());
					vs.add(x);
				}
				o.add("versions", vs);
				o.addProperty("atVersion1", lib.entry(a[1], 1).isPresent());
				return o;
			}
			case "edelta":
				return ApiTest.later("edelta:" + a[1], ArchitectApi.get().library().delta(a[1], Integer.parseInt(a[2]), Integer.parseInt(a[3]))
					.thenApply(ApiTestDelta::delta));
			case "erevert":
				return ApiTest.later("erevert:" + a[1], ArchitectApi.get().library().revertEntry(a[1], Integer.parseInt(a[2])).thenApply(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("entry", e.id());
					o.addProperty("version", e.version());
					return o;
				}));
			case "polish": {
				int steps = a.length > 2 ? Integer.parseInt(a[2]) : 2;
				String mode = a.length > 3 ? a[3] : "preview";
				String notes = a.length > 4 ? String.join(" ", List.of(a).subList(4, a.length)) : null;
				PolishApply apply = mode.equals("none") ? null : new PolishApply(List.of(), !mode.equals("apply"));
				PolishRequest r = new PolishRequest(a[1], null, null, null, notes, steps, null, null, "apitest:polish", new JsonObject(), apply);
				return ApiTest.later("polish:" + a[1], ArchitectApi.get().designs().polish(r).thenApply(id -> {
					JsonObject o = new JsonObject();
					o.addProperty("designId", id);
					return o;
				}));
			}
			case "polishest": {
				int steps = a.length > 2 ? Integer.parseInt(a[2]) : 2;
				PolishRequest r = new PolishRequest(a[1], null, null, null, null, steps, null, null, null, new JsonObject(), null);
				return ApiTest.later("polishest:" + a[1], ArchitectApi.get().designs().estimatePolish(r).thenApply(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("polish", e.polish());
					o.addProperty("usdLow", e.polishUsdLow());
					o.addProperty("usdHigh", e.polishUsdHigh());
					o.addProperty("minutesLow", e.polishMinutesLow());
					o.addProperty("minutesHigh", e.polishMinutesHigh());
					return o;
				}));
			}
			case "polishget": {
				var d = ArchitectApi.get().designs().get(a[1]);
				JsonObject o = new JsonObject();
				d.ifPresent(x -> {
					o.addProperty("status", x.status().name());
					o.addProperty("kind", x.kind().name());
					x.polish().ifPresent(p -> o.add("polish", polish(p)));
				});
				return o;
			}
			case "api17": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				JsonArray f = new JsonArray();
				ArchitectApi.get().features().stream().sorted().forEach(f::add);
				o.add("features", f);
				JsonArray r = new JsonArray();
				for (var x : dev.larattalabs.architect.api.Reason.values()) {
					r.add(x.name());
				}
				o.add("reasons", r);
				o.addProperty("critiqueModes", java.util.Arrays.toString(dev.larattalabs.architect.api.CritiqueMode.values()));
				o.addProperty("partStatus", java.util.Arrays.toString(dev.larattalabs.architect.api.PartStatus.values()));
				o.addProperty("playerEdits", java.util.Arrays.toString(PlayerEdits.values()));
				o.addProperty("designKinds", java.util.Arrays.toString(dev.larattalabs.architect.api.Design.Kind.values()));
				o.addProperty("polishEnds", java.util.Arrays.toString(Polish.End.values()));
				return o;
			}
			default:
				JsonObject err = new JsonObject();
				err.addProperty("error", "unknown " + a[0]);
				return err;
		}
	}

	static JsonObject polish(Polish p) {
		JsonObject o = new JsonObject();
		o.addProperty("from", p.fromVersion());
		o.addProperty("installed", p.installedVersion());
		o.addProperty("end", p.end().name());
		o.addProperty("steps", p.steps().size());
		o.addProperty("accepted", p.steps().stream().filter(Polish.Step::accepted).count());
		o.addProperty("usd", p.cost().usd());
		return o;
	}

	static JsonObject verdict(DeltaVerdict v) {
		JsonObject o = new JsonObject();
		o.addProperty("applicable", v.ok());
		o.add("refusals", ApiTest.refusals(v.refusals()));
		o.addProperty("added", v.added());
		o.addProperty("removed", v.removed());
		o.addProperty("changed", v.changed());
		o.add("parts", parts(v.parts()));
		o.add("kept", kept(v.kept()));
		o.add("bom", items(v.bom()));
		o.add("refund", items(v.refund()));
		o.addProperty("box", v.box().toString());
		o.addProperty("mode", v.mode().name());
		JsonArray n = new JsonArray();
		v.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static JsonObject result(DeltaResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("applied", r.applied());
		o.addProperty("site", r.siteId());
		o.addProperty("from", r.fromVersion());
		o.addProperty("to", r.toVersion());
		o.addProperty("written", r.written());
		o.add("kept", kept(r.kept()));
		o.add("refund", items(r.refund()));
		o.addProperty("reshaped", r.reshaped());
		o.add("refusals", ApiTest.refusals(r.refusals()));
		JsonArray n = new JsonArray();
		r.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static JsonObject delta(BlueprintDelta d) {
		JsonObject o = new JsonObject();
		o.addProperty("entry", d.entryId());
		o.addProperty("from", d.from());
		o.addProperty("to", d.to());
		o.addProperty("frameKept", d.frameKept());
		o.addProperty("approximate", d.approximate());
		o.add("parts", parts(d.parts()));
		o.addProperty("added", d.added());
		o.addProperty("removed", d.removed());
		o.addProperty("changed", d.changed());
		o.addProperty("unchanged", d.unchanged());
		return o;
	}

	static JsonObject parts(Map<String, PartDelta> ps) {
		JsonObject o = new JsonObject();
		ps.forEach((n, p) -> o.addProperty(n, p.status().name() + " +" + p.added() + " -" + p.removed() + " ~" + p.changed()));
		return o;
	}

	static JsonArray kept(List<KeptCell> ks) {
		JsonArray a = new JsonArray();
		for (KeptCell k : ks) {
			a.add(k.pos().getX() + "," + k.pos().getY() + "," + k.pos().getZ());
		}
		return a;
	}

	static JsonObject items(Map<Item, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach((k, v) -> o.addProperty(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(k).toString(), v));
		return o;
	}
}
