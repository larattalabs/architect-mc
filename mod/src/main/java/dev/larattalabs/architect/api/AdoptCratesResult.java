package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * What {@link Sites#adoptCratesResult} did (docs/CONTRACT.md "Slice T3b as built"): the stockpile after it; the crate keys that joined
 * (a site id, or {@code group:<id>} for a shared crate); those deferred, each with its stable reason ({@code unreadable}, {@code retagged},
 * {@code not a crate}: its cell could not be read, {@code chunks unloaded}: its paid records would read more unloaded chunks than the bound,
 * {@code held for ops}: a legacy credited crate that still stands), left as they are for a later call; and the adoption's txn id, null
 * when there was nothing to adopt. Empty {@code joined} and {@code deferred} means nothing to adopt. Overflow enters the stock past
 * capacity: nothing is owed or dropped. (Named apart from the PT2 {@link AdoptResult}, an adopted build.) Since 1.72.0.
 */
public record AdoptCratesResult(Stockpile stockpile, List<String> joined, Map<String, String> deferred, @Nullable String txnId) {
	public AdoptCratesResult {
		joined = List.copyOf(joined);
		deferred = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(deferred));
	}
}
