package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.EstimateRequest;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.MassingRef;
import dev.larattalabs.architect.api.Reason;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 6c slice 0a (API 1.10.0) steps (tools/gate6c0a.mjs):
 * <pre>
 * opbible &lt;key&gt; &lt;opKey&gt; &lt;base64 {prompt, name?, owner?}&gt;   Bibles.request with an opKey
 * opgroup &lt;key&gt; &lt;opKey&gt; &lt;base64 group&gt;                    Designs.requestGroup with an opKey (ApiTestSets.groupRequest's JSON)
 * jobbykey|groupbykey &lt;key&gt; &lt;owner|-&gt; &lt;opKey&gt;            the lookups (async)
 * batchbykey &lt;owner|-&gt; &lt;opKey&gt;                             Sites.batchByKey (server thread)
 * canceljob &lt;key&gt; &lt;jobId&gt;                                   Bibles.cancelJob
 * pin|unpin &lt;key&gt; &lt;entry&gt; &lt;version&gt; &lt;owner&gt;; pinowners &lt;entry&gt; &lt;version&gt;
 * estmix &lt;key&gt; &lt;base64 {originals, adapted, copies, newBible, massingFirst, reportCritique, model?}&gt;
 * fitmassing &lt;massingId&gt; &lt;version&gt; &lt;x1,y1,z1,x2,y2,z2&gt; &lt;side&gt;   Sites.fitMassingToLot
 * group0a &lt;groupId&gt;                                          seq, lastAction, opKey, breakdown, costByKind
 * api110                                                     the version and the appended constants
 * </pre>
 */
final class ApiTest0a {
	private ApiTest0a() {
	}

	private static JsonObject b64(String s) {
		return com.google.gson.JsonParser.parseString(new String(Base64.getDecoder().decode(s), StandardCharsets.UTF_8)).getAsJsonObject();
	}

	private static String owner(String s) {
		return s.equals("-") ? null : s;
	}

	static JsonObject breakdown(Group.Breakdown b) {
		JsonObject o = new JsonObject();
		JsonObject st = new JsonObject();
		b.stages().forEach((k, l) -> {
			JsonObject x = new JsonObject();
			x.addProperty("usd", l.usd());
			x.addProperty("ms", l.ms());
			x.addProperty("count", l.count());
			st.add(k.name(), x);
		});
		o.add("stages", st);
		o.addProperty("totalUsd", b.totalUsd());
		o.addProperty("wallMs", b.wallMs());
		o.addProperty("firstDetailedMs", b.firstDetailedMs());
		JsonArray ids = new JsonArray();
		b.bibleJobIds().forEach(ids::add);
		o.add("bibleJobIds", ids);
		return o;
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		switch (a[0]) {
			case "opbible": {
				JsonObject o = b64(a[3]);
				BibleRequest r = new BibleRequest(o.get("prompt").getAsString(), o.has("name") ? o.get("name").getAsString() : null, o.has("owner") ? o.get(
					"owner").getAsString() : ApiTest.OWNER, null, null, null, List.of(), null, null).withOpKey(a[2]);
				return ApiTest.later("opbible:" + a[1], api.bibles().request(r).thenApply(ApiTestSets::bibleJob));
			}
			case "opgroup":
				return ApiTest.later("opgroup:" + a[1], api.designs().requestGroup(ApiTestSets.groupRequest(b64(a[3])).withOpKey(a[2])).thenApply(
					JsonPrimitive::new));
			case "jobbykey":
				return ApiTest.later("jobbykey:" + a[1], api.bibles().jobByKey(owner(a[2]), a[3]).thenApply(j -> j.<JsonElement>map(ApiTestSets::bibleJob)
					.orElse(new JsonPrimitive("empty"))));
			case "groupbykey":
				return ApiTest.later("groupbykey:" + a[1], api.designs().groupByKey(owner(a[2]), a[3]).thenApply(g -> g.<JsonElement>map(ApiTestSets::group)
					.orElse(new JsonPrimitive("empty"))));
			case "batchbykey":
				return api.sites(src.getServer()).batchByKey(owner(a[1]), a[2]).<JsonElement>map(ApiTestBatch::batch).orElse(JsonNull.INSTANCE);
			case "canceljob":
				return ApiTest.later("canceljob:" + a[1], api.bibles().cancelJob(a[2]).thenApply(ApiTestSets::bibleJob));
			case "pin":
				return ApiTest.later("pin:" + a[1], api.library().pinVersion(a[2], Integer.parseInt(a[3]), a[4]).thenApply(v -> new JsonPrimitive(true)));
			case "unpin":
				return ApiTest.later("unpin:" + a[1], api.library().unpinVersion(a[2], Integer.parseInt(a[3]), a[4]).thenApply(v -> new JsonPrimitive(true)));
			case "pinowners": {
				JsonArray arr = new JsonArray();
				api.library().pinOwners(a[1], Integer.parseInt(a[2])).forEach(arr::add);
				return arr;
			}
			case "estmix": {
				JsonObject o = b64(a[2]);
				EstimateRequest r = new EstimateRequest(null, i(o, "originals"), i(o, "adapted"), i(o, "copies"), b(o, "newBible"), b(o, "massingFirst"), b(o,
					"reportCritique"), o.has("model") ? o.get("model").getAsString() : null);
				return ApiTest.later("estmix:" + a[1], api.designs().estimate(r).thenApply(e -> {
					JsonObject x = ApiTestSets.estimate(e);
					JsonObject k = new JsonObject();
					e.byKind().forEach((kind, it) -> {
						JsonObject l = new JsonObject();
						l.addProperty("usdLow", it.usdLow());
						l.addProperty("usdHigh", it.usdHigh());
						l.addProperty("minutesLow", it.minutesLow());
						l.addProperty("minutesHigh", it.minutesHigh());
						k.add(kind.name(), l);
					});
					x.add("byKind", k);
					return x;
				}));
			}
			case "fitmassing": {
				String[] c = a[3].split(",");
				BoundingBox lot = new BoundingBox(Integer.parseInt(c[0]), Integer.parseInt(c[1]), Integer.parseInt(c[2]), Integer.parseInt(c[3]),
					Integer.parseInt(c[4]), Integer.parseInt(c[5]));
				return ApiTestBatch.fit(api.sites(src.getServer()).fitMassingToLot(new MassingRef(a[1], Integer.parseInt(a[2])), lot, Direction.byName(a[4]),
					FitOptions.DEFAULT.withLevel(src.getLevel())));
			}
			case "volume": {
				// volume <key> x0 y0 z0 x1 y1 z1: Survey.volume (LOADED_ONLY)
				BoundingBox b = new BoundingBox(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer.parseInt(a[4]), Integer.parseInt(a[5]),
					Integer.parseInt(a[6]), Integer.parseInt(a[7]));
				return ApiTest.later("volume:" + a[1], api.survey().volume(src.getLevel(), b, dev.larattalabs.architect.api.LoadPolicy.LOADED_ONLY).thenApply(v -> {
					JsonObject o = new JsonObject();
					o.addProperty("done", true);
					return o;
				}));
			}
			case "group0a":
				return api.designs().group(a[1]).<JsonElement>map(ApiTestSets::group).orElse(JsonNull.INSTANCE);
			case "api110": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				o.addProperty("lastReasons", List.of(Reason.values()).subList(Reason.values().length - 3, Reason.values().length).toString());
				return o;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	private static int i(JsonObject o, String k) {
		return o.has(k) ? o.get(k).getAsInt() : 0;
	}

	private static boolean b(JsonObject o, String k) {
		return o.has(k) && o.get(k).getAsBoolean();
	}
}
