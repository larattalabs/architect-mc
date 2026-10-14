package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;

/**
 * (C38) The live capability catalogue that {@code Regions.planCatalogue()} returns, read synchronously from the mod jar. The kit's own
 * {@code planCatalogue()} (kit/lib/plan/catalogue.mjs, what the helper stamps on every plan check) is a pure function of
 * {@code kit/schemas/plan.json}'s {@code x-catalogue}, the kit version and the API version. The build bundles that schema file as
 * {@code /architect_mc/schemas/plan.json} (the file the helper's kit carries), so this class derives the same object with no
 * helper round trip: no sidecar, no chunks, no claim. {@code PlanCatalogueTest} holds it equal to the kit's output entry for entry.
 * Parsed once; each call returns a deep copy.
 */
public final class PlanCatalogue {
	/** The entry members the kit copies after {@code id, sinceApi, schemaVersion, state}, in its order (kit/lib/plan/catalogue.mjs). */
	static final String[] OPTIONAL = {"until", "retiredInApi", "replacedBy", "aliasOf", "limits", "note"};

	private static volatile JsonObject cached;

	private PlanCatalogue() {
	}

	/** A fresh copy of the catalogue: {@code catalogueVersion, api, kitVersion, schemaVersion, entries}. Any thread; no side effects. */
	public static JsonObject get() {
		JsonObject c = cached;
		if (c == null) {
			c = build(schema(), ArchitectApi.VERSION, IrStale.KIT_VERSION);
			cached = c;
		}
		return c.deepCopy();
	}

	/** The catalogue of {@code planSchema} as the kit's {@code planCatalogue({api, kitVersion})} makes it. Pure. */
	static JsonObject build(JsonObject planSchema, String api, String kitVersion) {
		JsonObject x = planSchema.getAsJsonObject("x-catalogue");
		JsonObject out = new JsonObject();
		out.add("catalogueVersion", x.get("catalogueVersion"));
		out.addProperty("api", api);
		out.addProperty("kitVersion", kitVersion);
		out.add("schemaVersion", planSchema.getAsJsonObject("properties").getAsJsonObject("schemaVersion").get("const"));
		JsonArray entries = new JsonArray();
		for (JsonElement el : x.getAsJsonArray("entries")) {
			JsonObject e = el.getAsJsonObject();
			JsonObject o = new JsonObject();
			for (String k : new String[] {"id", "sinceApi", "schemaVersion", "state"}) {
				o.add(k, e.get(k));
			}
			for (String k : OPTIONAL) {
				if (e.has(k)) {
					o.add(k, e.get(k));
				}
			}
			entries.add(o);
		}
		out.add("entries", entries);
		return out;
	}

	private static JsonObject schema() {
		String res = "/architect_mc/schemas/plan.json";
		try (InputStream in = PlanCatalogue.class.getResourceAsStream(res)) {
			if (in == null) {
				throw new IllegalStateException("the mod jar has no " + res);
			}
			return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException e) {
			throw new UncheckedIOException(e);
		}
	}
}
