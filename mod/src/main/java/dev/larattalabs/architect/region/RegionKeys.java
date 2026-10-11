package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.batch.BatchKeys;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (6c slice X, C20) The body hashes of a {@link RegionPlanRequest} and a {@link RealiseRequest} that carry an opKey: the sha256 of the
 * request's canonical JSON (sorted keys, {@link BatchKeys}), without the key. The persisted form: a level is its dimension id, an
 * actor its UUID, a map or list recurses. A plan's claim is its x/z columns only (the plan ignores the y range). Pure.
 */
public final class RegionKeys {
	private RegionKeys() {
	}

	/** The scope of a key in the registry: (owner, kind, key); a null owner is the player. */
	public static String scope(@Nullable String owner, String kind, String key) {
		return (owner == null ? "" : owner) + "\u0000" + kind + "\u0000" + key;
	}

	public static JsonObject planBody(RegionPlanRequest r) {
		JsonObject o = BatchKeys.json(r, true).getAsJsonObject();
		o.add("claim", columns(r.claim()));
		return o;
	}

	public static JsonObject realiseBody(RealiseRequest r) {
		return BatchKeys.json(r, true).getAsJsonObject();
	}

	public static String hash(JsonObject body) {
		return BatchKeys.sha256(BatchKeys.canonical(body));
	}

	private static JsonArray columns(BoundingBox c) {
		JsonArray a = new JsonArray();
		a.add(c.minX());
		a.add(c.minZ());
		a.add(c.maxX());
		a.add(c.maxZ());
		return a;
	}
}
