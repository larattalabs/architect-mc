package dev.larattalabs.architect.survival;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import org.jspecify.annotations.Nullable;

/**
 * A settlement stockpile's ledger (docs/CONTRACT.md phase 6c slice Y, C24 §4): per item, what was <b>delivered</b> (inserted at a
 * crate, counted in the item a target uses), <b>returned</b> (refunds and container returns that entered the stock),
 * <b>consumed</b> (placed by the builder), <b>withdrawn</b> (taken out as credit, or handed to a player by a dissolve) and
 * <b>dropped</b> (taken out of stock and dropped as items: a forced crate removal's excess, a dissolve at a crate, an adopted
 * crate's overflow). At every moment, per item: {@code stock = delivered + returned - consumed - withdrawn - dropped >= 0}.
 * <b>refundOverflow</b> counts refunds that never entered the stock (no room): it is outside the identity.
 *
 * <p>Capacity is counted in stacks: {@code usedStacks} is the sum over items of {@code ceil(stock / maxStackSize)}; a unit enters
 * only while it fits (a partly filled stack takes more of its item; a new stack needs a free one). Stock above capacity (a crate
 * went) stays, but nothing new enters until it fits again.
 *
 * <p>Refunds are credited <b>once</b> per key (§4 "Exactly once"): the keys are kept with the ledger and saved with it. Pure; not
 * thread-safe (server thread).
 */
public final class StockLedger {
	/** The stacks one crate holds (a chest's; N-Y-1). */
	public static final int STACKS_PER_CRATE = 27;
	/** The empty container a filled bucket's cost gives back when consumed (N-H-1). */
	public static final String BUCKET = "minecraft:bucket";

	private final Map<String, Integer> delivered = new TreeMap<>();
	private final Map<String, Integer> returned = new TreeMap<>();
	private final Map<String, Integer> consumed = new TreeMap<>();
	private final Map<String, Integer> withdrawn = new TreeMap<>();
	private final Map<String, Integer> dropped = new TreeMap<>();
	private final Map<String, Integer> refundOverflow = new TreeMap<>();
	private final Set<String> credited = new LinkedHashSet<>();

	/** What crediting items did: what entered the stock and what did not fit (to drop as items, booked as refundOverflow). */
	public record Credit(Map<String, Integer> returned, Map<String, Integer> overflow, boolean already) {
		public static final Credit NONE = new Credit(Map.of(), Map.of(), false);

		public boolean isEmpty() {
			return returned.isEmpty() && overflow.isEmpty();
		}
	}

	private static int get(Map<String, Integer> m, String k) {
		return m.getOrDefault(k, 0);
	}

	private static void add(Map<String, Integer> m, String k, int n) {
		if (n == 0) {
			return;
		}
		int v = m.getOrDefault(k, 0) + n;
		if (v == 0) {
			m.remove(k);
		} else {
			m.put(k, v);
		}
	}

	// ------------------------------------------------------------------ reads

	public int stock(String item) {
		return get(delivered, item) + get(returned, item) - get(consumed, item) - get(withdrawn, item) - get(dropped, item);
	}

	/** Every item with stock > 0. */
	public Map<String, Integer> stock() {
		Set<String> keys = new java.util.TreeSet<>(delivered.keySet());
		keys.addAll(returned.keySet());
		Map<String, Integer> out = new LinkedHashMap<>();
		for (String k : keys) {
			int s = stock(k);
			if (s > 0) {
				out.put(k, s);
			}
		}
		return out;
	}

	public Map<String, Integer> delivered() {
		return Map.copyOf(delivered);
	}

	public Map<String, Integer> returned() {
		return Map.copyOf(returned);
	}

	public Map<String, Integer> consumed() {
		return Map.copyOf(consumed);
	}

	public Map<String, Integer> withdrawn() {
		return Map.copyOf(withdrawn);
	}

	public Map<String, Integer> dropped() {
		return Map.copyOf(dropped);
	}

	public Map<String, Integer> refundOverflow() {
		return Map.copyOf(refundOverflow);
	}

	public Set<String> creditedKeys() {
		return Set.copyOf(credited);
	}

	public boolean credited(String key) {
		return credited.contains(key);
	}

