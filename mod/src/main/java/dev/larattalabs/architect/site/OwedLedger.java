package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2b, docs/TXN-DESIGN.md §3.4 O, Noah's decision 1) Owed collectibles: items Architect owes a recipient (a player UUID or an owner
 * id) that can't go back into a stock, instead of an item entity. They live in {@code stockpiles.json} beside the piles ({@code owed}), so an
 * entry and a pile's credit land in one ledger write, and they are published only as the ledger is (the barrier: players, chunks, then the
 * ledger). Keyed by the source's semantic key, stable for the entry's life; an ended key is remembered (bounded) so it is never owed again.
 * Every change carries its txn effect's key in {@code applied} (bounded): the L/O probe. Pure apart from the registry; server thread.
 */
public final class OwedLedger {
	private OwedLedger() {
	}

	/** One entry. Items by id, as the pile ledger keeps them. */
	public record Entry(String key, String recipient, String dimension, int x, int y, int z, Map<String, Integer> items, String reason, long tick, long wall) {
		public Entry {
			items = Collections.unmodifiableMap(new TreeMap<>(items));
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("key", key);
			o.addProperty("recipient", recipient);
			o.addProperty("dimension", dimension);
			JsonArray at = new JsonArray();
			at.add(x);
			at.add(y);
			at.add(z);
			o.add("at", at);
			JsonObject it = new JsonObject();
			items.forEach(it::addProperty);
			o.add("items", it);
			o.addProperty("reason", reason);
			o.addProperty("tick", tick);
			o.addProperty("wall", wall);
			return o;
		}

		static Entry fromJson(JsonObject o) {
			JsonArray at = o.getAsJsonArray("at");
			Map<String, Integer> it = new TreeMap<>();
			o.getAsJsonObject("items").entrySet().forEach(e -> it.put(e.getKey(), e.getValue().getAsInt()));
			return new Entry(o.get("key").getAsString(), o.get("recipient").getAsString(), o.get("dimension").getAsString(), at.get(0).getAsInt(),
				at.get(1).getAsInt(), at.get(2).getAsInt(), it, o.get("reason").getAsString(), o.get("tick").getAsLong(), o.get("wall").getAsLong());
		}
	}

	/** The reasons (stable API values). */
	public static final String CRATE_SETTLE = "crate_settle", CRATE_PUTBACK = "crate_putback", GROUP_REFUND = "group_refund";

	static final int BOUND = 4096;
	private static final LinkedHashMap<String, Entry> ENTRIES = new LinkedHashMap<>();
	private static final LinkedHashSet<String> ENDED = new LinkedHashSet<>();
	private static final LinkedHashSet<String> APPLIED = new LinkedHashSet<>();

	public static synchronized boolean isEmpty() {
		return ENTRIES.isEmpty() && ENDED.isEmpty() && APPLIED.isEmpty();
	}

	public static synchronized void clear() {
		ENTRIES.clear();
		ENDED.clear();
		APPLIED.clear();
	}

	/** The recipient's entries, oldest first (by tick, then key). */
	public static synchronized List<Entry> of(String recipient) {
		List<Entry> out = new ArrayList<>();
		for (Entry e : ENTRIES.values()) {
			if (e.recipient().equals(recipient)) {
				out.add(e);
			}
		}
		out.sort(java.util.Comparator.comparingLong(Entry::tick).thenComparing(Entry::key));
		return out;
	}

	public static synchronized List<Entry> all() {
		return List.copyOf(ENTRIES.values());
	}

	public static synchronized @Nullable Entry get(String key) {
		return ENTRIES.get(key);
	}

	/** Whether the txn effect {@code effectKey} changed the owed ledger (its probe). */
	public static synchronized boolean applied(String effectKey) {
		return APPLIED.contains(effectKey);
	}

	/**
	 * Owes {@code e} under its key, marked by {@code effectKey} (the source txn's O effect; null for a dev entry). False, nothing changed, when
	 * the key is owed or has ended before (a source never owes one key twice).
	 */
	public static synchronized boolean owe(Entry e, @Nullable String effectKey) {
		if (ENTRIES.containsKey(e.key()) || ENDED.contains(e.key()) || e.items().isEmpty()) {
			return false;
		}
		ENTRIES.put(e.key(), e);
		mark(effectKey);
		return true;
	}

	/**
	 * Takes {@code items} off entry {@code key} (a collect or a credit to stock), marked by {@code effectKey}; an entry left empty ends. Throws
	 * when the entry doesn't hold them (nothing changed): a txn plans only what the entry holds, and holds the key meanwhile.
	 */
	public static synchronized Entry debit(String key, Map<String, Integer> items, String effectKey) {
		Entry e = ENTRIES.get(key);
		if (e == null) {
			throw new IllegalStateException("nothing is owed under " + key);
		}
		Map<String, Integer> left = new TreeMap<>(e.items());
		for (var x : items.entrySet()) {
			int have = left.getOrDefault(x.getKey(), 0);
			if (have < x.getValue()) {
				throw new IllegalStateException(key + " owes " + have + " " + x.getKey() + ", not " + x.getValue());
			}
		}
		items.forEach((k, v) -> left.merge(k, -v, Integer::sum));
		left.values().removeIf(v -> v <= 0);
		Entry after = new Entry(e.key(), e.recipient(), e.dimension(), e.x(), e.y(), e.z(), left, e.reason(), e.tick(), e.wall());
		if (left.isEmpty()) {
			ENTRIES.remove(key);
			ENDED.add(key);
			trim(ENDED);
		} else {
			ENTRIES.put(key, after);
		}
		mark(effectKey);
		return after;
	}

	private static void mark(@Nullable String effectKey) {
		if (effectKey != null) {
			APPLIED.add(effectKey);
			trim(APPLIED);
		}
	}

	private static void trim(LinkedHashSet<String> s) {
		while (s.size() > BOUND) {
			s.remove(s.iterator().next());
		}
	}

	/** Every item owed (conservation's {@code owed} term), by id. */
	public static synchronized Map<String, Integer> total() {
		Map<String, Integer> t = new TreeMap<>();
		ENTRIES.values().forEach(e -> e.items().forEach((k, v) -> t.merge(k, v, Integer::sum)));
		return t;
	}

	static synchronized JsonObject toJson() {
		JsonObject o = new JsonObject();
		JsonArray es = new JsonArray();
		ENTRIES.values().forEach(e -> es.add(e.toJson()));
		o.add("entries", es);
		JsonArray en = new JsonArray();
		ENDED.forEach(en::add);
		o.add("ended", en);
		JsonArray ap = new JsonArray();
		APPLIED.forEach(ap::add);
		o.add("applied", ap);
		return o;
	}

	static synchronized void readInto(@Nullable JsonElement el) {
		clear();
		if (!(el instanceof JsonObject o)) {
			return;
		}
		if (o.get("entries") instanceof JsonArray es) {
			es.forEach(x -> {
				Entry e = Entry.fromJson(x.getAsJsonObject());
				ENTRIES.put(e.key(), e);
			});
		}
		if (o.get("ended") instanceof JsonArray en) {
			en.forEach(x -> ENDED.add(x.getAsString()));
		}
		if (o.get("applied") instanceof JsonArray ap) {
			ap.forEach(x -> APPLIED.add(x.getAsString()));
		}
	}
}
