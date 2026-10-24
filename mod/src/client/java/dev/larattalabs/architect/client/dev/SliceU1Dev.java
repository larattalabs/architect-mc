package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.library.StyleRoles;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;

/**
 * Style unification U1 DevBridge hooks (docs/DEVBRIDGE.md; docs/CONTRACT.md "Style unification" gate): a materials-only design with a
 * Style through the API (DesignRequest.withStyle), a variant with a Style's roles after a main-row edit (StyleRoles.editMain, the
 * Java fan-out; Library.makeVariant with roles inline), and bible.save round trips (Bibles.save, Bibles.get, Bibles.usable). Server
 * work only (the headless server generates them too: devserver genHooks).
 */
public final class SliceU1Dev {
	private SliceU1Dev() {
	}

	private static JsonObject refused(Throwable e) {
		Throwable c = e instanceof CompletionException && e.getCause() != null ? e.getCause() : e;
		JsonObject o = new JsonObject();
		o.addProperty("refused", String.valueOf(c.getMessage()));
		return o;
	}

	static JsonObject style(Bible b) {
		JsonObject o = new JsonObject();
		// styleId, not id: a reply's id is the correlation id
		o.addProperty("styleId", b.id());
		o.addProperty("version", b.version());
		o.addProperty("origin", b.origin());
		o.addProperty("builtin", b.builtin());
		o.addProperty("editable", b.editable());
		b.owner().ifPresent(w -> o.addProperty("owner", w));
		JsonObject r = new JsonObject();
		b.roles().forEach(r::addProperty);
		o.add("roles", r);
		com.google.gson.JsonArray vs = new com.google.gson.JsonArray();
		b.versions().forEach(vs::add);
		o.add("versions", vs);
		com.google.gson.JsonArray t = new com.google.gson.JsonArray();
		b.tags().forEach(t::add);
		o.add("tags", t);
		// (U5) its own parts
		com.google.gson.JsonArray pa = new com.google.gson.JsonArray();
		b.parts().forEach(pa::add);
		o.add("parts", pa);
		b.basedOn().ifPresent(p -> {
			JsonObject bo = new JsonObject();
			bo.addProperty("id", p.id());
			bo.addProperty("version", p.version());
			o.add("basedOn", bo);
		});
		return o;
	}

	static JsonObject design(Design d) {
		JsonObject o = new JsonObject();
		o.addProperty("designId", d.id());
		o.addProperty("status", d.status().name());
		o.addProperty("step", d.step());
		d.entryId().ifPresent(e -> o.addProperty("entryId", e));
		d.error().ifPresent(e -> o.addProperty("error", e));
		o.add("request", d.request());
		return o;
	}

