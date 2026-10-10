package dev.larattalabs.apitest;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.EstimateRequest;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import net.minecraft.commands.CommandSourceStack;

/**
 * The slice 6c 0b steps of apitest (docs/CONTRACT.md "Phase 6c slice 0b" §7, the Java half): promoteCopy, versionOf with a
 * site, estimates by kind with SMALL originals, and the 1.11.0 surface check, through {@code dev.larattalabs.architect.api}
 * only. Group copies go through {@code group} (its JSON takes count, copyOf, effort, copyCap and smallBySize).
 */
public final class ApiTest0b {
	private ApiTest0b() {
	}

	private static String text(String s) {
		return new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8);
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "promote": {
				// promote <key> <groupId> <itemKey> <base64 reason>
				return ApiTest.later("promote:" + a[1], api.designs().promoteCopy(a[2], a[3], text(a[4])).thenApply(ApiTestSets::group));
			}
			case "versionof": {
				// versionof <key> <base64 design (notes = the change)> <entryId> <siteId|->
				var r = ApiTestSets.design(JsonParser.parseString(text(a[2])).getAsJsonObject()).versionOf(a[3], a[4].equals("-") ? null : a[4]);
				return ApiTest.later("versionof:" + a[1], api.designs().request(r).thenApply(JsonPrimitive::new));
			}
			case "estimatemix": {
				// estimatemix <key> <base64 {group?, originals, adapted, copies, smallOriginals, newBible, massingFirst, reportCritique}>
				JsonObject o = JsonParser.parseString(text(a[2])).getAsJsonObject();
				EstimateRequest r = new EstimateRequest(o.has("group") ? ApiTestSets.groupRequest(o.getAsJsonObject("group")) : null, i(o, "originals"), i(o,
					"adapted"), i(o, "copies"), b(o, "newBible"), b(o, "massingFirst"), b(o, "reportCritique"), null, i(o, "smallOriginals"));
				return ApiTest.later("estimatemix:" + a[1], api.designs().estimate(r).thenApply(e -> {
					JsonObject j = new JsonObject();
					j.addProperty("usdLow", e.usdLow());
					j.addProperty("usdHigh", e.usdHigh());
					j.addProperty("basis", e.basis());
					JsonObject k = new JsonObject();
					e.byKind().forEach((kind, item) -> {
						JsonObject l = new JsonObject();
						l.addProperty("usdLow", item.usdLow());
						l.addProperty("usdHigh", item.usdHigh());
						k.add(kind.name(), l);
					});
					j.add("byKind", k);
					return j;
				}));
			}
			case "api111": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				o.addProperty("copies", api.features().contains("copies"));
				o.addProperty("smallEffort", api.features().contains("smallEffort"));
				o.addProperty("versionOf", api.features().contains("versionOf"));
				return o;
			}
			default:
				return new JsonPrimitive("unknown step " + a[0]);
		}
	}

	private static int i(JsonObject o, String k) {
		return o.has(k) ? o.get(k).getAsInt() : 0;
	}

	private static boolean b(JsonObject o, String k) {
		return o.has(k) && o.get(k).getAsBoolean();
	}
}
