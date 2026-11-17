package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.7) A persisted retirement await: {@code {store, gen}}, met only by the same store file (its persisted id)
 * at that generation or later, confirmed on disk (a generation loaded at start counts only after the load's re-force, §3.1). Only
 * generations a completed barrier or an OK write returned are ever recorded (never "the next generation").
 */
public record Await(String store, long gen) {
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("store", store);
		o.addProperty("gen", gen);
		return o;
	}

	public static Await fromJson(JsonObject o) {
		if (!o.has("store") || !o.has("gen") || o.get("gen").getAsLong() < 0) {
			throw new IllegalArgumentException("an await needs store and a generation >= 0");
		}
		return new Await(o.get("store").getAsString(), o.get("gen").getAsLong());
	}
}
