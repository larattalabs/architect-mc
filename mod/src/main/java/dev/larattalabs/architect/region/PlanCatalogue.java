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
import org.jspecify.annotations.Nullable;

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
	private static volatile JsonObject cachedSchema;

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

	/**
	 * (7cF) {@code Regions.planCatalogue(Set)}: the long text for the named kinds, as the kit's {@code planCatalogueKinds(kinds)} makes it
	 * (kit/lib/plan/catalogue.mjs; {@code PlanCatalogueTest} holds the two equal): the envelope of {@link #get()}, {@code entries} only the
	 * named kinds in catalogue order, each the full entry plus {@code def} (its plan/0 def or draft, descriptions included; absent when
	 * none), and {@code unknown} (the named ids the catalogue lacks, sorted). Any thread; a fresh copy each call. Null is no kinds.
	 */
	public static JsonObject kinds(java.util.@Nullable Set<String> kinds) {
		return kinds(schema(), get(), kinds == null ? java.util.Set.of() : kinds);
	}

	/** {@link #kinds(java.util.Set)} over a given schema and its catalogue. Pure. */
	static JsonObject kinds(JsonObject planSchema, JsonObject catalogue, java.util.Set<String> kinds) {
		java.util.Map<String, JsonObject> src = new java.util.HashMap<>();
		for (JsonElement el : planSchema.getAsJsonObject("x-catalogue").getAsJsonArray("entries")) {
			src.put(el.getAsJsonObject().get("id").getAsString(), el.getAsJsonObject());
		}
		JsonObject defs = planSchema.getAsJsonObject("$defs");
		JsonObject out = new JsonObject();
		for (String k : new String[] {"catalogueVersion", "api", "kitVersion", "schemaVersion"}) {
			out.add(k, catalogue.get(k));
		}
		JsonArray entries = new JsonArray();
		for (JsonElement el : catalogue.getAsJsonArray("entries")) {
			JsonObject e = el.getAsJsonObject();
			String id = e.get("id").getAsString();
			if (!kinds.contains(id)) {
				continue;
			}
			JsonObject o = e.deepCopy();
			JsonObject raw = src.get(id);
			JsonElement ref = raw.has("def") ? raw.get("def") : raw.get("draft");
			if (ref != null && ref.isJsonPrimitive() && ref.getAsString().startsWith("#/$defs/")) {
				JsonElement d = defs.get(ref.getAsString().substring("#/$defs/".length()));
				if (d != null) {
					o.add("def", d.deepCopy());
				}
			}
			entries.add(o);
		}
		out.add("entries", entries);
		JsonArray unknown = new JsonArray();
		new java.util.TreeSet<>(kinds).stream().filter(k -> !src.containsKey(k)).forEach(unknown::add);
		out.add("unknown", unknown);
		return out;
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
		JsonObject s = cachedSchema;
		if (s == null) {
			s = readSchema();
			cachedSchema = s;
		}
		return s;
	}

	private static JsonObject readSchema() {
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
