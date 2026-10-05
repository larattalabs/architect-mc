package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;

/** What a design or job cost so far (the SDK's estimate, not a billing statement; notional under claude login). */
public record Cost(double usd, long inputTokens, long outputTokens, long cacheReadTokens, long cacheWriteTokens, int turns) {
	public static final Cost NONE = new Cost(0, 0, 0, 0, 0, 0);

	/** Reads {@code {usd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, turns}}; missing keys are 0. */
	public static Cost fromJson(JsonObject o) {
		if (o == null) {
			return NONE;
		}
		return new Cost(d(o, "usd"), (long) d(o, "inputTokens"), (long) d(o, "outputTokens"), (long) d(o, "cacheReadTokens"),
			(long) d(o, "cacheWriteTokens"), (int) d(o, "turns"));
	}

	private static double d(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() && o.get(k).getAsJsonPrimitive().isNumber() ? o.get(k).getAsDouble() : 0;
	}
}
