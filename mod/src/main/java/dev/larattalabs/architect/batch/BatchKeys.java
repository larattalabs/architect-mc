package dev.larattalabs.architect.batch;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.lang.reflect.RecordComponent;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Collection;
import java.util.HexFormat;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import org.jspecify.annotations.Nullable;

/**
 * (6c slice 0a, C9) The body hash of a {@link dev.larattalabs.architect.api.Batch} with an opKey: the sha256 of its canonical JSON
 * (sorted keys) in the persisted form, not the live objects: a level is its dimension id, an actor its UUID, a block position
 * {@code [x, y, z]}; records recurse, enums are their names, the key itself is left out. Pure.
 */
public final class BatchKeys {
	private BatchKeys() {
	}

	/** The body hash of a batch (any record), without its {@code opKey} component. */
	public static String hash(Record spec) {
		return sha256(canonical(json(spec, true)));
	}

	/** The persisted form of a value (see the class comment). {@code top}: leave out an {@code opKey} component. */
	public static JsonElement json(@Nullable Object v, boolean top) {
		if (v == null) {
			return JsonNull.INSTANCE;
		}
		if (v instanceof JsonElement j) {
			return j.deepCopy();
		}
		if (v instanceof String || v instanceof Boolean) {
			return v instanceof String s ? new JsonPrimitive(s) : new JsonPrimitive((Boolean) v);
		}
		if (v instanceof Number n) {
			return new JsonPrimitive(n);
		}
		if (v instanceof Enum<?> e) {
			return new JsonPrimitive(e.name());
		}
		if (v instanceof ServerLevel l) {
			return new JsonPrimitive(l.dimension().identifier().toString());
		}
		if (v instanceof Entity e) {
			return new JsonPrimitive(e.getStringUUID());
		}
		if (v instanceof BlockPos p) {
			JsonArray a = new JsonArray();
			a.add(p.getX());
			a.add(p.getY());
			a.add(p.getZ());
			return a;
		}
		if (v instanceof Collection<?> c) {
			JsonArray a = new JsonArray();
			c.forEach(x -> a.add(json(x, false)));
			return a;
		}
		if (v instanceof Map<?, ?> m) {
			JsonObject o = new JsonObject();
			m.forEach((k, x) -> o.add(String.valueOf(k), json(x, false)));
			return o;
		}
		if (v instanceof Record r) {
			JsonObject o = new JsonObject();
			for (RecordComponent c : r.getClass().getRecordComponents()) {
				if (top && c.getName().equals("opKey")) {
					continue;
				}
				try {
					o.add(c.getName(), json(c.getAccessor().invoke(r), false));
				} catch (ReflectiveOperationException e) {
					throw new IllegalStateException("cannot read " + c.getName(), e);
				}
			}
			return o;
		}
		return new JsonPrimitive(v.toString());
	}

	/** JSON with object keys sorted, recursively. */
	public static String canonical(JsonElement e) {
		if (e.isJsonObject()) {
			TreeMap<String, JsonElement> sorted = new TreeMap<>();
			e.getAsJsonObject().entrySet().forEach(en -> sorted.put(en.getKey(), en.getValue()));
			StringBuilder b = new StringBuilder("{");
			sorted.forEach((k, v) -> {
				if (b.length() > 1) {
					b.append(',');
				}
				b.append(new JsonPrimitive(k)).append(':').append(canonical(v));
			});
			return b.append('}').toString();
		}
		if (e.isJsonArray()) {
			StringBuilder b = new StringBuilder("[");
			for (JsonElement x : e.getAsJsonArray()) {
				if (b.length() > 1) {
					b.append(',');
				}
				b.append(canonical(x));
			}
			return b.append(']').toString();
		}
		return e.toString();
	}

	static String sha256(String s) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