	/** Every item the identity names: no stock below 0. */
	public boolean identityHolds() {
		Set<String> keys = new java.util.TreeSet<>(delivered.keySet());
		keys.addAll(returned.keySet());
		keys.addAll(consumed.keySet());
		keys.addAll(withdrawn.keySet());
		keys.addAll(dropped.keySet());
		for (String k : keys) {
			if (stock(k) < 0) {
				return false;
			}
		}
		return true;
	}

	/** Sum over items of ceil(stock / max stack size). */
	public int usedStacks(ToIntFunction<String> maxStack) {
		int n = 0;
		for (var e : stock().entrySet()) {
			n += stacks(e.getValue(), maxStack.applyAsInt(e.getKey()));
		}
		return n;
	}

	static int stacks(int count, int max) {
		int m = Math.max(1, max);
		return count <= 0 ? 0 : (count + m - 1) / m;
	}

	/**
	 * How many more units of {@code item} fit in {@code capacityStacks}: what fills its partly filled stack, plus whole free stacks.
	 * 0 while the stock is over capacity (nothing new enters until it fits).
	 */
	public int room(String item, int capacityStacks, ToIntFunction<String> maxStack) {
		int used = usedStacks(maxStack);
		if (used > capacityStacks) {
			return 0;
		}
		int max = Math.max(1, maxStack.applyAsInt(item));
		int s = stock(item);
		int partial = s <= 0 ? 0 : (max - s % max) % max;
		long free = (long) (capacityStacks - used) * max;
		return (int) Math.min(Integer.MAX_VALUE, partial + free);
	}

	// ------------------------------------------------------------------ writes

	/**
	 * The insert rule (§2 "Inserting"): what one unit of {@code item} would credit, or null. It goes in as itself while the
	 * owner's building targets, pooled, still miss it ({@code unbuilt.applyAsInt(item) > stock}), else as the nearest equivalent
	 * they miss; and only when that count fits. {@code commit}: book it in {@code delivered}.
	 */
	public Ledger.@Nullable Accepted accept(String item, ToIntFunction<String> unbuilt, Equivalents eq, int capacityStacks, ToIntFunction<String> maxStack,
		boolean commit) {
		Ledger.Accepted a = null;
		if (missing(item, unbuilt) > 0 && room(item, capacityStacks, maxStack) >= 1) {
			a = new Ledger.Accepted(item, 1, false);
		} else {
			for (Equivalents.Path p : eq.paths(item)) {
				if (missing(p.item(), unbuilt) > 0 && room(p.item(), capacityStacks, maxStack) >= p.count()) {
					a = new Ledger.Accepted(p.item(), p.count(), true);
					break;
				}
			}
		}
		if (a != null && commit) {
			add(delivered, a.item(), a.count());
		}
		return a;
	}

	/** What the targets still miss of {@code item}: their unbuilt cost beyond the stock. */
	public int missing(String item, ToIntFunction<String> unbuilt) {
		return Math.max(0, unbuilt.applyAsInt(item) - stock(item));
	}

	/**
	 * The builder used {@code n} of {@code item}. False (nothing booked) when the stock is short. A filled bucket's cost gives its
	 * empty bucket back (N-H-1): it is credited unkeyed through {@link #giveBack}; what does not fit is in {@code overflowOut}.
	 */
	public boolean consume(String item, int n, int capacityStacks, ToIntFunction<String> maxStack, Map<String, Integer> overflowOut) {
		if (n <= 0) {
			return true;
		}
		if (stock(item) < n) {
			return false;
		}
		add(consumed, item, n);
		if (item.endsWith("_bucket") && !item.equals(BUCKET) && item.startsWith("minecraft:")) {
			Credit c = giveBack(Map.of(BUCKET, n), capacityStacks, maxStack);
			c.overflow().forEach((k, v) -> overflowOut.merge(k, v, Integer::sum));
		}
		return true;
	}

	/**
	 * Credits refunds under {@code key}, once (§4): up to capacity into {@code returned}, the rest into {@code refundOverflow}
	 * (the caller drops it as items). A key credited before credits nothing ({@link Credit#already}).
	 */
	public Credit credit(String key, Map<String, Integer> items, int capacityStacks, ToIntFunction<String> maxStack) {
		if (credited.contains(key)) {
			return new Credit(Map.of(), Map.of(), true);
		}
		credited.add(key);
		return giveBack(items, capacityStacks, maxStack);
	}

