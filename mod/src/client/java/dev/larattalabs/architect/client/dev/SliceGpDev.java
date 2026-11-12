package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BiblePin;
import dev.larattalabs.architect.api.CheckReport;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.ProgramRefused;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;

/**
 * M5 slice GP DevBridge hooks (docs/DEVBRIDGE.md "M5 GP"): given-program designs through the public API ({@code Designs.fromProgram},
 * {@code Designs.variant}, {@code Designs.variantByKey}). Headless (genHooks). A refusal answers {@code refused: "<REASON>: message"},
 * {@code detail} and, for a {@link ProgramRefused}, {@code findings: [{rule, severity, message}]}.
 */
public final class SliceGpDev {
	private SliceGpDev() {
	}

	public static void init() {
		DevBridge.register("dev.gp.fromProgram", 300_000, "{source, params?: {}, bible?: {id, version?}, opKey, owner?} - (M5 GP) Designs.fromProgram -> {entryId, ms} or "
			+ "{refused, detail, findings?}", (req, mc) -> {
				Fields f = Fields.of(req);
				String source = f.nonBlank("source");
				JsonObject params = req.has("params") ? req.getAsJsonObject("params") : new JsonObject();
				BiblePin bible = bible(req);
				String opKey = f.nonBlank("opKey");
				String owner = f.optStr("owner", null);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().fromProgram(source, params, bible, opKey, owner)).thenCompose(x -> x).thenApply(id -> done(id,
					t0)).exceptionally(SliceGpDev::refused);
			});
		DevBridge.register("dev.gp.variant", 300_000, "{entryId, params?: {}, bible?: {id, version?}, reserved?: {front, size: [w, d], cells: [[u, y, v]...]}, opKey, "
			+ "owner?} - (M5 GP) Designs.variant -> {entryId, ms} or {refused, detail, findings?}", (req, mc) -> {
				Fields f = Fields.of(req);
				String entryId = f.nonBlank("entryId");
				JsonObject params = req.has("params") ? req.getAsJsonObject("params") : new JsonObject();
				BiblePin bible = bible(req);
				DesignRequest.Reserved reserved = req.has("reserved") ? reserved(req.getAsJsonObject("reserved")) : null;
				String opKey = f.nonBlank("opKey");
				String owner = f.optStr("owner", null);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().variant(entryId, params, bible, reserved, opKey, owner)).thenCompose(x -> x).thenApply(
					id -> done(id, t0)).exceptionally(SliceGpDev::refused);
			});
		DevBridge.register("dev.gp.byKey", 120_000, "{opKey, owner?} - (M5 GP) Designs.variantByKey -> {found, entryId?} or {refused, detail, findings?}", (req, mc) -> {
			Fields f = Fields.of(req);
			String opKey = f.nonBlank("opKey");
			String owner = f.optStr("owner", null);
			return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().variantByKey(owner, opKey)).thenCompose(x -> x).thenApply(o -> {
				JsonObject j = new JsonObject();
				j.addProperty("found", o.isPresent());
				o.ifPresent(id -> j.addProperty("entryId", id));
				return j;
			}).exceptionally(SliceGpDev::refused);
		});
	}

	private static BiblePin bible(JsonObject req) {
		if (!(req.get("bible") instanceof JsonObject b)) {
			return null;
		}
		return new BiblePin(b.get("id").getAsString(), b.has("version") ? b.get("version").getAsInt() : 0);
	}

	private static DesignRequest.Reserved reserved(JsonObject r) {
		JsonArray size = r.getAsJsonArray("size");
		List<BlockPos> cells = new ArrayList<>();
		for (JsonElement e : r.getAsJsonArray("cells")) {
			JsonArray c = e.getAsJsonArray();
			cells.add(new BlockPos(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()));
		}
		return new DesignRequest.Reserved(r.get("front").getAsString(), size.get(0).getAsInt(), size.get(1).getAsInt(), cells);
	}

	private static JsonObject done(String id, long t0) {
		JsonObject o = new JsonObject();
		o.addProperty("entryId", id);
		o.addProperty("ms", (System.nanoTime() - t0) / 1_000_000);
		return o;
	}

	private static JsonObject refused(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		o.addProperty("refused", RegionDev.reason(c));
		if (c instanceof ArchitectRefused r) {
			o.addProperty("detail", r.detail() == null ? "" : r.detail());
		}
		if (c instanceof ProgramRefused p) {
			JsonArray a = new JsonArray();
			for (CheckReport.Finding f : p.report().findings()) {
				JsonObject j = new JsonObject();
				j.addProperty("rule", f.rule());
				j.addProperty("severity", f.severity());
				j.addProperty("message", f.message());
				a.add(j);
			}
			o.add("findings", a);
		}
		return o;
	}
}
