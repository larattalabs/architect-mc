package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.Massing;
import dev.larattalabs.architect.api.SiteEvents;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.commands.CommandSourceStack;

/**
 * The phase 4c steps of apitest (docs/CONTRACT.md "Phase 4c gate", the Java half): massings, redirects, detail passes with
 * conformance, deleteMassing, massingFirst groups and their approval (with the owner rule), and the composite preview (handed
 * to the client half, {@code ApiTestClient}), through {@code dev.larattalabs.architect.api} only. Structured arguments come as
 * base64 JSON. Results go under keys for {@code /apitest get <key>}.
 */
public final class ApiTestMassing {
	/** Composite requests for the client half: {"set", key, base64 layers} or {"clear", key}; results under "composite:<key>". */
	public static final ConcurrentLinkedQueue<String[]> COMPOSITE = new ConcurrentLinkedQueue<>();

	private ApiTestMassing() {
	}

	static void init() {
		SiteEvents.MASSING_DONE.register(m -> ApiTest.event("MASSING_DONE", massing(m)));
		SiteEvents.GROUP_AWAITING_APPROVAL.register(g -> ApiTest.event("GROUP_AWAITING_APPROVAL", ApiTestSets.group(g)));
	}

	private static JsonObject b64(String s) {
		return JsonParser.parseString(new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static String text(String s) {
		return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "massingreq": {
				// massingreq <key> <base64 design>: a massing job (massing: true)
				return ApiTest.later("massingreq:" + a[1], api.designs().request(ApiTestSets.design(b64(a[2])).massing(true)).thenApply(JsonPrimitive::new));
			}
			case "detail": {
				// detail <key> <base64 design with fromMassing (and massingVersion?)>
				return ApiTest.later("detail:" + a[1], api.designs().request(ApiTestSets.design(b64(a[2]))).thenApply(JsonPrimitive::new));
			}
			case "massingget": {
				// massingget <id> [version]
				var m = a.length > 2 ? api.designs().massing(a[1], Integer.parseInt(a[2])) : api.designs().massing(a[1]);
				return m.map(ApiTestMassing::massing).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "massings": {
				JsonArray arr = new JsonArray();
				api.designs().listMassings(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(m -> arr.add(massing(m)));
				return arr;
			}
			case "redirect": {
				// redirect <key> <massingId> <base64 notes> [owner]
				return ApiTest.later("redirect:" + a[1], api.designs().redirectMassing(a[2], text(a[3]), a.length > 4 ? a[4] : null).thenApply(
					ApiTestMassing::redirected));
			}
			case "massingdelete": {
				return ApiTest.later("massingdelete:" + a[1], api.designs().deleteMassing(a[1]).thenApply(JsonPrimitive::new));
			}
			case "designget": {
				return api.designs().get(a[1]).map(ApiTest::design).map(x -> (JsonElement) x).orElse(JsonNull.INSTANCE);
			}
			case "approve": {
				// approve <key> <groupId> <base64 {approve?: [..], redirect?: {k: notes}, cancel?: [..], owner?}>; no owner = the 4-argument form
				JsonObject o = b64(a[3]);
				List<String> approve = strings(o, "approve");
				List<String> cancel = strings(o, "cancel");
				Map<String, String> redirect = new LinkedHashMap<>();
				if (o.has("redirect")) {
					o.getAsJsonObject("redirect").entrySet().forEach(e -> redirect.put(e.getKey(), e.getValue().getAsString()));
				}
				CompletableFuture<Group.Approval> f = o.has("owner") ? api.designs().approveGroup(a[2], approve, redirect, cancel, o.get("owner")
					.getAsString()) : api.designs().approveGroup(a[2], approve, redirect, cancel);
				return ApiTest.later("approve:" + a[1], f.thenApply(ApiTestMassing::approval));
			}
			case "composite": {
				// composite <key> <base64 [{blueprintId, origin: [x,y,z], rotation?: 0-3, style, onlyCells?: [[x,y,z]..]}]>
				ApiTest.RESULTS.remove("composite:" + a[1]);
				COMPOSITE.add(new String[] {"set", a[1], a[2]});
				JsonObject o = new JsonObject();
				o.addProperty("pending", "composite:" + a[1]);
				return o;
			}
			case "compositeclear": {
				ApiTest.RESULTS.remove("composite:" + a[1]);
				COMPOSITE.add(new String[] {"clear", a[1]});
				JsonObject o = new JsonObject();
				o.addProperty("pending", "composite:" + a[1]);
				return o;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	private static List<String> strings(JsonObject o, String k) {
		List<String> out = new ArrayList<>();
		if (o.has(k)) {
			o.getAsJsonArray(k).forEach(e -> out.add(e.getAsString()));
		}
		return out;
	}

	// ------------------------------------------------------------------ JSON views

	static JsonObject massing(Massing m) {
		JsonObject o = new JsonObject();
		o.addProperty("id", m.id());
		o.addProperty("version", m.version());
		JsonArray vs = new JsonArray();
		m.versions().forEach(vs::add);
		o.add("versions", vs);
		o.addProperty("latest", m.latest());
		o.addProperty("designId", m.designId());
		o.addProperty("type", m.type());
		o.addProperty("name", m.name().orElse(null));
		o.addProperty("itemKey", m.itemKey().orElse(null));
		o.add("ext", m.ext());
		o.addProperty("owner", m.owner().orElse(null));
		o.addProperty("group", m.group().orElse(null));
		o.addProperty("bible", m.bible().map(b -> b.id() + "@" + b.version()).orElse(null));
		JsonObject parts = new JsonObject();
		m.parts().forEach((n, p) -> parts.addProperty(n, p.box().minX() + "," + p.box().minY() + "," + p.box().minZ() + ".." + p.box().maxX() + ","
			+ p.box().maxY() + "," + p.box().maxZ() + " (" + p.cells() + ")"));
		o.add("parts", parts);
		o.addProperty("size", m.size().x() + "x" + m.size().y() + "x" + m.size().z());
		o.addProperty("model", m.request().has("model") ? m.request().get("model").getAsString() : null);
		o.add("cost", ApiTestSets.cost(m.cost()));
		o.addProperty("nbt", m.nbt().toString());
		o.addProperty("nbtExists", java.nio.file.Files.isRegularFile(m.nbt()));
		o.addProperty("previews", m.previews().size());
		m.redirect().ifPresent(r -> {
			JsonObject j = new JsonObject();
			j.addProperty("fromVersion", r.fromVersion());
			j.addProperty("notes", r.notes());
			o.add("redirect", j);
		});
		m.detail().ifPresent(d -> {
			JsonObject j = new JsonObject();
			j.addProperty("designId", d.designId());
			j.addProperty("status", d.status().name());
			j.addProperty("entryId", d.entryId().orElse(null));
			o.add("detail", j);
		});
		o.addProperty("createdAt", m.createdAt());
		return o;
	}

	static JsonObject redirected(Group.Redirected r) {
		JsonObject o = new JsonObject();
		o.addProperty("designId", r.designId());
		o.addProperty("version", r.version());
		return o;
	}

	static JsonObject approval(Group.Approval a) {
		JsonObject o = new JsonObject();
		o.addProperty("groupId", a.groupId());
		JsonObject ap = new JsonObject();
		a.approved().forEach(ap::addProperty);
		o.add("approved", ap);
		JsonObject rd = new JsonObject();
		a.redirected().forEach((k, v) -> rd.add(k, redirected(v)));
		o.add("redirected", rd);
		JsonArray c = new JsonArray();
		a.cancelled().forEach(c::add);
		o.add("cancelled", c);
		return o;
	}
}
