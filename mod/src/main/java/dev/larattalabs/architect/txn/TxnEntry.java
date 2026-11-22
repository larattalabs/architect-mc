package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.3, format 1) One txn in {@code architect/txn.json}: the immutable {@link Decision} (null while
 * undecided) beside the {@link Phase}, the plan with every amount, the event payloads captured at planning (§3.7, round 4: durable before
 * any destructive effect), the persisted awaits, and the terminal result. {@code id} is the attempt key (fresh per begin); {@code key} the
 * semantic dedupe key. Server thread (or the model's one thread).
 */
public final class TxnEntry {
	static final Pattern ID = Pattern.compile("tx-[1-9][0-9]*");

	public final String id;
	public final String kind;
	public final int kv;
	public final @Nullable String key;
	public final long atTick;
	public final long atWall;
	public final @Nullable String who;
	public final List<String> resources;
	/** {@code txn} (the decision is this file's write) or {@code journal} (a D effect decides). */
	public final String decider;
	final List<Effect> effects = new ArrayList<>();
	/** Immutable event source data by event name, captured at planning; an abort's own payload is added with {@code decision: abort}. */
	final JsonObject payloads = new JsonObject();
	final Set<String> emitted = new LinkedHashSet<>();
	/** Receipt hints only (never decide recovery). */
	final JsonObject receipts = new JsonObject();
	@Nullable Decision decision;
	Phase phase = Phase.PREPARED;
	final List<Await> awaits = new ArrayList<>();
	JsonObject result = new JsonObject();

	// transient, this session only
	/** Handed to {@link TxnCore#persist} (its plan is fixed from then on); a loaded entry is persisted. */
	boolean persisted;
	/** Driven by its own operation this session (forward), not recovered after a restart. */
	boolean live;
	/** Why it is held now (an UNKNOWN probe, an IN_DOUBT write, a refused barrier), or null. */
	@Nullable String held;
	/** The resource its hold names ({@code chunk x,z}, {@code player <name>}), or null. */
	@Nullable String heldAt;
	/**
	 * (slice T4R fix round, P1-2) An effect was applied this session since the last barrier that passed: the next member barrier must run
	 * (a refused one stays owed across drives). False after a restart: what loads is what is on disk.
	 */
	boolean dirty;

	/** (slice T4R) The highest member barrier ({@link TxnCore#BARRIER}) a drive passed this session: every effect before it is durable. */
	int passed = -1;

	/** (slice T4R-D, P2-6) A progress signature: a waiting removal's counter advances only while this stays the same between checks. */
	public long progress() {
		return ((long) passed * 31 + (phase == null ? 0 : phase.ordinal())) * 31 + (dirty ? 1 : 0) + 7L * emitted.size() + 13L * (held == null ? 0 : 1);
	}

	/** (slice T4R) Whether every effect up to {@code i} is durable: a member barrier at or after it was passed, or its effects are done. */
	public boolean durableThrough(int i) {
		return passed >= i || phase == Phase.EFFECTS_DONE || phase == Phase.RETIRING;
	}

	/** (slice T3b, TEST dev.txn.pauseAt) The point its drive stopped at, held open until the pause is cleared; null when not paused. */
	@Nullable String paused;

	TxnEntry(String id, String kind, int kv, @Nullable String key, long atTick, long atWall, @Nullable String who, List<String> resources,
		String decider) {
		this.id = id;
		this.kind = kind;
		this.kv = kv;
		this.key = key;
		this.atTick = atTick;
		this.atWall = atWall;
		this.who = who;
		this.resources = List.copyOf(resources);
		this.decider = decider;
	}

	public List<Effect> effects() {
		return Collections.unmodifiableList(effects);
	}

	public @Nullable Decision decision() {
		return decision;
	}

	public Phase phase() {
		return phase;
	}

	public JsonObject payloads() {
		return payloads.deepCopy();
	}

	public Set<String> emitted() {
		return Collections.unmodifiableSet(emitted);
	}

	public List<Await> awaits() {
		return Collections.unmodifiableList(awaits);
	}

	public JsonObject result() {
		return result.deepCopy();
	}

	public @Nullable String held() {
		return held;
	}

	public @Nullable String heldAt() {
		return heldAt;
	}

	public boolean journalDecided() {
		return "journal".equals(decider);
	}

	/** The D effect of a journal-decided kind, or null. */
	public @Nullable Effect dEffect() {
		for (Effect e : effects) {
			if (e.cls() == EffectClass.D) {
				return e;
			}
		}
		return null;
	}

	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("kind", kind);
		o.addProperty("kv", kv);
		if (key != null) {
			o.addProperty("key", key);
		}
		o.add("decision", decision == null ? com.google.gson.JsonNull.INSTANCE : decision.toJson());
		o.addProperty("phase", phase.name());
		JsonObject at = new JsonObject();
		at.addProperty("tick", atTick);
		at.addProperty("wall", atWall);
		o.add("at", at);
		if (who != null) {
			o.addProperty("who", who);
		}
		JsonArray rs = new JsonArray();
		resources.forEach(rs::add);
		o.add("resources", rs);
		JsonObject dc = new JsonObject();
		dc.addProperty("kind", decider);
		o.add("decider", dc);
		JsonArray es = new JsonArray();
		effects.forEach(e -> es.add(e.toJson()));
		o.add("effects", es);
		o.add("receipts", receipts.deepCopy());
		o.add("payloads", payloads.deepCopy());
		JsonObject ev = new JsonObject();
		JsonArray em = new JsonArray();
		emitted.forEach(em::add);
		ev.add("emitted", em);
		o.add("events", ev);
		JsonArray aw = new JsonArray();
		awaits.forEach(a -> aw.add(a.toJson()));
		o.add("awaits", aw);
		o.add("result", result.deepCopy());
		return o;
	}

	/** An entry that fails its own validation (§3.8: quarantined, never guessed). */
	public static final class Invalid extends RuntimeException {
		Invalid(String why) {
			super(why);
		}
	}

	/** Parses and validates one entry; {@link Invalid} for a missing field, a bad id, a negative amount or an impossible combination. */
	public static TxnEntry fromJson(JsonObject o) {
		try {
			String id = o.get("id").getAsString();
			if (!ID.matcher(id).matches()) {
				throw new Invalid("bad id " + id);
			}
			String kind = o.get("kind").getAsString();
			int kv = o.get("kv").getAsInt();
			if (kind.isEmpty() || kv < 1) {
				throw new Invalid(id + ": a kind and kv >= 1 are needed");
			}
			JsonObject at = o.getAsJsonObject("at");
			List<String> res = new ArrayList<>();
			o.getAsJsonArray("resources").forEach(x -> res.add(x.getAsString()));
			String decider = o.getAsJsonObject("decider").get("kind").getAsString();
			if (!"txn".equals(decider) && !"journal".equals(decider)) {
				throw new Invalid(id + ": unknown decider " + decider);
			}
			TxnEntry t = new TxnEntry(id, kind, kv, o.has("key") ? o.get("key").getAsString() : null, at.get("tick").getAsLong(), at.get("wall")
				.getAsLong(), o.has("who") ? o.get("who").getAsString() : null, res, decider);
			int n = 0;
			for (JsonElement e : o.getAsJsonArray("effects")) {
				Effect f = Effect.fromJson(e.getAsJsonObject());
				if (f.i() != n++) {
					throw new Invalid(id + ": effects out of order at " + f.i());
				}
				t.effects.add(f);
			}
			if (t.effects.isEmpty()) {
				throw new Invalid(id + ": no effects");
			}
			if ("journal".equals(decider) && t.dEffect() == null) {
				throw new Invalid(id + ": a journal decider without a D effect");
			}
			if (o.get("receipts") instanceof JsonObject r) {
				r.entrySet().forEach(x -> t.receipts.add(x.getKey(), x.getValue()));
			}
			if (o.get("payloads") instanceof JsonObject p) {
				p.entrySet().forEach(x -> t.payloads.add(x.getKey(), x.getValue()));
			}
			if (o.get("events") instanceof JsonObject ev && ev.get("emitted") instanceof JsonArray em) {
				em.forEach(x -> t.emitted.add(x.getAsString()));
			}
			t.decision = Decision.fromJson(o.get("decision"));
			t.persisted = true;
			t.phase = Phase.valueOf(o.get("phase").getAsString());
			if (o.get("awaits") instanceof JsonArray aw) {
				aw.forEach(x -> t.awaits.add(Await.fromJson(x.getAsJsonObject())));
			}
			if (o.get("result") instanceof JsonObject r) {
				t.result = r.deepCopy();
			}
			// impossible combinations (§3.6): progress past the decision point with no decision; compensation under a commit
			if (t.decision == null && (t.phase == Phase.EFFECTS_DONE || t.phase == Phase.ABORTING || t.phase == Phase.RETIRING)) {
				throw new Invalid(id + ": phase " + t.phase + " without a decision");
			}
			if (t.decision != null && t.decision.isCommit() && t.phase == Phase.ABORTING) {
				throw new Invalid(id + ": a commit cannot be ABORTING");
			}
			return t;
		} catch (Invalid e) {
			throw e;
		} catch (RuntimeException e) {
			throw new Invalid("unreadable entry: " + e);
		}
	}
}