	public static void init() {
		DevBridge.register("dev.style.design", 60_000, "{style, version?, name?, buildingType? (not type: that is the message type), size?: [x,y,z], owner?} - (U1) Designs.request of a "
			+ "materials-only design: DesignRequest.withStyle(Bibles.get(style)) -> {designId, palette (as sent)} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String id = f.nonBlank("style");
				String type = req.has("buildingType") ? req.get("buildingType").getAsString() : "cabin";
				int[] sz = req.has("size") ? new int[] {req.getAsJsonArray("size").get(0).getAsInt(), req.getAsJsonArray("size").get(1).getAsInt(),
					req.getAsJsonArray("size").get(2).getAsInt()} : new int[] {21, 16, 21};
				String name = req.has("name") ? req.get("name").getAsString() : null;
				String owner = req.has("owner") ? req.get("owner").getAsString() : null;
				return ServerTasks.callOnServer(s -> {
					var bibles = ArchitectApi.get().bibles();
					Bible b = (req.has("version") ? bibles.get(id, req.get("version").getAsInt()) : bibles.get(id)).orElseThrow(() -> new DevBridge.DevException(
						"no Style " + id));
					DesignRequest r = new DesignRequest(type, id, null, List.of(), new BlockSize(sz[0], sz[1], sz[2]), name, null, null, owner, new JsonObject(),
						null, null, null, null).withStyle(b);
					return ArchitectApi.get().designs().request(r).thenApply(designId -> {
						JsonObject o = new JsonObject();
						o.addProperty("designId", designId);
						o.add("palette", r.palette());
						return o;
					});
				}).thenCompose(x -> x).exceptionally(SliceU1Dev::refused);
			});
		DevBridge.register("dev.style.designState", 10_000, "{designId} - (U1) Designs.get -> {designId, status, step, entryId?, error?, request} or {missing}",
			(req, mc) -> {
				String id = Fields.of(req).nonBlank("designId");
				return ServerTasks.callOnServer(s -> ArchitectApi.get().designs().get(id).map(SliceU1Dev::design).orElseGet(() -> {
					JsonObject o = new JsonObject();
					o.addProperty("missing", id);
					return o;
				}));
			});
		DevBridge.register("dev.style.variant", 150_000, "{entryId, style, version?, edits: [[field, value], ...]} - (U1) the Style's roles after "
			+ "main-row edits (StyleRoles.editMain, the Java fan-out), then Library.makeVariant with them inline ({bible: {id, version, roles}}) -> "
			+ "{entryId, roles, provenance} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String entry = f.nonBlank("entryId");
				String id = f.nonBlank("style");
				return ServerTasks.callOnServer(s -> {
					var bibles = ArchitectApi.get().bibles();
					Bible b = (req.has("version") ? bibles.get(id, req.get("version").getAsInt()) : bibles.get(id)).orElseThrow(() -> new DevBridge.DevException(
						"no Style " + id));
					StyleRoles sr = StyleRoles.fallback();
					Map<String, String> roles = b.roles();
					if (req.has("edits")) {
						for (var e : req.getAsJsonArray("edits")) {
							roles = sr.editMain(roles, e.getAsJsonArray().get(0).getAsString(), e.getAsJsonArray().get(1).getAsString());
						}
					}
					Map<String, String> sent = roles;
					JsonObject pv = new JsonObject();
					sr.provenance(sent, b.roles()).forEach(pv::addProperty);
					return ArchitectApi.get().library().makeVariant(entry, DesignRequest.stylePalette(b.id(), b.version(), sent), null, null).thenApply(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("entryId", e.id());
						JsonObject r = new JsonObject();
						sent.forEach(r::addProperty);
						o.add("roles", r);
						o.add("provenance", pv);
						return o;
					});
				}).thenCompose(x -> x).exceptionally(SliceU1Dev::refused);
			});
		DevBridge.register("dev.style.save", 60_000, "{bibleId?, owner?, style: {name, roles, ...}} - (U1) Bibles.save -> the saved Style {styleId, version, "
			+ "versions, origin, roles, ...} or {refused}", (req, mc) -> {
				String bid = req.has("bibleId") && !req.get("bibleId").isJsonNull() ? req.get("bibleId").getAsString() : null;
				String owner = req.has("owner") && !req.get("owner").isJsonNull() ? req.get("owner").getAsString() : null;
				JsonObject st = req.getAsJsonObject("style");
				CompletableFuture<JsonObject> fut = ServerTasks.callOnServer(s -> ArchitectApi.get().bibles().save(bid, st, owner)).thenCompose(x -> x)
					.thenApply(SliceU1Dev::style);
				return fut.exceptionally(SliceU1Dev::refused);
			});
		DevBridge.register("dev.style.parts", 60_000, "{style, version?, owner?} - (U5b) Bibles.addParts -> {jobId, bibleId, version} or {refused}; with "
			+ "estimate: true, Bibles.estimateParts -> {usdLow, usdHigh, basis}", (req, mc) -> {
				var bibles = ArchitectApi.get().bibles();
				if (req.has("estimate") && req.get("estimate").getAsBoolean()) {
					return ServerTasks.callOnServer(s -> bibles.estimateParts()).thenCompose(x -> x).thenApply(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("usdLow", e.usdLow());
						o.addProperty("usdHigh", e.usdHigh());
						o.addProperty("minutesLow", e.minutesLow());
						o.addProperty("minutesHigh", e.minutesHigh());
						o.addProperty("basis", e.basis());
						return o;
					}).exceptionally(SliceU1Dev::refused);
				}
				String id = Fields.of(req).nonBlank("style");
				Integer v = req.has("version") && !req.get("version").isJsonNull() ? req.get("version").getAsInt() : null;
				String owner = req.has("owner") && !req.get("owner").isJsonNull() ? req.get("owner").getAsString() : null;
				return ServerTasks.callOnServer(s -> bibles.addParts(id, v, owner)).thenCompose(x -> x).thenApply(j -> {
					JsonObject o = new JsonObject();
					o.addProperty("jobId", j.id());
					o.addProperty("bibleId", j.bibleId());
					o.addProperty("version", j.version());
					return o;
				}).exceptionally(SliceU1Dev::refused);
			});
		DevBridge.register("dev.style.get", 10_000, "{style, version?} - (U1) Bibles.get -> the Style (style: its id; not id, that is the correlation id), or {missing}; with usable: true, Bibles.usable(null)"
			+ " -> {usable: [ids]}", (req, mc) -> ServerTasks.callOnServer(s -> {
				var bibles = ArchitectApi.get().bibles();
				if (req.has("usable") && req.get("usable").getAsBoolean()) {
					JsonObject o = new JsonObject();
					com.google.gson.JsonArray a = new com.google.gson.JsonArray();
					bibles.usable(null).forEach(b -> a.add(b.id()));
					o.add("usable", a);
					return o;
				}
				String id = Fields.of(req).nonBlank("style");
				var b = req.has("version") ? bibles.get(id, req.get("version").getAsInt()) : bibles.get(id);
				return b.map(SliceU1Dev::style).orElseGet(() -> {
					JsonObject o = new JsonObject();
					o.addProperty("missing", id);
					return o;
				});
			}));
	}
}
