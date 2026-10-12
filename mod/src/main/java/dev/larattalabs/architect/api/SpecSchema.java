package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The toolbox specs' JSON Schema check (6c slice MP): the same subset, read the same way, as the kit's
 * {@code kit/lib/specschema.mjs}, over the same schema files ({@code kit/schemas/mask.json}, {@code pattern.json}, bundled as
 * {@code /architect_mc/schemas/}). A drift test holds the two equal on generated specs. Package-private: {@link Mask#parse} and
 * {@link Pattern#parse} use it.
 */
final class SpecSchema {
	private static final Map<String, JsonObject> SCHEMAS = new ConcurrentHashMap<>();
	private static final Map<String, java.util.regex.Pattern> REGEX = new ConcurrentHashMap<>();

	private SpecSchema() {
	}

	/** The bundled schema {@code name} ({@code mask} or {@code pattern}). */
	static JsonObject schema(String name) {
		return SCHEMAS.computeIfAbsent(name, n -> {
			String res = "/architect_mc/schemas/" + n + ".json";
			try (InputStream in = SpecSchema.class.getResourceAsStream(res)) {
				if (in == null) {
					throw new IllegalStateException("the mod jar has no " + res);
				}
				return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
			} catch (IOException e) {
				throw new UncheckedIOException(e);
			}
		});
	}

	/** Every error ("path: message") of {@code v} against {@code schema} (whose {@code $defs} are in {@code root}). */
	static List<String> validate(JsonObject schema, JsonElement v, String where, JsonObject root) {
		if (schema.has("$ref")) {
			String name = schema.get("$ref").getAsString().replace("#/$defs/", "");
			JsonObject d = root.has("$defs") ? root.getAsJsonObject("$defs").getAsJsonObject(name) : null;
			if (d == null) {
				throw new IllegalStateException("schema: no $defs/" + name);
			}
			return validate(d, v, where, root);
		}
		String t = typeOf(v);
		if (schema.has("type")) {
			List<String> types = new ArrayList<>();
			if (schema.get("type").isJsonArray()) {
				schema.getAsJsonArray("type").forEach(e -> types.add(e.getAsString()));
			} else {
				types.add(schema.get("type").getAsString());
			}
			if (types.stream().noneMatch(x -> x.equals(t) || x.equals("number") && t.equals("integer"))) {
				return List.of(where + ": expected " + String.join(" or ", types) + ", got " + t);
			}
		}
		List<String> errs = new ArrayList<>();
		if (schema.has("const") && !same(schema.get("const"), v)) {
			errs.add(where + ": must be " + schema.get("const"));
		}
		if (schema.has("enum")) {
			boolean any = false;
			for (JsonElement e : schema.getAsJsonArray("enum")) {
				any |= same(e, v);
			}
			if (!any) {
				errs.add(where + ": must be one of " + schema.get("enum"));
			}
		}
		if (t.equals("string") && schema.has("pattern")) {
			String p = schema.get("pattern").getAsString();
			if (!REGEX.computeIfAbsent(p, java.util.regex.Pattern::compile).matcher(v.getAsString()).find()) {
				errs.add(where + ": does not match " + p);
			}
		}
		if (t.equals("integer") || t.equals("number")) {
			BigDecimal n = v.getAsBigDecimal();
			if (schema.has("minimum") && n.compareTo(schema.get("minimum").getAsBigDecimal()) < 0) {
				errs.add(where + ": under " + schema.get("minimum"));
			}
			if (schema.has("maximum") && n.compareTo(schema.get("maximum").getAsBigDecimal()) > 0) {
				errs.add(where + ": over " + schema.get("maximum"));
			}
			if (schema.has("exclusiveMinimum") && n.compareTo(schema.get("exclusiveMinimum").getAsBigDecimal()) <= 0) {
				errs.add(where + ": must be over " + schema.get("exclusiveMinimum"));
			}
		}
		if (v instanceof JsonObject o) {
			if (schema.has("required")) {
				for (JsonElement k : schema.getAsJsonArray("required")) {
					if (!o.has(k.getAsString())) {
						errs.add(where + ": missing " + k.getAsString());
					}
				}
			}
			JsonObject props = schema.has("properties") ? schema.getAsJsonObject("properties") : null;
			boolean closed = schema.has("additionalProperties") && schema.get("additionalProperties").isJsonPrimitive() && !schema.get(
				"additionalProperties").getAsBoolean();
			Map<String, JsonElement> sorted = new TreeMap<>();
			o.entrySet().forEach(e -> sorted.put(e.getKey(), e.getValue()));
			for (Map.Entry<String, JsonElement> e : sorted.entrySet()) {
				if (props != null && props.has(e.getKey())) {
					errs.addAll(validate(props.getAsJsonObject(e.getKey()), e.getValue(), where + "." + e.getKey(), root));
				} else if (closed) {
					errs.add(where + ": unexpected " + e.getKey());
				}
			}
		}
		if (v instanceof JsonArray a) {
			if (schema.has("minItems") && a.size() < schema.get("minItems").getAsInt()) {
				errs.add(where + ": fewer than " + schema.get("minItems") + " items");
			}
			if (schema.has("maxItems") && a.size() > schema.get("maxItems").getAsInt()) {
				errs.add(where + ": more than " + schema.get("maxItems") + " items");
			}
			if (schema.has("items")) {
				for (int i = 0; i < a.size(); i++) {
					errs.addAll(validate(schema.getAsJsonObject("items"), a.get(i), where + "[" + i + "]", root));
				}
			}
		}
		if (schema.has("oneOf")) {
			int ok = 0;
			List<String> best = null;
			for (JsonElement s : schema.getAsJsonArray("oneOf")) {
				List<String> r = validate(s.getAsJsonObject(), v, where, root);
				if (r.isEmpty()) {
					ok++;
				} else if (best == null || depth(r) > depth(best) || depth(r) == depth(best) && r.size() < best.size()) {
					best = r;
				}
			}
			if (ok > 1) {
				errs.add(where + ": matches more than one form");
			} else if (ok == 0) {
				String msg = schema.has("oneOfMessage") ? schema.get("oneOfMessage").getAsString() : "matches none of the forms";
				errs.addAll(best != null && depth(best) > depth(List.of(where + ": x")) ? best : List.of(where + ": " + msg));
			}
		}
		if (schema.has("anyOf")) {
			boolean any = false;
			for (JsonElement s : schema.getAsJsonArray("anyOf")) {
				any |= validate(s.getAsJsonObject(), v, where, root).isEmpty();
			}
			if (!any) {
				errs.add(where + ": " + (schema.has("anyOfMessage") ? schema.get("anyOfMessage").getAsString() : "matches none of the alternatives"));
			}
		}
		return errs;
	}

	/** JSON Schema's type of a value: null, boolean, integer (a number without a fraction), number, string, array, object. */
	static String typeOf(JsonElement v) {
		if (v == null || v.isJsonNull()) {
			return "null";
		}
		if (v.isJsonArray()) {
			return "array";
		}
		if (v.isJsonObject()) {
			return "object";
		}
		JsonPrimitive p = v.getAsJsonPrimitive();
		if (p.isBoolean()) {
			return "boolean";
		}
		if (p.isString()) {
			return "string";
		}
		BigDecimal n = p.getAsBigDecimal();
		return n.signum() == 0 || n.stripTrailingZeros().scale() <= 0 ? "integer" : "number";
	}

	private static boolean same(JsonElement a, JsonElement b) {
		if (a.isJsonPrimitive() && b != null && b.isJsonPrimitive() && a.getAsJsonPrimitive().isNumber() && b.getAsJsonPrimitive().isNumber()) {
			return a.getAsBigDecimal().compareTo(b.getAsBigDecimal()) == 0;
		}
		return a.equals(b);
	}

	private static int depth(List<String> errs) {
		if (errs.isEmpty()) {
			return -1;
		}
		String e = errs.get(0);
		String p = e.substring(0, e.indexOf(": "));
		int n = 0;
		for (char c : p.toCharArray()) {
			if (c == '.' || c == '[') {
				n++;
			}
		}
		return n;
	}

	/** Parse {@code text} as a JSON object or refuse ({@link Reason#FIELD_LIMIT}) with {@code what}. */
	static JsonObject parseObject(String text, String what) {
		JsonElement e;
		try {
			e = JsonParser.parseString(text == null ? "" : text);
		} catch (RuntimeException ex) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, what + ": not JSON (" + ex.getMessage() + ")");
		}
		if (!(e instanceof JsonObject o)) {
			throw new ArchitectRefused(Reason.FIELD_LIMIT, what + ": a " + what + " is a JSON object");
		}
		return o;
	}
}