	/** Credits items with no key (a swap's old block as it happens, a bucket's container): up to capacity, the rest overflow. */
	public Credit giveBack(Map<String, Integer> items, int capacityStacks, ToIntFunction<String> maxStack) {
		Map<String, Integer> in = new TreeMap<>();
		Map<String, Integer> over = new TreeMap<>();
		for (var e : new TreeMap<>(items).entrySet()) {
			int n = e.getValue();
			if (n <= 0) {
				continue;
			}
			int fit = Math.min(n, room(e.getKey(), capacityStacks, maxStack));
			if (fit > 0) {
				add(returned, e.getKey(), fit);
				in.put(e.getKey(), fit);
			}
			if (n - fit > 0) {
				add(refundOverflow, e.getKey(), n - fit);
				over.put(e.getKey(), n - fit);
			}
		}
		return new Credit(in, over, false);
	}

	/** Takes {@code n} of {@code item} out as withdrawn (credit to a player, a dissolve to a player). Clamped to the stock. */
	public int withdraw(String item, int n) {
		int t = Math.max(0, Math.min(n, stock(item)));
		add(withdrawn, item, t);
		return t;
	}

	/** Takes {@code n} of {@code item} out of stock to drop as items (forced crate removal, dissolve at a crate). Clamped. */
	public int drop(String item, int n) {
		int t = Math.max(0, Math.min(n, stock(item)));
		add(dropped, item, t);
		return t;
	}

	/**
	 * Adoption of a legacy crate (§5): its ledger joins this one. Its delivered counts are added to {@code delivered} and its
	 * placed counts to {@code consumed}, so the stock grows by exactly the crate's stock and the identity holds; what then does
	 * not fit in {@code capacityStacks} is dropped (booked in {@code dropped}) and returned for the caller to drop as items.
	 * Credited once per {@code key}.
	 */
	public Map<String, Integer> adopt(String key, Map<String, Integer> crateDelivered, Map<String, Integer> cratePlaced, int capacityStacks,
		ToIntFunction<String> maxStack) {
		if (credited.contains(key)) {
			return Map.of();
		}
		credited.add(key);
		Map<String, Integer> before = stock();
		crateDelivered.forEach((k, v) -> add(delivered, k, v));
		cratePlaced.forEach((k, v) -> add(consumed, k, v));
		// over capacity: of what came in (by item id, deterministic), the least that frees whole stacks drops: a partial stack first
		Map<String, Integer> out = new TreeMap<>();
		for (var e : new TreeMap<>(stock()).entrySet()) {
			int came = e.getValue() - before.getOrDefault(e.getKey(), 0);
			int max = Math.max(1, maxStack.applyAsInt(e.getKey()));
			while (came > 0 && usedStacks(maxStack) > capacityStacks) {
				int s = stock(e.getKey());
				int chunk = Math.min(came, s % max == 0 ? max : s % max);
				add(dropped, e.getKey(), chunk);
				out.merge(e.getKey(), chunk, Integer::sum);
				came -= chunk;
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ persistence

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.add("delivered", counts(delivered));
		o.add("returned", counts(returned));
		o.add("consumed", counts(consumed));
		o.add("withdrawn", counts(withdrawn));
		o.add("dropped", counts(dropped));
		o.add("refundOverflow", counts(refundOverflow));
		JsonArray k = new JsonArray();
		credited.forEach(k::add);
		o.add("credited", k);
		return o;
	}

	public static StockLedger fromJson(@Nullable JsonObject o) {
		StockLedger l = new StockLedger();
		if (o == null) {
			return l;
		}
		read(o, "delivered", l.delivered);
		read(o, "returned", l.returned);
		read(o, "consumed", l.consumed);
		read(o, "withdrawn", l.withdrawn);
		read(o, "dropped", l.dropped);
		read(o, "refundOverflow", l.refundOverflow);
		if (o.has("credited") && o.get("credited").isJsonArray()) {
			o.getAsJsonArray("credited").forEach(e -> l.credited.add(e.getAsString()));
		}
		return l;
	}

	private static JsonObject counts(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	private static void read(JsonObject o, String k, Map<String, Integer> into) {
		if (o.has(k) && o.get(k).isJsonObject()) {
			o.getAsJsonObject(k).entrySet().forEach(e -> {
				int v = e.getValue().getAsInt();
				if (v != 0) {
					into.put(e.getKey(), v);
				}
			});
		}
	}
}
