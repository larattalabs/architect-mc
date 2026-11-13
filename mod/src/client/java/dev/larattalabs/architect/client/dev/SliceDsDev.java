package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.SiteBinding;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.List;
import java.util.Optional;

/**
 * Phase 7b slice DS DevBridge hooks (docs/DEVBRIDGE.md "7b DS"): a site-aware design and a site variant through the public API
 * ({@code Designs.request} with {@code DesignRequest.site}, {@code Designs.siteVariant}), and what the library then holds (the entry's
 * {@link SiteBinding}, its derivation). Headless (genHooks). A refusal answers {@code refused: "<REASON>: message"} and {@code detail}.
 */
public final class SliceDsDev {
	private SliceDsDev() {
	}

	public static void init() {
		DevBridge.register("dev.ds.request", 60_000, "{site (a site spec's wire), plain?, buildingType?, style?, name?, notes?, opKey?, budgetUsd?, bible?, versionOf?} - (7b DS; PA: budgetUsd, bible, "
				+ "versionOf) Designs.request with a "
			+ "site (the volume sent from this world's frozen file) -> {designId} or {refused, detail}", (req, mc) -> {
				Fields f = Fields.of(req);
				// {plain: true}: the same request without the site (the BRIEF diffed against a plain one)
				boolean plain = req.has("plain") && req.get("plain").getAsBoolean();
				SiteSpec site = SiteSpec.fromWire(req.getAsJsonObject("site"));
				// the 26-argument (1.52.0) constructor: type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible,
				// group, profile, bibleVersion, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite, reserved, palette, opKey
				// (7b PA) budgetUsd (the job's hard stop), bible (a built-in Style with its parts) and versionOf (a paid adaptation: that entry built
				// into this site) for the paid batch's driver (tools/gate7bpa.mjs); absent: as DS had them
				DesignRequest r = new DesignRequest(f.optStr("buildingType", "cabin"), f.optStr("style", "rustic"), null, List.of(), new BlockSize(20, 24, 20), f.optStr(
					"name", null), f.optStr("notes", null), null, null, null, null, f.optNum("budgetUsd"), f.optStr("bible", null), null, List.of(), null, false, null,
					null, null, null, f.optStr("versionOf", null), null, null, null, f.optStr("opKey", null)).withSite(plain ? null : site);
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().request(r)).thenCompose(x -> x).thenApply(id -> {
					JsonObject o = new JsonObject();
					o.addProperty("designId", id);
					return o;
				}).exceptionally(SliceDsDev::refused);
			});
		DevBridge.register("dev.ds.design", 30_000, "{designId} - (7b DS) Designs.get -> {status, step, cost {usd, turns, inputTokens, outputTokens} (PA), entryId?, error?} and, once done, the entry: "
			+ "{binding (SiteBinding.of), ext, size}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("designId");
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					Optional<Design> d = ArchitectApi.get().designs().get(id);
					if (d.isEmpty()) {
						o.addProperty("status", "UNKNOWN");
						return o;
					}
					o.addProperty("status", d.get().status().name());
					o.addProperty("step", d.get().step());
					// (7b PA) the job's own reported usage (the paid batch's ledger reads it)
					JsonObject cost = new JsonObject();
					cost.addProperty("usd", d.get().cost().usd());
					cost.addProperty("turns", d.get().cost().turns());
					cost.addProperty("inputTokens", d.get().cost().inputTokens());
					cost.addProperty("outputTokens", d.get().cost().outputTokens());
					o.add("cost", cost);
					d.get().error().ifPresent(e -> o.addProperty("error", e));
					d.get().entryId().ifPresent(e -> {
						o.addProperty("entryId", e);
						o.add("entry", entry(e));
					});
					return o;
				});
			});
		DevBridge.register("dev.ds.entry", 30_000, "{entryId} - (7b DS) the loaded library entry: {known, binding, derivation: {source, sourceVersion, "
			+ "kind, recipe}, ext, size}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("entryId");
				return ServerTasks.callOnServer(s -> entry(id));
			});
		DevBridge.register("dev.ds.variant", 600_000, "{entryId, site (a site spec's wire), opKey} - (7b DS) Designs.siteVariant -> {entryId, ms} or "
			+ "{refused, detail}", (req, mc) -> {
				Fields f = Fields.of(req);
				String entryId = f.nonBlank("entryId");
				String opKey = f.nonBlank("opKey");
				SiteSpec site = SiteSpec.fromWire(req.getAsJsonObject("site"));
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().siteVariant(entryId, site, opKey)).thenCompose(x -> x).thenApply(id -> {
					JsonObject o = new JsonObject();
					o.addProperty("entryId", id);
					o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
					return o;
				}).exceptionally(SliceDsDev::refused);
			});
	}

	private static JsonObject entry(String id) {
		JsonObject o = new JsonObject();
		Optional<Library.Entry> e = ArchitectApi.get().library().get(id);
		o.addProperty("known", e.isPresent());
		if (e.isEmpty()) {
			return o;
		}
		SiteBinding.of(e.get()).ifPresent(b -> o.add("binding", b.wire()));
		e.get().derivation().ifPresent(d -> {
			JsonObject j = new JsonObject();
			j.addProperty("source", d.source());
			j.addProperty("sourceVersion", d.sourceVersion());
			j.addProperty("kind", d.kind().name());
			j.add("recipe", d.recipe().deepCopy());
			o.add("derivation", j);
		});
		o.add("ext", e.get().ext().deepCopy());
		JsonObject size = new JsonObject();
		size.addProperty("x", e.get().size().x());
		size.addProperty("y", e.get().size().y());
		size.addProperty("z", e.get().size().z());
		o.add("size", size);
		return o;
	}

	private static JsonObject refused(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		o.addProperty("refused", RegionDev.reason(c));
		if (c instanceof dev.larattalabs.architect.api.ArchitectRefused r) {
			o.addProperty("detail", r.detail() == null ? "" : r.detail());
		}
		return o;
	}
}
