package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import java.util.Map;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.3, §3.4) One planned effect of a txn, with every amount, written in the intent before anything runs
 * (R-1, R-2). Its idempotency key is {@code <txn id>/<i>} (its compensation's {@code <txn id>/<i>!c}).
 *
 * @param i       its index in the plan (0, 1, ...)
 * @param op      the kind's operation name (the adapter that probes, applies and compensates it)
 * @param cls     its class (how recovery observes it)
 * @param prepare a prepare effect: applied before the decision, compensable; the others run only after a commit
 * @param items   the items it moves (item id to count), for the conservation check (§5.2); empty for none
 * @param from    where the items come from ({@code "transit"} for a booking out of transit)
 * @param to      where they go ({@code "transit"} for a take)
 * @param member  the group member it belongs to (an abandon's split, §3.6), or null
 * @param data    the op's own fields (positions, keys, pile, store)
 */
public record Effect(int i, String op, EffectClass cls, boolean prepare, Map<String, Integer> items, String from, String to, @Nullable String member,
	JsonObject data) {
	public static final String TRANSIT = "transit";

	public Effect {
		if (i < 0 || op == null || op.isEmpty() || cls == null) {
			throw new IllegalArgumentException("an effect needs i >= 0, an op and a class");
		}
		items = items == null ? Map.of() : Map.copyOf(new TreeMap<>(items));
		for (var e : items.entrySet()) {
			if (e.getValue() == null || e.getValue() < 0) {
				throw new IllegalArgumentException("effect " + i + ": a negative amount of " + e.getKey());
			}
		}
		from = from == null ? "" : from;
		to = to == null ? "" : to;
		data = data == null ? new JsonObject() : data.deepCopy();
	}

	/** The effect's idempotency key in txn {@code txnId}. */
	public String key(String txnId) {
		return txnId + "/" + i;
	}

	/** Its compensation's key. */
	public String compKey(String txnId) {
		return txnId + "/" + i + "!c";
	}

	/** A take: items into transit. */
	public boolean intoTransit() {
		return TRANSIT.equals(to) && !TRANSIT.equals(from);
	}

	/** A booking: items out of transit. */
	public boolean outOfTransit() {
		return TRANSIT.equals(from) && !TRANSIT.equals(to);
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("i", i);
		o.addProperty("op", op);
		o.addProperty("class", cls.name());
		o.addProperty("prepare", prepare);
		JsonObject it = new JsonObject();
		new TreeMap<>(items).forEach(it::addProperty);
		o.add("items", it);
		o.addProperty("from", from);
		o.addProperty("to", to);
		if (member != null) {
			o.addProperty("member", member);
		}
		o.add("data", data.deepCopy());
		return o;
	}

	public static Effect fromJson(JsonObject o) {
		Map<String, Integer> items = new TreeMap<>();
		if (o.get("items") instanceof JsonObject it) {
			for (var e : it.entrySet()) {
				items.put(e.getKey(), e.getValue().getAsInt());
			}
		}
		return new Effect(o.get("i").getAsInt(), o.get("op").getAsString(), EffectClass.valueOf(o.get("class").getAsString()),
			o.has("prepare") && o.get("prepare").getAsBoolean(), items, o.has("from") ? o.get("from").getAsString() : "", o.has("to") ? o.get("to")
				.getAsString() : "", o.has("member") ? o.get("member").getAsString() : null, o.get("data") instanceof JsonObject d ? d : new JsonObject());
	}

	/** A builder for a kind's plan (R-1). */
	public static Builder of(String op, EffectClass cls) {
		return new Builder(op, cls);
	}

	public static final class Builder {
		private final String op;
		private final EffectClass cls;
		private boolean prepare;
		private Map<String, Integer> items = Map.of();
		private String from = "";
		private String to = "";
		private @Nullable String member;
		private final JsonObject data = new JsonObject();

		Builder(String op, EffectClass cls) {
			this.op = op;
			this.cls = cls;
		}

		public Builder prepare() {
			prepare = true;
			return this;
		}

		public Builder items(Map<String, Integer> m) {
			items = m;
			return this;
		}

		public Builder move(String from, String to) {
			this.from = from;
			this.to = to;
			return this;
		}

		public Builder member(String m) {
			member = m;
			return this;
		}

		public Builder data(String k, String v) {
			data.addProperty(k, v);
			return this;
		}

		public Builder data(String k, Number v) {
			data.addProperty(k, v);
			return this;
		}

		public Builder data(String k, com.google.gson.JsonElement v) {
			data.add(k, v);
			return this;
		}

		Effect build(int i) {
			return new Effect(i, op, cls, prepare, items, from, to, member, data);
		}
	}
}
