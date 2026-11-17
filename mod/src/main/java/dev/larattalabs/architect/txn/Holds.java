package dev.larattalabs.architect.txn;

import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds", R-8) Every open (or retiring, or quarantined) txn's resources, as a guard every writer
 * honours. A resource is a string ({@code site:<id>}, {@code pile:<owner>}, {@code box:<dim>@x,y,z}, {@code crate:<dim>@x,y,z},
 * {@code player:<uuid>}). Rebuilt from {@code txn.json} at load, before any recovery or legacy resolver runs. {@link #isEmpty} is the O(1)
 * fast path every writer takes when no txn is open.
 */
public final class Holds {
	private final Map<String, TxnEntry> byResource = new HashMap<>();

	public boolean isEmpty() {
		return byResource.isEmpty();
	}

	void hold(TxnEntry t) {
		for (String r : t.resources) {
			byResource.put(r, t);
		}
	}

	void release(TxnEntry t) {
		for (String r : t.resources) {
			byResource.remove(r, t);
		}
	}

	void clear() {
		byResource.clear();
	}

	/** The txn holding {@code resource}, or null. */
	public @Nullable TxnEntry holder(String resource) {
		return byResource.isEmpty() ? null : byResource.get(resource);
	}

	/**
	 * (§3.12.10) Why a begin over {@code resources} is refused: {@code held(other) tx-<n>: <resource>} for the first resource another txn
	 * holds, or null when none is held.
	 */
	public @Nullable String refusal(Collection<String> resources) {
		if (byResource.isEmpty()) {
			return null;
		}
		for (String r : resources) {
			TxnEntry t = byResource.get(r);
			if (t != null) {
				return other(t, r);
			}
		}
		return null;
	}

	/** {@code held(other) tx-<n>: <where>}: another txn holds it; nothing changed, try later. */
	public static String other(TxnEntry t, String resource) {
		return "held(other) " + t.id + ": " + (t.heldAt != null ? t.heldAt : resource);
	}

	/** {@code held(decided) tx-<n>: <where>}: the caller's own decided txn is held; it finishes later ("under way"). */
	public static String decided(TxnEntry t) {
		return "held(decided) " + t.id + ": " + (t.heldAt != null ? t.heldAt : String.join(", ", t.resources));
	}

	public List<String> resources() {
		return List.copyOf(byResource.keySet());
	}
}
