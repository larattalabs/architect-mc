package dev.larattalabs.architect.txn;

import java.util.LinkedHashMap;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/** (slice T5F, contract §4) The txn receipt's string form, pure (no chunk, no attachment: unit-testable). */
public final class Receipts {
	private Receipts() {
	}

	/**
	 * One receipt's fields when it is effect {@code key}'s: {@code tx-<n>/<i>;op=..;t=..[;l=..]..} answers its {@code name=value} pairs, an
	 * old exact-match receipt ({@code tx-<n>/<i>}) an empty map, another effect's receipt (e.g. {@code tx-5/20} for {@code tx-5/2}) null.
	 */
	public static @Nullable Map<String, String> fields(String receipt, String key) {
		if (receipt.equals(key)) {
			return Map.of();
		}
		if (!receipt.startsWith(key + ";")) {
			return null;
		}
		Map<String, String> out = new LinkedHashMap<>();
		for (String part : receipt.substring(key.length() + 1).split(";")) {
			int eq = part.indexOf('=');
			if (eq > 0) {
				out.put(part.substring(0, eq), part.substring(eq + 1));
			}
		}
		return out;
	}

	/** A receipt for effect {@code key} with its fields, in order ({@code key;a=1;b=2}); no fields: the key alone. */
	public static String of(String key, Map<String, ?> fields) {
		StringBuilder sb = new StringBuilder(key);
		fields.forEach((k, v) -> sb.append(';').append(k).append('=').append(v));
		return sb.toString();
	}
}
