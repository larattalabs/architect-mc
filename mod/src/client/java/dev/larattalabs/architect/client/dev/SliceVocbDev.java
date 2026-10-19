package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BibleJob;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.apiimpl.Wire4b;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;

/**
 * Phase 6c slice VOC-b DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT VOC §4.3, §8 item 8): a bible request with a rarity budget through the
 * API (Bibles.request with BibleRequest.Rarity: the typed record, Wire4b, the sidecar's FIELD_LIMIT check, the bible job copying it), and
 * the job's state. Server work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceVocbDev {
	private SliceVocbDev() {
	}

	/** A rarity JSON object as the typed record (every member optional). */
	static BibleRequest.Rarity rarityOf(JsonObject o) {
		Map<String, Double> fam = null;
		if (o.has("families")) {
			fam = new TreeMap<>();
			for (Map.Entry<String, JsonElement> e : o.getAsJsonObject("families").entrySet()) {
				fam.put(e.getKey(), e.getValue().getAsDouble());
			}
		}
		return new BibleRequest.Rarity(o.has("uncommonShareMax") ? o.get("uncommonShareMax").getAsDouble() : null,
			o.has("rareShareMax") ? o.get("rareShareMax").getAsDouble() : null, o.has("preciousMax") ? o.get("preciousMax").getAsInt() : null,
			o.has("preciousRegionMax") ? o.get("preciousRegionMax").getAsInt() : null, fam, strings(o, "colours"),
			o.has("coloursMax") ? o.get("coloursMax").getAsInt() : null, o.has("rareFamiliesMax") ? o.get("rareFamiliesMax").getAsInt() : null, strings(o, "allow"));
	}

	private static List<String> strings(JsonObject o, String k) {
		if (!o.has(k)) {
			return null;
		}
		List<String> l = new ArrayList<>();
		for (JsonElement e : o.getAsJsonArray(k)) {
			l.add(e.getAsString());
		}
		return l;
	}

	private static JsonObject job(BibleJob j) {
		JsonObject o = new JsonObject();
		o.addProperty("jobId", j.id());
		o.addProperty("bibleId", j.bibleId());
		o.addProperty("version", j.version());
		o.addProperty("status", j.status().name());
		o.addProperty("step", j.step());
		j.error().ifPresent(e -> o.addProperty("error", e));
		o.add("request", j.request());
		return o;
	}

	public static void init() {
		DevBridge.register("dev.vocab.bibleRequest", 120_000, "{prompt, name?, owner?, scope?, seedPreset?, rarity?: {...}, opKey?} - (6c VOC-b) "
			+ "Bibles.request with BibleRequest.Rarity (the typed record from the JSON) -> {jobId, bibleId, version, status, wire (Wire4b's "
			+ "request JSON), request} or {refused, code?}", (req, mc) -> {
				Fields f = Fields.of(req);
				String prompt = f.nonBlank("prompt");
				String name = req.has("name") ? req.get("name").getAsString() : null;
				BibleRequest r = new BibleRequest(prompt, name, req.has("owner") ? req.get("owner").getAsString() : null, new JsonObject(), null, null, List.of(),
					req.has("scope") ? req.get("scope").getAsString() : null, req.has("seedPreset") ? req.get("seedPreset").getAsString() : null, false,
					req.has("opKey") ? req.get("opKey").getAsString() : null);
				if (req.has("rarity")) {
					r = r.withRarity(rarityOf(req.getAsJsonObject("rarity")));
				}
				BibleRequest sent = r;
				JsonObject wire = Wire4b.bibleRequest(sent);
				CompletableFuture<BibleJob> fut = ServerTasks.callOnServer(s -> ArchitectApi.get().bibles().request(sent)).thenCompose(x -> x);
				return fut.handle((j, e) -> {
					JsonObject o = new JsonObject();
					o.add("wire", wire);
					if (e != null) {
						Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
						o.addProperty("refused", String.valueOf(c.getMessage()));
						if (c instanceof dev.larattalabs.architect.api.ArchitectRefused ar) {
							o.addProperty("code", ar.reason().name());
							o.addProperty("detail", String.valueOf(ar.detail()));
						}
						return o;
					}
					JsonObject jo = job(j);
					for (String k : jo.keySet()) {
						o.add(k, jo.get(k));
					}
					return o;
				});
			});
		DevBridge.register("dev.vocab.bibleJob", 10_000, "{jobId} - (6c VOC-b) Bibles.job -> {jobId, bibleId, version, status, step, error?, request} or {missing}",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("jobId");
				return ServerTasks.callOnServer(s -> {
					var j = ArchitectApi.get().bibles().job(id);
					if (j.isEmpty()) {
						JsonObject o = new JsonObject();
						o.addProperty("missing", id);
						return o;
					}
					return job(j.get());
				});
			});
	}
}
