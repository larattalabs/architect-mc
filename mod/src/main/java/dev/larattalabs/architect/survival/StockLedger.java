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
	/**
	 * (slice JR) Per target (its credit key: {@code site:<id>@<placedAt>}, {@code road:<id>@<placedAt>}), what the feed consumed for it and
	 * no refund or retake has given back yet. Booked with {@link #consumed} and saved with it, so after a crash it is what the saved
	 * ledger says that target took: a keyed refund never credits more ({@link #credit}). Only {@code site:} and {@code road:} keys (the
	 * feed's targets) are capped: fluids', mechanisms' and retakes' own keys are not. A target key with no record took nothing the saved
	 * ledger knows of (it was fed after the save) except what predates the records: {@link #legacy}.
	 */
	private final Map<String, Map<String, Integer>> paid = new TreeMap<>();
	/**
	 * (JR) Consumption the per-target records don't cover: a file written before JR (its consumed less its returned, at load). (JR-b) Only a
	 * target placed before {@link #legacySince} draws on it, after its own record (spent as it is used); an adopted crate no longer adds to it.
	 */
	private final Map<String, Integer> legacy = new TreeMap<>();
	/**
	 * (slice RL) Per building target (its credit key), its cells as this ledger knew them: {@link Book#standing} the paid cells standing at
	 * the ledger's last save (refreshed just before each save, so it is saved with the records it matches), and {@link Book#owed} the cells
	 * that stand but were never paid (a crash's world ahead of the ledger), which the feed charges before they count as built. The reconcile
	 * at an unclean start compares the loaded world with it (docs/CONTRACT.md "Slice RL").
	 */
	private final Map<String, Book> books = new TreeMap<>();
	/**
	 * (M5 FK) The targets (credit keys) whose fill is paid: the fill's commit point, written with the charge in the same ledger save
	 * ({@code Stockpiles.saveWithWorld}). A target in it is never filled again. Dropped with the key's credit.
	 */
	private final java.util.Set<String> filled = new java.util.TreeSet<>();
	/**
	 * (M5 FK) Per target (credit key), the declared containers' contents a removal took out of the world (at most each one's declaration):
	 * Architect's custody until the key's credit books them with the blocks (capped by the paid record), or a removal that ends unwritten
	 * puts them back.
	 */
	private final Map<String, Map<String, Integer>> custody = new TreeMap<>();

	/**
	 * (RL) A target's cells as the ledger knows them, by queue position: {@code known} the cells whose state the book has seen (a cell in a
	 * chunk never loaded since the world started is not known: the reconcile leaves it alone), {@code standing} the known cells that stood
	 * paid at the save, {@code owed} the cells that stand unpaid (live: the feed clears a bit as it charges the cell). {@code queueHash} and
	 * {@code size} identify the queue the bits index (a construction delta re-queues: a book of another queue is not used).
	 */
	public record Book(int queueHash, int size, java.util.BitSet known, java.util.BitSet standing, java.util.BitSet owed) {
		public Book {
			known = (java.util.BitSet) known.clone();
			standing = (java.util.BitSet) standing.clone();
			owed = owed == null ? new java.util.BitSet() : owed;
		}

		public boolean fits(int[] queue) {
			return size == queue.length && queueHash == java.util.Arrays.hashCode(queue);
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("q", queueHash);
			o.addProperty("n", size);
			o.addProperty("k", CellBits.base64(known));
			o.addProperty("s", CellBits.base64(standing));
			if (!owed.isEmpty()) {
				o.addProperty("o", CellBits.base64(owed));
			}
			return o;
		}

		static @Nullable Book fromJson(JsonObject o) {
			try {
				return new Book(o.get("q").getAsInt(), o.get("n").getAsInt(), CellBits.fromBase64(o.get("k").getAsString()),
					CellBits.fromBase64(o.get("s").getAsString()), o.has("o") ? CellBits.fromBase64(o.get("o").getAsString()) : new java.util.BitSet());
			} catch (RuntimeException e) {
				return null;
			}
		}
	}

	/** (RL) What a reconcile finds: {@code ahead} cells stand but never stood paid; {@code lost} cells stood paid and are gone. */
	public record Plan(java.util.BitSet ahead, java.util.BitSet lost) {
	}

	/**
	 * (RL) The reconcile's comparison, pure: {@code stands} the cells that hold their block in the loaded world (placed free and other writers'
	 * cells already left out), {@code excluded} the cells to leave alone (placed free since, another writer's now). Over the cells the book
	 * knows only: a cell it never saw is neither ahead nor lost. An owed cell still standing is ahead again (it is still owed).
	 */
	public static Plan plan(Book b, java.util.BitSet stands, java.util.function.IntPredicate excluded) {
		java.util.BitSet ahead = (java.util.BitSet) stands.clone();
		ahead.and(b.known());
		ahead.andNot(b.standing());
		java.util.BitSet lost = (java.util.BitSet) b.standing().clone();
		lost.andNot(stands);
		for (int i = ahead.nextSetBit(0); i >= 0; i = ahead.nextSetBit(i + 1)) {
			if (excluded.test(i)) {
				ahead.clear(i);
			}
		}
		for (int i = lost.nextSetBit(0); i >= 0; i = lost.nextSetBit(i + 1)) {
			if (excluded.test(i)) {
				lost.clear(i);
			}
		}
		return new Plan(ahead, lost);
	}

	/** (RL) A target's book, or null. */
	public @Nullable Book book(String key) {
		return books.get(key);
	}

	/** (RL) Sets (or, null, drops) a target's book. */
	public void book(String key, @Nullable Book b) {
		if (b == null) {
			books.remove(key);
		} else {
			books.put(key, b);
		}
	}

	public Map<String, Book> books() {
		return Map.copyOf(books);
	}

	/** (RL) Keeps only the books of these keys (the targets still building). */
	public void retainBooks(Set<String> keys) {
		books.keySet().retainAll(keys);
	}

	/**
	 * (JR-b) When this ledger's pre-JR consumption became {@link #legacy}: wall-clock ms, the clock of a target's {@code placedAt}. A target placed
	 * at or after it was fed only under the records, so it never draws on the pool (else a crash refund mints out of it, F3). 0: no pool.
	 */
	private long legacySince;
	/**
	 * (JR-b) A file that has the records and a pool but no {@link #legacySince} was converted by v0.64.0, at a load no later than its release
	 * (commit 40a59368, 2026-11-12 23:15:25 -0700): every target placed before it is pre-JR; one placed after it may be post-JR, so it never draws.
	 */
	public static final long JR_RELEASED_MS = 1_794_550_525_000L;

	/** What crediting items did: what entered the stock and what did not fit (to drop as items, booked as refundOverflow). */
	public record Credit(Map<String, Integer> returned, Map<String, Integer> overflow, boolean already, Map<String, Integer> shortfall) {
		public static final Credit NONE = new Credit(Map.of(), Map.of(), false);

		public Credit(Map<String, Integer> returned, Map<String, Integer> overflow, boolean already) {
			this(returned, overflow, already, Map.of());
		}

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
		// (M5 FK) the declared containers' contents in custody refund with the blocks, under the same cap (the fill is in the record)
		Map<String, Integer> held = custody.remove(key);
		filled.remove(key);
		if (held != null && !held.isEmpty()) {
			Map<String, Integer> all = new TreeMap<>(items);
			held.forEach((k, v) -> all.merge(k, v, Integer::sum));
			items = all;
		}
		String deltaOf = deltaSite(key);
		if (deltaOf != null) {
			// (JR) a construction delta's refund: from its site's record (taken out of it, as a retake)
			Map<String, Integer> in = fromPaid(deltaOf, items);
			Credit c = giveBack(in, capacityStacks, maxStack);
			return new Credit(c.returned(), c.overflow(), false, shortfall(items, in));
		}
		if (!targetKey(key)) {
			return giveBack(items, capacityStacks, maxStack);
		}
		// (JR) never more than the saved ledger says this target consumed; the record is spent with its refund (no record: the legacy pool)
		Map<String, Integer> rec = paid.remove(key);
		Map<String, Integer> in = capRecordThenLegacy(items, rec == null ? new TreeMap<>() : new TreeMap<>(rec), placedAtOf(key));
		Credit c = giveBack(in, capacityStacks, maxStack);
		return new Credit(c.returned(), c.overflow(), false, shortfall(items, in));
	}

	/** (M5 FK) The fill of target {@code key} is paid (its commit point, saved with the charge). */
	public void markFilled(String key) {
		filled.add(key);
	}

	/** (M5 FK) Whether the saved ledger had the fill of {@code key} paid. */
	public boolean filled(String key) {
		return filled.contains(key);
	}

	/** (M5 FK) Takes {@code items} into custody under {@code key} (added to what it holds). */
	public void holdCustody(String key, Map<String, Integer> items) {
		items.forEach((k, v) -> {
			if (v > 0) {
				custody.computeIfAbsent(key, x -> new TreeMap<>()).merge(k, v, Integer::sum);
			}
		});
	}

	/** (M5 FK) What {@code key} holds in custody (empty: none). */
	public Map<String, Integer> custody(String key) {
		Map<String, Integer> m = custody.get(key);
		return m == null ? Map.of() : Map.copyOf(m);
	}

	/** (M5 FK) Every key with custody. */
	public java.util.Set<String> custodyKeys() {
		return java.util.Set.copyOf(custody.keySet());
	}

	/** (M5 FK) Drops and returns {@code key}'s custody (written back into its containers). */
	public Map<String, Integer> releaseCustody(String key) {
		Map<String, Integer> m = custody.remove(key);
		return m == null ? Map.of() : m;
	}

	/** (JR) Books what the feed consumed for a target under its credit key (with {@link #consume}). */
	public void pay(String key, String item, int n) {
		if (n > 0) {
			paid.computeIfAbsent(key, k -> new TreeMap<>()).merge(item, n, Integer::sum);
		}
	}

	/** (JR) Drops a target's paid record (its refund credited nothing: nothing of it stood). */
	public void dropPaid(String key) {
		paid.remove(key);
	}

	/** (JR) Whether a target ({@code site:} or {@code road:} id) has a paid record. */
	public boolean tracks(String targetId) {
		return keyOf(targetId) != null;
	}

	/**
	 * (JR) A retake: another writer took up {@code items} of the target {@code targetId}'s paid blocks; what goes back is capped by its paid
	 * record (same rule as {@link #credit}) and taken out of the record. A target with no record: {@code items} as they are.
	 */
	public Map<String, Integer> fromPaid(String targetId, Map<String, Integer> items) {
		return fromPaid(targetId, items, -1);
	}

	/**
	 * (JR-b) {@link #fromPaid(String, Map)} for a target placed at {@code placedAt} (wall-clock ms; &lt; 0 unknown): with no record, what
	 * goes back is the legacy pool's only for a target placed before {@link #legacySince}, else nothing. With a record, its key's
	 * {@code placedAt} decides.
	 */
	public Map<String, Integer> fromPaid(String targetId, Map<String, Integer> items, long placedAt) {
		String k = keyOf(targetId);
		if (k == null) {
			return capRecordThenLegacy(items, new TreeMap<>(), placedAt); // (JR-b) no record: the caller's placedAt (unknown: never the pool)
		}
		Map<String, Integer> left = paid.get(k);
		Map<String, Integer> out = capRecordThenLegacy(items, left, placedAtOf(k));
		left.values().removeIf(v -> v <= 0);
		if (left.isEmpty()) {
			paid.remove(k);
		}
		return out;
	}

	public Map<String, Map<String, Integer>> paid() {
		Map<String, Map<String, Integer>> o = new TreeMap<>();
		paid.forEach((k, v) -> o.put(k, Map.copyOf(v)));
		return o;
	}

	/**
	 * (JR) {@code items} capped by the record {@code left} (spent from it), what is short then by the legacy pool (spent from it): (JR-b) only for
	 * a target placed before {@link #legacySince} ({@code placedAt} &lt; 0: unknown, never).
	 */
	private Map<String, Integer> capRecordThenLegacy(Map<String, Integer> items, Map<String, Integer> left, long placedAt) {
		Map<String, Integer> out = capTo(items, left);
		if (!legacy.isEmpty() && mayDrawLegacy(placedAt)) {
			capTo(shortfall(items, out), legacy).forEach((k, v) -> out.merge(k, v, Integer::sum));
			legacy.values().removeIf(v -> v <= 0);
		}
		return out;
	}

	/** (JR) What the records don't cover (pre-JR consumption): see {@link #legacy}. */
	public Map<String, Integer> legacy() {
		return Map.copyOf(legacy);
	}

	/** (JR-b) When the pool was made (wall-clock ms; 0: none): see {@link #legacySince}. */
	public long legacySince() {
		return legacySince;
	}

	/** (JR-b) Whether a target placed at {@code placedAt} (wall-clock ms; &lt; 0 unknown) predates the records, so it may draw on the pool. */
	public boolean mayDrawLegacy(long placedAt) {
		return placedAt >= 0 && placedAt < legacySince;
	}

	/** (JR-b) The {@code placedAt} of a target credit key ({@code site:<id>@<placedAt>}, {@code road:<id>@<placedAt>}), or -1. */
	static long placedAtOf(String key) {
		int i = key.lastIndexOf('@');
		if (i < 0 || i == key.length() - 1) {
			return -1;
		}
		try {
			return Long.parseLong(key.substring(i + 1));
		} catch (NumberFormatException e) {
			return -1;
		}
	}

	/** (JR) The site id of a construction delta's credit key ({@code delta:<entry>:<siteId>}), or null. */
	static @Nullable String deltaSite(String key) {
		if (!key.startsWith("delta:")) {
			return null;
		}
		int i = key.lastIndexOf(':');
		return i > "delta:".length() - 1 && i < key.length() - 1 ? key.substring(i + 1) : null;
	}

	/** A feed target's credit key ({@code site:<id>@<placedAt>}, {@code road:<id>@<placedAt>}): capped by its record. */
	static boolean targetKey(String key) {
		return (key.startsWith("site:") || key.startsWith("road:")) && key.indexOf('@') > 0;
	}

	private @Nullable String keyOf(String targetId) {
		for (String k : paid.keySet()) {
			if (k.startsWith("site:" + targetId + "@") || k.startsWith("road:" + targetId + "@")) {
				return k;
			}
		}
		return null;
	}

	/**
	 * (JR) {@code items} capped by {@code left} (spent from it): the same item first, then, unit for unit, any item still left (a weathered
	 * copper block refunds for the copper block paid, a soil variant for its soil). Pure but for {@code left}; deterministic (item order).
	 */
	static Map<String, Integer> capTo(Map<String, Integer> items, Map<String, Integer> left) {
		Map<String, Integer> out = new TreeMap<>();
		Map<String, Integer> rest = new TreeMap<>();
		for (var e : new TreeMap<>(items).entrySet()) {
			int want = Math.max(0, e.getValue());
			int t = Math.min(want, Math.max(0, left.getOrDefault(e.getKey(), 0)));
			if (t > 0) {
				out.merge(e.getKey(), t, Integer::sum);
				left.merge(e.getKey(), -t, Integer::sum);
			}
			if (want - t > 0) {
				rest.put(e.getKey(), want - t);
			}
		}
		for (var e : rest.entrySet()) {
			int want = e.getValue();
			for (var l : left.entrySet()) {
				if (want == 0) {
					break;
				}
				int t = Math.min(want, Math.max(0, l.getValue()));
				if (t > 0) {
					l.setValue(l.getValue() - t);
					out.merge(e.getKey(), t, Integer::sum);
					want -= t;
				}
			}
		}
		return out;
	}

	private static Map<String, Integer> shortfall(Map<String, Integer> items, Map<String, Integer> in) {
		Map<String, Integer> s = new TreeMap<>();
		items.forEach((k, v) -> {
			int d = v - in.getOrDefault(k, 0);
			if (d > 0) {
				s.put(k, d);
			}
		});
		return s;
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
	 * Credited once per {@code key}. (JR-b) The crate's placed counts join no shared pool: none is keyed by this overload (see the other).
	 */
	public Map<String, Integer> adopt(String key, Map<String, Integer> crateDelivered, Map<String, Integer> cratePlaced, int capacityStacks,
		ToIntFunction<String> maxStack) {
		return adopt(key, crateDelivered, cratePlaced, Map.of(), capacityStacks, maxStack);
	}

	/**
	 * (JR-b) {@link #adopt(String, Map, Map, int, ToIntFunction)}, with the crate's placed counts keyed by the credit keys of the targets it fed
	 * ({@code byTarget}: credit key to items, added to that target's paid record, so its refund is capped by what it really took). Each item is
	 * capped at the crate's own placed count of it, in the map's order (the caller's placement order); what no target is given goes nowhere: an
	 * adopted crate never grows {@link #legacy} (F3), whose pool any pre-JR target could draw a crash refund from.
	 */
	public Map<String, Integer> adopt(String key, Map<String, Integer> crateDelivered, Map<String, Integer> cratePlaced,
		Map<String, Map<String, Integer>> byTarget, int capacityStacks, ToIntFunction<String> maxStack) {
		if (credited.contains(key)) {
			return Map.of();
		}
		credited.add(key);
		Map<String, Integer> before = stock();
		crateDelivered.forEach((k, v) -> add(delivered, k, v));
		cratePlaced.forEach((k, v) -> add(consumed, k, v));
		Map<String, Integer> left = new TreeMap<>(cratePlaced);
		for (var t : byTarget.entrySet()) {
			for (var e : new TreeMap<>(t.getValue()).entrySet()) {
				int n = Math.min(Math.max(0, e.getValue()), Math.max(0, left.getOrDefault(e.getKey(), 0)));
				if (n > 0) {
					pay(t.getKey(), e.getKey(), n);
					left.merge(e.getKey(), -n, Integer::sum);
				}
			}
		}
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
		// (JR) additive; its presence marks a ledger that keeps records (a file without it is older: its consumption becomes the legacy pool)
		JsonObject pd = new JsonObject();
		paid.forEach((key, m) -> pd.add(key, counts(m)));
		o.add("paid", pd);
		if (!legacy.isEmpty()) {
			o.add("legacy", counts(legacy));
		}
		if (!books.isEmpty()) {
			// (RL) additive: the building targets' cells as of this save (an older file has none: nothing to reconcile)
			JsonObject bk = new JsonObject();
			books.forEach((key, b) -> bk.add(key, b.toJson()));
			o.add("cells", bk);
		}
		if (legacySince > 0) {
			o.addProperty("legacySince", legacySince); // (JR-b) additive
		}
		if (!filled.isEmpty()) {
			JsonArray f = new JsonArray();
			filled.forEach(f::add);
			o.add("filled", f); // (M5 FK) additive (format 2): the paid fills' commit points
		}
		if (!custody.isEmpty()) {
			JsonObject cu = new JsonObject();
			custody.forEach((key, m) -> cu.add(key, counts(m)));
			o.add("custody", cu); // (M5 FK) additive (format 2)
		}
		return o;
	}

	public static StockLedger fromJson(@Nullable JsonObject o) {
		return fromJson(o, System.currentTimeMillis());
	}

	/** {@link #fromJson(JsonObject)} at wall-clock {@code now} (ms): (JR-b) a file written before the records is converted, stamped {@code now}. */
	public static StockLedger fromJson(@Nullable JsonObject o, long now) {
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
		if (!o.has("paid")) {
			// (JR) written before the records: what it consumed and hasn't had back may still be refunded, once, by any target
			for (var e : l.consumed.entrySet()) {
				int n = e.getValue() - get(l.returned, e.getKey());
				if (n > 0) {
					l.legacy.put(e.getKey(), n);
				}
			}
			if (!l.legacy.isEmpty()) {
				l.legacySince = now; // (JR-b) every target placed before this load is pre-JR; one placed from now on is fed under the records
			}
		}
		if (o.has("legacy") && o.get("legacy").isJsonObject()) {
			read(o.getAsJsonObject("legacy"), l.legacy);
		}
		if (o.has("legacySince") && o.get("legacySince").isJsonPrimitive()) {
			l.legacySince = o.get("legacySince").getAsLong();
		} else if (o.has("paid") && !l.legacy.isEmpty()) {
			l.legacySince = JR_RELEASED_MS; // (JR-b) converted by v0.64.0, which did not stamp it
		}
		if (l.legacy.isEmpty()) {
			l.legacySince = 0;
		}
		if (o.has("paid") && o.get("paid").isJsonObject()) {
			o.getAsJsonObject("paid").entrySet().forEach(e -> {
				if (e.getValue().isJsonObject()) {
					Map<String, Integer> m = new TreeMap<>();
					read(e.getValue().getAsJsonObject(), m);
					if (!m.isEmpty()) {
						l.paid.put(e.getKey(), m);
					}
				}
			});
		}
		if (o.has("filled") && o.get("filled").isJsonArray()) {
			o.getAsJsonArray("filled").forEach(e -> l.filled.add(e.getAsString()));
		}
		if (o.has("custody") && o.get("custody").isJsonObject()) {
			o.getAsJsonObject("custody").entrySet().forEach(e -> {
				if (e.getValue().isJsonObject()) {
					Map<String, Integer> m = new TreeMap<>();
					read(e.getValue().getAsJsonObject(), m);
					if (!m.isEmpty()) {
						l.custody.put(e.getKey(), m);
					}
				}
			});
		}
		if (o.has("cells") && o.get("cells").isJsonObject()) {
			o.getAsJsonObject("cells").entrySet().forEach(e -> {
				Book b = e.getValue().isJsonObject() ? Book.fromJson(e.getValue().getAsJsonObject()) : null;
				if (b != null) {
					l.books.put(e.getKey(), b);
				}
			});
		}
		return l;
	}

	private static JsonObject counts(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	private static void read(JsonObject counts, Map<String, Integer> into) {
		counts.entrySet().forEach(e -> {
			int v = e.getValue().getAsInt();
			if (v != 0) {
				into.put(e.getKey(), v);
			}
		});
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
