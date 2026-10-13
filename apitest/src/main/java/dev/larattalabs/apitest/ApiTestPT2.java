package dev.larattalabs.apitest;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.AdoptResult;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BuildConsent;
import dev.larattalabs.architect.api.BuildState;
import dev.larattalabs.architect.api.Reason;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import net.minecraft.commands.CommandSourceStack;

/**
 * The slice 6c PT2 steps of apitest (docs/CONTRACT.md "Phase 6c slice PT2", gate item 13): adopting a build through
 * {@code dev.larattalabs.architect.api} only.
 * <pre>
 * apipt2                                  the surface: version, the adopt feature, ADOPT_REFUSED and ADOPTED appended
 * adopt &lt;key&gt; &lt;build&gt; &lt;owner|-&gt; &lt;b64 consent|-&gt; [b64 ext]   Sites.adopt -> pending "adopt:&lt;key&gt;" (consent: {builds: [...], actor: uuid|player})
 * adoptedsite &lt;build&gt;                    Sites.adoptedSite
 * </pre>
 */
public final class ApiTestPT2 {
	private ApiTestPT2() {
	}

	static JsonObject json(String b64) {
		return JsonParser.parseString(new String(Base64.getDecoder().decode(b64), StandardCharsets.UTF_8)).getAsJsonObject();
	}

	static JsonObject result(AdoptResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("siteId", r.siteId());
		o.addProperty("entryId", r.entryId());
		o.addProperty("version", r.version());
		o.addProperty("buildId", r.buildId());
		o.addProperty("box", r.box().toString());
		o.addProperty("cells", r.cells());
		o.addProperty("airCells", r.airCells());
		o.addProperty("blockEntities", r.blockEntities());
		o.addProperty("skipped", r.skipped());
		o.addProperty("front", r.front().getSerializedName());
		o.addProperty("frameGuessed", r.frameGuessed());
		return o;
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		try {
			switch (a[0]) {
				case "apipt2": {
					JsonObject o = new JsonObject();
					o.addProperty("version", ArchitectApi.VERSION);
					o.addProperty("adopt", api.features().contains("adopt"));
					o.addProperty("adoptRefusedLast", Reason.values()[Reason.values().length - 1] == Reason.ADOPT_REFUSED);
					o.addProperty("adoptedLast", BuildState.values()[BuildState.values().length - 1] == BuildState.ADOPTED);
					return o;
				}
				case "adopt": {
					BuildConsent consent = null;
					if (!a[4].equals("-")) {
						JsonObject c = json(a[4]);
						Set<String> ids = new HashSet<>();
						c.getAsJsonArray("builds").forEach(e -> ids.add(e.getAsString()));
						UUID actor = null;
						if (c.has("actor")) {
							String s = c.get("actor").getAsString();
							actor = s.equals("player") ? src.getPlayer().getUUID() : UUID.fromString(s);
						}
						consent = new BuildConsent(ids, actor);
					}
					JsonObject ext = a.length > 5 ? json(a[5]) : new JsonObject();
					return ApiTest.later("adopt:" + a[1], api.sites(src.getServer()).adopt(a[2], a[3].equals("-") ? null : a[3], consent, ext).handle((r, e) -> {
						if (e == null) {
							return result(r);
						}
						Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
						JsonObject o = new JsonObject();
						if (c instanceof ArchitectRefused ar) {
							o.addProperty("refused", ar.reason().name());
							o.addProperty("detail", ar.detail());
							o.addProperty("message", ar.getMessage());
						} else {
							o.addProperty("error", String.valueOf(c));
						}
						return o;
					}));
				}
				case "adoptedsite": {
					return new JsonPrimitive(api.sites(src.getServer()).adoptedSite(a[1]).orElse("none"));
				}
				default:
					return new JsonPrimitive("unknown step " + a[0]);
			}
		} catch (ArchitectRefused e) {
			JsonObject o = new JsonObject();
			o.addProperty("refused", e.reason().name());
			o.addProperty("detail", e.detail());
			o.addProperty("message", e.getMessage());
			return o;
		}
	}
}
