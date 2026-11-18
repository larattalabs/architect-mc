package dev.larattalabs.architect.survival;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.jspecify.annotations.Nullable;

/**
 * A construction crate's ledger (docs/CONTRACT.md phase 3 "The crate", "Equivalents"): per item, how many were
 * <b>delivered</b> (counted in the item the site uses: a log delivered as 4 planks counts 4 planks) and how many the builder
 * <b>placed</b> (consumed). The stock is {@code delivered - placed}; what the stock holds beyond the site's remaining need is
 * <b>credit</b> (conversion leftovers). The crate's block entity saves it with its chunk, so items and ledger never drift
 * apart. Pure; not thread-safe (server thread).
 */
public final class Ledger {
	private final Map<String, Integer> delivered = new TreeMap<>();
	private final Map<String, Integer> placed = new TreeMap<>();
	/**
	 * (slice T2b, crate holds) True while an open txn holds this ledger's crate (for any writer but its own adapter): every mutation is
	 * refused (an insert books nothing, the feed consumes nothing, a take takes nothing). The crate's cell itself is frozen by the T2a holds.
	 */
	private java.util.function.BooleanSupplier frozen = () -> false;

	/** (slice T2b) The hold guard: its crate block entity's ({@code CrateBlockEntity}). */
	public void guard(java.util.function.BooleanSupplier f) {
		frozen = f;
	}

	/** (slice T2b) Whether an open txn holds this ledger now. */
	public boolean frozen() {
		return frozen.getAsBoolean();
	}

	/** What an insert of one unit did: {@code count} of {@code item} credited ({@code converted}: through an equivalent). */
	public record Accepted(String item, int count, boolean converted) {
	}

	public int delivered(String item) {
		return delivered.getOrDefault(item, 0);
	}

	public int placed(String item) {
		return placed.getOrDefault(item, 0);
	}

	public int stock(String item) {
		return delivered(item) - placed(item);
	}

	public Map<String, Integer> delivered() {
		return Map.copyOf(delivered);
	}

	public Map<String, Integer> placed() {
		return Map.copyOf(placed);
	}

	/** Every item with stock > 0 (stock includes credit). */
	public Map<String, Integer> stock() {
		Map<String, Integer> out = new LinkedHashMap<>();
		for (String k : delivered.keySet()) {
			int s = stock(k);
			if (s > 0) {
				out.put(k, s);
			}
		}
		return out;
	}

	/**
	 * What one unit of {@code item} would credit, or null when the site doesn't need it: itself when the site still misses it
	 * ({@code unbuilt.applyAsInt(item) > stock}), else the nearest equivalent the site misses. {@code unbuilt}: per item,
	 * what the cells not built yet cost. {@code commit}: book it.
	 */
	public @Nullable Accepted accept(String item, ToIntFunction<String> unbuilt, Equivalents eq, boolean commit) {
		Accepted a = null;
		if (missing(item, unbuilt) > 0) {
			a = new Accepted(item, 1, false);
		} else {
			for (Equivalents.Path p : eq.paths(item)) {
				if (missing(p.item(), unbuilt) > 0) {
					a = new Accepted(p.item(), p.count(), true);
					break;
				}
			}
		}
		if (a != null && commit && frozen()) {
			return null; // (T2b) held: nothing booked
		}
		if (a != null && commit) {
			delivered.merge(a.item(), a.count(), Integer::sum);
		}
		return a;
	}

	/** What the site still misses of {@code item}: the cost of its unbuilt cells beyond the stock. */
	public int missing(String item, ToIntFunction<String> unbuilt) {
		return Math.max(0, unbuilt.applyAsInt(item) - stock(item));
	}

	/** The builder used {@code n} of {@code item}. False (nothing booked) when the stock is short. */
	public boolean consume(String item, int n) {
		if (n <= 0) {
			return true;
		}
		if (stock(item) < n || frozen()) {
			return false; // (T2b) held: the feed waits
		}
		placed.merge(item, n, Integer::sum);
		return true;
	}

	/** Takes the whole stock out (finish, deconstruct): what is returned as items. The ledger then holds nothing in stock. */
	public Map<String, Integer> takeStock() {
		if (frozen()) {
			return new LinkedHashMap<>(); // (T2b) held: its stock stays in it (a finish, a deconstruct or a click takes nothing)
		}
		Map<String, Integer> s = stock();
		s.forEach((k, v) -> delivered.merge(k, -v, Integer::sum));
		return s;
	}

	/**
	 * (slice T2b, {@code crate.take}) Takes exactly {@code items} out of the stock (a txn's B effect, run as the holder): false, nothing
	 * changed, when the stock holds less. Not guarded: only the holder's adapter calls it.
	 */
	public boolean take(Map<String, Integer> items) {
		for (var e : items.entrySet()) {
			if (stock(e.getKey()) < e.getValue()) {
				return false;
			}
		}
		items.forEach((k, v) -> delivered.merge(k, -v, Integer::sum));
		return true;
	}

	/** (slice T2b, {@code crate.take}'s compensation) Puts {@code items} back into the stock. Not guarded: the holder's adapter only. */
	public void putBack(Map<String, Integer> items) {
		items.forEach((k, v) -> delivered.merge(k, v, Integer::sum));
	}

	/** Restores a saved ledger. */
	public void load(Map<String, Integer> delivered, Map<String, Integer> placed) {
		this.delivered.clear();
		this.placed.clear();
		delivered.forEach((k, v) -> {
			if (v != 0) {
				this.delivered.put(k, v);
			}
		});
		placed.forEach((k, v) -> {
			if (v != 0) {
				this.placed.put(k, v);
			}
		});
	}

	/** Credit: the stock beyond what the unbuilt cells still cost. */
	public Map<String, Integer> credit(ToIntFunction<String> unbuilt) {
		Map<String, Integer> out = new LinkedHashMap<>();
		stock().forEach((k, v) -> {
			int c = v - Math.max(0, unbuilt.applyAsInt(k));
			if (c > 0) {
				out.put(k, c);
			}
		});
		return out;
	}
}
