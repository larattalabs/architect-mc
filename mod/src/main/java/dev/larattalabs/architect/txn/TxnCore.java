package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.txn.TxnRecovery.Action;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.2-§3.8) The transaction core: the journal ({@code txn.json}, whole-file confirmed writes through a
 * {@link TxnStore}), begin with holds and the result cache (attempt keys vs dedupe keys, §3.7 round 4), the intent persisted before any
 * effect (R-2), and one {@link #drive} that runs the {@link TxnRecovery} table for the forward path and for recovery alike. Nothing in it
 * touches Minecraft: the game ({@code TxnServer}) and the crash model ({@code TxnCrashModel}) give it a {@link TxnEnv} and kinds.
 *
 * <p>Three invariants carry exactly-once:
 * <ul>
 * <li>no step acts on journal state that is not acknowledged OK: after a REFUSED or IN_DOUBT write the core is <b>unsynced</b> and every
 * drive first rewrites (or re-confirms) the file, holding until it is OK;</li>
 * <li>every effect probes its own marker before it applies or compensates, so any prefix replays from the same entry and markers;</li>
 * <li>an UNKNOWN probe holds (never read as ABSENT), and a decision is never compensated once written or once its D effect probes
 * APPLIED.</li>
 * </ul>
 * One thread (the server thread, or the model's).
 */
public final class TxnCore {
	/** {@code txn.json}'s format; a newer one is a load failure for txns (§3.8). */
	public static final int FORMAT = 1;
	public static final String FILE = "txn.json";
	/**
	 * (slice T4R, TXN §3 "barrier covering every W chunk of member m") A member barrier: an effect the core runs itself. On the forward pass
	 * (after the decision) it runs the env's barrier when any effect was applied since the previous one, and holds the txn when that barrier
	 * is refused; its probe is always APPLIED (it changes nothing). A {@code removal.group} plans one after each member's W effects and one
	 * after its L/O/settle, so a member is paid only once its restore is on disk and is durable before the next member goes on.
	 */
	public static final String BARRIER = "txn.barrier";

	private static final TxnKind.Adapter BARRIER_ADAPTER = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
		}
	};

	/** The adapter for {@code e}: the core's own for {@link #BARRIER}, else its kind's. */
	static TxnKind.@Nullable Adapter adapterOf(TxnKind k, Effect e) {
		return BARRIER.equals(e.op()) ? BARRIER_ADAPTER : k.adapter(e);
	}


	/** TEST seams: TxnCrashModel's naive variants (each reproduces one reviewed counterexample). Production uses the defaults. */
	public static final class Options {
		/** The recovery rule function (default: the §3.6 table). */
		public TxnRecovery.Rules rules = TxnRecovery.TABLE;
		/** (review 3 P1-2's schema) one progress field: the decision is not persisted once EFFECTS_DONE overwrites COMMITTED. */
		public boolean phaseOnlySchema;
		/** (review 4 P2-4) the cache answers a dedupe key from an aborted attempt too. */
		public boolean cacheAborted;
		/** (review 2 P1-4's round-1 recovery) no PREPARED_DONE boundary: a committed redo probes and replays the prepare effects too. */
		public boolean redoPrepare;
		/** (T1 review P1-1) recovery trusts a loaded journal whose re-force did not return (only {@code unsynced} is checked). */
		public boolean ignoreStoreDoubt;
		/** (T1 review P2-3) an event counts as emitted when it is handed over, delivered or not. */
		public boolean emittedOnQueue;

		public static Options defaults() {
			return new Options();
		}
	}

	/** How a begin went. */
	public enum Begin {
		/** A fresh attempt: {@link Started#entry} to plan, then {@link #persist}. */
		NEW,
		/** An open txn already holds this dedupe key: the call attaches to it (§3.12.8). */
		ATTACHED,
		/** A committed result for this dedupe key: replay it, never run again. */
		REPLAYED,
		/** A resource is held by another txn: {@code held(other) ...}; nothing changed. */
		HELD,
		/** {@code txn.json} failed to load this session: every op is refused up front (JOURNAL_UNAVAILABLE). */
		UNAVAILABLE
	}

	public record Started(Begin status, @Nullable TxnEntry entry, ResultCache.@Nullable Done done, @Nullable String detail) {
	}

	/** Where a drive stopped. */
	public enum Status {
		/** Retired and in the result cache. */
		DONE,
		/** RETIRING: waiting for its persisted awaits. */
		RETIRING,
		/** Held: an UNKNOWN probe, an unacknowledged journal write, a refused barrier; retried each tick. */
		HELD,
		/** Quarantined for ops (§3.8). */
		QUARANTINED
	}

	/** An entry kept for ops: unparseable, an unknown kind, a newer kv, or an impossible combination. */
	public record Quarantined(String id, JsonObject raw, String why, List<String> resources) {
	}

	private final TxnEnv env;
	private final Map<String, TxnKind> kinds = new LinkedHashMap<>();
	private final Options opt;
	private final LinkedHashMap<String, TxnEntry> open = new LinkedHashMap<>();
	private final List<Quarantined> quarantined = new ArrayList<>();
	private final ResultCache cache;
	private final Holds holds = new Holds();
	private long next = 1;
	private @Nullable String loadFailed;
	/** A journal write was not acknowledged OK: nothing acts until a rewrite (or a confirm) is. */
	private boolean unsynced;

	public TxnCore(TxnEnv env) {
		this(env, Options.defaults());
	}

	public TxnCore(TxnEnv env, Options opt) {
		this.env = env;
		this.opt = opt;
		this.cache = new ResultCache(ResultCache.MAX, opt.cacheAborted);
	}

	public TxnCore register(TxnKind k) {
		kinds.put(k.name(), k);
		return this;
	}

	public Holds holds() {
		return holds;
	}

	public ResultCache cache() {
		return cache;
	}

	public @Nullable String loadFailed() {
		return loadFailed;
	}

	public boolean unsynced() {
		return unsynced;
	}

	/**
	 * (slice T4R-N, the final check of f7607b13's P2) Whether every in-memory state of the open txns is the acknowledged {@code txn.json}'s: no
	 * write refused or in doubt since the last acknowledged one. Each decision is written ({@code sync}) as it is made, so while this holds an
	 * open txn's decision is on disk; while it does not, a decision may be in memory only (a crash loads the txn undecided).
	 */
	public boolean acknowledged() {
		return !journalDoubt();
	}

	/** The open (and retiring) txns, oldest first. */
	public List<TxnEntry> open() {
		return List.copyOf(open.values());
	}

	public @Nullable TxnEntry get(String id) {
		return open.get(id);
	}

	public List<Quarantined> quarantined() {
		return List.copyOf(quarantined);
	}

	/** Whether any txn is open, retiring or quarantined (the participant files' FORMAT + 1 net, §3.3). */
	public boolean anyOpen() {
		return !open.isEmpty() || !quarantined.isEmpty();
	}

	// ------------------------------------------------------------------ load (§3.6 "load is split from reconcile", §3.8)

	/**
	 * Loads {@code txn.json} ({@code doc} null: no file) and rebuilds the holds; runs nothing. {@code failure} (the file could not be read
	 * or parsed) and a newer format fail closed: every begin answers UNAVAILABLE. An entry that fails validation, has an unknown kind or a
	 * newer {@code kv} is quarantined with its resources held; the others load.
	 */
	public void load(@Nullable JsonObject doc, @Nullable String failure) {
		open.clear();
		quarantined.clear();
		holds.clear();
		cache.load(null);
		next = 1;
		unsynced = false;
		loadFailed = failure;
		if (failure != null || doc == null) {
			return;
		}
		try {
			int fmt = doc.get("format").getAsInt();
			if (fmt > FORMAT) {
				loadFailed = "txn.json format " + fmt + " was written by a newer Architect (this one reads up to " + FORMAT + ")";
				return;
			}
			next = Math.max(1, doc.get("next").getAsLong());
			for (String part : new String[] {"open", "retiring"}) {
				if (doc.get(part) instanceof JsonArray a) {
					for (JsonElement e : a) {
						loadEntry(e);
					}
				}
			}
			if (doc.get("done") instanceof JsonArray d) {
				cache.load(d);
			}
		} catch (RuntimeException e) {
			open.clear();
			quarantined.clear();
			holds.clear();
			loadFailed = "txn.json unreadable: " + e;
		}
	}

	private void loadEntry(JsonElement e) {
		JsonObject raw = e.isJsonObject() ? e.getAsJsonObject() : new JsonObject();
		String id = raw.has("id") ? raw.get("id").getAsString() : "?";
		List<String> res = new ArrayList<>();
		if (raw.get("resources") instanceof JsonArray a) {
			a.forEach(x -> res.add(x.getAsString()));
		}
		try {
			if (opt.phaseOnlySchema && raw.get("decision") != null && raw.get("decision").isJsonNull() && "EFFECTS_DONE".equals(raw.has("phase") ? raw
				.get("phase").getAsString() : "")) {
				raw = raw.deepCopy();
				raw.addProperty("phase", "PREPARED_DONE"); // the naive schema: EFFECTS_DONE overwrote COMMITTED, read as "not committed"
			}
			TxnEntry t = TxnEntry.fromJson(raw);
			TxnKind k = kinds.get(t.kind);
			if (k == null) {
				throw new TxnEntry.Invalid(id + ": unknown kind " + t.kind);
			}
			if (t.kv > k.kv()) {
				throw new TxnEntry.Invalid(id + ": kv " + t.kv + " is newer than this build's " + k.kv());
			}
			if (!t.decider.equals(k.decider())) {
				throw new TxnEntry.Invalid(id + ": decider " + t.decider + " is not the kind's " + k.decider());
			}
			for (Effect f : t.effects) {
				TxnKind.Adapter a = adapterOf(k, f);
				if (a == null) {
					throw new TxnEntry.Invalid(id + ": no adapter for " + f.op());
				}
				String bad = invalid(a, f);
				if (bad != null) {
					throw new TxnEntry.Invalid(id + ": effect " + f.i() + " (" + f.op() + "): " + bad); // T1 review P2-4: quarantined, never thrown
				}
			}
			open.put(t.id, t);
			holds.hold(t);
		} catch (TxnEntry.Invalid ex) {
			quarantine(id, raw, ex.getMessage(), res);
		}
	}

	private static @Nullable String invalid(TxnKind.Adapter a, Effect f) {
		try {
			return a.invalid(f);
		} catch (RuntimeException e) {
			return "its fields can't be read: " + e;
		}
	}

	private void quarantine(String id, JsonObject raw, String why, List<String> resources) {
		quarantined.add(new Quarantined(id, raw, why, List.copyOf(resources)));
		TxnEntry h = new TxnEntry(TxnEntry.ID.matcher(id).matches() ? id : "tx-0", "quarantined", 1, null, 0, 0, null, resources, "txn");
		h.held = "quarantined: " + why;
		holds.hold(h);
	}

	/**
	 * (slice T3b, Noah's decision 3) A state no kind can finish safely, held for ops: a quarantined entry of {@code kind} (no kind of that
	 * name is registered, so a load quarantines it again) over {@code resources}, written to {@code txn.json} at once. Its resources stay
	 * held, indefinitely, until ops removes it. Refused (null) when the journal failed to load or a resource is held already; else the new
	 * id (the write's outcome is the journal's: a refused or in-doubt write leaves the core unsynced and the hold in memory).
	 */
	public @Nullable String holdForOps(String kind, List<String> resources, String why) {
		if (loadFailed != null || holds.refusal(resources) != null || kinds.containsKey(kind)) {
			return null;
		}
		String id = "tx-" + next++;
		JsonObject raw = new JsonObject();
		raw.addProperty("id", id);
		raw.addProperty("kind", kind);
		raw.addProperty("kv", 1);
		JsonArray rs = new JsonArray();
		resources.forEach(rs::add);
		raw.add("resources", rs);
		raw.addProperty("why", why);
		raw.addProperty("at", env.wall());
		quarantine(id, raw, "held for ops: " + why, resources);
		DurableFile.Outcome o = env.store().write(toJson());
		if (o != DurableFile.Outcome.OK) {
			unsynced = true;
		}
		return id;
	}

	// ------------------------------------------------------------------ begin, plan, persist (R-1, R-2)

	/**
	 * Begins an attempt of {@code kindName} over {@code resources}. With a dedupe {@code key}: an open txn holding it is attached to, a
	 * committed result replayed; an aborted attempt never answers it (a fresh attempt). A held resource refuses with {@code held(other)}.
	 * A NEW entry is not open yet: plan it, then {@link #persist}.
	 */
	public Started begin(String kindName, @Nullable String key, List<String> resources, @Nullable String who) {
		if (loadFailed != null) {
			return new Started(Begin.UNAVAILABLE, null, null, loadFailed);
		}
		TxnKind k = kinds.get(kindName);
		if (k == null) {
			throw new IllegalArgumentException("unknown txn kind " + kindName);
		}
		if (key != null) {
			for (TxnEntry t : open.values()) {
				if (key.equals(t.key) && t.kind.equals(kindName)) {
					return new Started(Begin.ATTACHED, t, null, t.held == null ? null : Holds.decided(t));
				}
			}
			ResultCache.Done d = cache.committed(key);
			if (d != null) {
				return new Started(Begin.REPLAYED, null, d, null);
			}
		}
		String why = holds.refusal(resources);
		if (why != null) {
			return new Started(Begin.HELD, null, null, why);
		}
		TxnEntry t = new TxnEntry("tx-" + next++, kindName, k.kv(), key, env.tick(), env.wall(), who, resources, k.decider());
		t.live = true;
		return new Started(Begin.NEW, t, null, null);
	}

	/** R-1: adds one planned effect (every amount) to a NEW entry. */
	public Effect plan(TxnEntry t, Effect.Builder b) {
		requireUnpersisted(t);
		Effect e = b.build(t.effects.size());
		t.effects.add(e);
		return e;
	}

	/** R-1 (round 4): an event's immutable source data, captured while planning, persisted with the intent. */
	public void payload(TxnEntry t, String event, JsonObject data) {
		requireUnpersisted(t);
		t.payloads.add(event, data.deepCopy());
	}

	private void requireUnpersisted(TxnEntry t) {
		if (t.persisted || open.containsKey(t.id)) {
			throw new IllegalStateException(t.id + " is persisted: its plan is fixed");
		}
	}

	/**
	 * R-2: the intent made durable before any effect. OK: open and held. REFUSED: nothing touched, nothing open (the caller answers
	 * JOURNAL_UNAVAILABLE). IN_DOUBT: the intent may be on disk, so it stays open, held, and nothing runs until the file is confirmed.
	 */
	public DurableFile.Outcome persist(TxnEntry t) {
		requireUnpersisted(t);
		if (t.effects.isEmpty()) {
			throw new IllegalStateException(t.id + ": nothing planned");
		}
		TxnKind k = kinds.get(t.kind);
		if ("journal".equals(t.decider) && t.dEffect() == null) {
			throw new IllegalStateException(t.id + ": a journal-decided kind plans its D effect");
		}
		for (Effect f : t.effects) {
			TxnKind.Adapter a = adapterOf(Objects.requireNonNull(k), f);
			if (a == null) {
				throw new IllegalStateException(t.id + ": no adapter for " + f.op());
			}
			String bad = invalid(a, f);
			if (bad != null) {
				throw new IllegalStateException(t.id + ": effect " + f.i() + " (" + f.op() + "): " + bad);
			}
		}
		if (journalDoubt() && !resync()) {
			return DurableFile.Outcome.REFUSED; // an older write is unacknowledged (or the loaded file unconfirmed): nothing goes on top of it
		}
		open.put(t.id, t);
		holds.hold(t);
		t.persisted = true;
		DurableFile.Outcome o = env.store().write(toJson());
		if (o == DurableFile.Outcome.REFUSED) {
			open.remove(t.id);
			holds.release(t);
			t.persisted = false;
			return o;
		}
		if (o == DurableFile.Outcome.IN_DOUBT) {
			unsynced = true;
			t.held = "txn.json in doubt";
			return o;
		}
		kill(t, "intent");
		return o;
	}

	// ------------------------------------------------------------------ drive: the table for forward and recovery alike

	/** Runs every open entry from its persisted state (oldest first) as recovery: never decides by inference. */
	public void recover() {
		for (TxnEntry t : open()) {
			t.live = false;
			t.held = null;
			if (open.containsKey(t.id)) {
				drive(t);
			}
		}
	}

	/** Each tick: a held or retiring entry is driven again (an UNKNOWN probe may be readable now, an await met). */
	public void tick() {
		for (TxnEntry t : open()) {
			if (open.containsKey(t.id) && (t.held != null || t.phase == Phase.RETIRING)) {
				drive(t);
			}
		}
	}

	/** (slice T3b, TEST) A drive stopped at a paused kill point ({@link TxnEnv#pauseAt}). */
	private static final class Paused extends RuntimeException {
		Paused() {
			super(null, null, false, false);
		}
	}

	/** Drives one entry as far as it can go now. */
	public Status drive(TxnEntry t) {
		String was = drivingKind;
		drivingKind = t.kind;
		try {
			return drive0(t);
		} finally {
			drivingKind = was;
		}
	}

	/** (TEST seam, slice T4R-M hooks: dev.txn.failBarrier {kind}) The kind of the txn a drive is driving now, or null. */
	private @Nullable String drivingKind;

	public @Nullable String drivingKind() {
		return drivingKind;
	}

	private Status drive0(TxnEntry t) {
		TxnKind k = kinds.get(t.kind);
		if (k == null) {
			return Status.QUARANTINED;
		}
		if (t.paused != null) {
			if (env.pauseAt(t.paused)) {
				return hold(t, "paused at " + t.paused + " (dev.txn.pauseAt)", null);
			}
			t.paused = null;
		}
		boolean was = driving;
		driving = true;
		try {
			return drive0(k, t);
		} catch (Paused p) {
			return hold(t, "paused at " + t.paused + " (dev.txn.pauseAt)", null);
		} finally {
			driving = was;
		}
	}

	/** Whether a drive runs now (a pause only stops a drive, never a persist). */
	private boolean driving;

	private Status drive0(TxnKind k, TxnEntry t) {
		for (int guard = 0; guard < 64; guard++) {
			if (!open.containsKey(t.id)) {
				return Status.DONE;
			}
			if (journalDoubt() && !resync()) {
				return hold(t, "txn.json not acknowledged (an IN_DOUBT write, or a loaded file whose re-force did not return)", null);
			}
			t.held = null;
			t.heldAt = null;
			Probe dp = null;
			Effect d = t.dEffect();
			if (t.decision == null && d != null) {
				dp = probe(k, t, d);
			}
			Action a = opt.rules.next(t.decision, t.phase, dp, t.live);
			switch (a) {
				case PREPARE -> {
					if (!prepare(k, t)) {
						return Status.HELD;
					}
				}
				case DECIDE -> {
					if (!k.commitAfterPrepare(t)) {
						if (!beginAbort(k, t)) {
							return Status.HELD;
						}
					} else if (d != null) {
						if (!applyIfAbsent(k, t, d)) {
							return Status.HELD;
						}
					} else {
						t.decision = Decision.commit();
						if (!sync(t)) {
							return Status.HELD;
						}
						kill(t, "decided");
					}
				}
				case ADOPT_COMMIT -> {
					t.decision = Decision.commit();
					t.phase = Phase.PREPARED_DONE; // a D effect runs only after PREPARED_DONE was acknowledged
					if (!sync(t)) {
						return Status.HELD;
					}
					kill(t, "decided");
				}
				case ABORT -> {
					if (!beginAbort(k, t)) {
						return Status.HELD;
					}
				}
				case REDO -> {
					if (!redo(k, t, null)) {
						return Status.HELD;
					}
				}
				case SPLIT -> {
					if (!redo(k, t, Objects.requireNonNull(t.decision).written())) {
						return Status.HELD;
					}
				}
				case FINISH -> {
					if (!fire(t, false)) {
						return hold(t, "events pending delivery", null);
					}
					t.phase = Phase.RETIRING;
					if (!sync(t)) {
						return Status.HELD;
					}
					kill(t, "retiring");
				}
				case COMPENSATE -> {
					if (!compensate(k, t, null)) {
						return Status.HELD;
					}
					TxnEnv.Barrier b = env.barrier();
					kill(t, "barrier:abort");
					if (!b.ok()) {
						return hold(t, "barrier refused: " + b.reason(), null);
					}
					if (!fire(t, true)) {
						return hold(t, "events pending delivery", null);
					}
					t.awaits.clear();
					t.awaits.addAll(b.awaits());
					t.phase = Phase.RETIRING;
					if (!sync(t)) {
						return Status.HELD;
					}
					kill(t, "retiring");
				}
				case AWAIT -> {
					boolean met = true;
					for (Await w : t.awaits) {
						met &= env.satisfied(w);
					}
					if (!met) {
						if (!Objects.requireNonNull(t.decision).isAbort() && lost(k, t)) {
							t.phase = Phase.PREPARED_DONE; // a power loss took back an effect its await covered: redo it (still committed)
							continue;
						}
						return Status.RETIRING;
					}
					retire(t);
					if (!sync(t)) {
						return Status.HELD;
					}
					kill(t, "done");
					return Status.DONE;
				}
				case HOLD -> {
					return hold(t, "decision unknown (its D effect can't be read or is in doubt)", d == null ? null : where(k, t, d));
				}
				case QUARANTINE -> {
					open.remove(t.id);
					holds.release(t);
					quarantine(t.id, t.toJson(), "impossible: decision " + (t.decision == null ? "null" : t.decision.v()) + " with phase " + t.phase,
						t.resources);
					sync(t);
					return Status.QUARANTINED;
				}
			}
		}
		return hold(t, "no progress after 64 steps", null);
	}

	/** Forward: each prepare effect (probe first), the barrier covering them (R-4c), then PREPARED_DONE acknowledged. */
	private boolean prepare(TxnKind k, TxnEntry t) {
		for (Effect e : t.effects) {
			if (!e.prepare()) {
				continue;
			}
			Probe p = probe(k, t, e);
			if (p == Probe.UNKNOWN) {
				hold(t, "prepare effect " + e.i() + " unknown", where(k, t, e));
				return false;
			}
			if (p == Probe.COMPENSATED) {
				return beginAbort(k, t); // undone already: this attempt can't go forward
			}
			if (p == Probe.ABSENT) {
				try {
					Objects.requireNonNull(adapterOf(k, e)).apply(t, e);
				} catch (RuntimeException ex) {
					t.result.addProperty("refused", "effect " + e.i() + ": " + ex.getMessage());
					return beginAbort(k, t); // a prepare effect refused: abort before the decision
				}
				kill(t, "apply:" + e.i());
			}
		}
		TxnEnv.Barrier b = env.barrier();
		kill(t, "barrier:prepare");
		if (!b.ok()) {
			t.result.addProperty("refused", "barrier: " + b.reason());
			return beginAbort(k, t); // a refused save before the decision aborts (§4.1 "both branches")
		}
		t.phase = Phase.PREPARED_DONE;
		if (!sync(t)) {
			return false;
		}
		kill(t, "prepared");
		return true;
	}

	/**
	 * After a commit (or an abandon's split): every effect not APPLIED, in plan order (W before credits), stopping at an UNKNOWN one; the
	 * unwritten members of a split compensate. Then the barrier covering them and EFFECTS_DONE with its result and awaits.
	 */
	private boolean redo(TxnKind k, TxnEntry t, java.util.@Nullable Set<String> written) {
		if (written != null && !compensate(k, t, written)) {
			return false;
		}
		for (Effect e : t.effects) {
			if (e.prepare() && !opt.redoPrepare || e.cls() == EffectClass.D || written != null && e.member() != null && !written.contains(e.member())) {
				continue;
			}
			if (BARRIER.equals(e.op())) {
				// (slice T4R) a member barrier: what was applied since the previous passed barrier (in any drive of this session: a refused
				// barrier leaves it owed, whatever redos come after) made durable before anything after it. (fix round, P1-2) the debt is the
				// entry's, never this drive's: an effect applied earlier and only probed APPLIED now still needs its barrier
				if (t.dirty) {
					TxnEnv.Barrier mb = env.barrier();
					kill(t, "barrier:member");
					if (!mb.ok()) {
						hold(t, "barrier refused: " + mb.reason(), null); // after the decision: never compensated, retried
						return false;
					}
					t.dirty = false;
				}
				t.passed = Math.max(t.passed, e.i());
				continue;
			}
			if (!applyIfAbsent(k, t, e)) {
				return false;
			}
		}
		TxnEnv.Barrier b = env.barrier();
		kill(t, "barrier:effects");
		if (!b.ok()) {
			hold(t, "barrier refused: " + b.reason(), null); // after the decision: never compensated, retried
			return false;
		}
		t.dirty = false;
		t.awaits.clear();
		t.awaits.addAll(b.awaits());
		t.result = k.result(t);
		t.phase = Phase.EFFECTS_DONE;
		if (!sync(t)) {
			return false;
		}
		kill(t, "effects");
		return true;
	}

	/** Compensates every applied prepare effect, newest first (all of them, or an abandon's unwritten members' only). */
	private boolean compensate(TxnKind k, TxnEntry t, java.util.@Nullable Set<String> keep) {
		for (int i = t.effects.size() - 1; i >= 0; i--) {
			Effect e = t.effects.get(i);
			if (!e.prepare() || keep != null && (e.member() == null || keep.contains(e.member()))) {
				continue;
			}
			Probe p = probe(k, t, e);
			if (p == Probe.UNKNOWN) {
				hold(t, "compensation of effect " + e.i() + " unknown", where(k, t, e));
				return false;
			}
			if (p == Probe.APPLIED) {
				try {
					Objects.requireNonNull(adapterOf(k, e)).compensate(t, e);
				} catch (RuntimeException ex) {
					hold(t, "compensation of effect " + e.i() + " refused: " + ex.getMessage(), where(k, t, e));
					return false;
				}
				kill(t, "comp:" + e.i());
			}
		}
		return true;
	}

	/** Whether a committed effect reads ABSENT again (its store lost an unconfirmed write: the IN_DOUBT → restart → power loss case). */
	private boolean lost(TxnKind k, TxnEntry t) {
		java.util.Set<String> written = Objects.requireNonNull(t.decision).written();
		for (Effect e : t.effects) {
			if (e.prepare() || e.cls() == EffectClass.D || written != null && e.member() != null && !written.contains(e.member())) {
				continue;
			}
			if (probe(k, t, e) == Probe.ABSENT) {
				return true;
			}
		}
		return false;
	}

	/** Writes {@code decision: abort} with ABORTING and the abort's own payload, in one acknowledged write. */
	private boolean beginAbort(TxnKind k, TxnEntry t) {
		if (t.decision != null) {
			throw new IllegalStateException(t.id + ": the decision " + t.decision.v() + " is immutable");
		}
		t.decision = Decision.abort();
		t.phase = Phase.ABORTING;
		JsonObject ap = k.abortPayload(t);
		if (ap != null) {
			t.payloads.add("abort:batch_done", ap);
		}
		if (!sync(t)) {
			return false;
		}
		kill(t, "aborting");
		return true;
	}

	/** Probes, then applies when ABSENT; UNKNOWN holds; a post-decision effect that refuses holds (never compensated). */
	private boolean applyIfAbsent(TxnKind k, TxnEntry t, Effect e) {
		Probe p = probe(k, t, e);
		if (p == Probe.APPLIED) {
			return true;
		}
		if (p == Probe.UNKNOWN || p == Probe.COMPENSATED) {
			hold(t, "effect " + e.i() + " " + p.name().toLowerCase(java.util.Locale.ROOT), where(k, t, e));
			return false;
		}
		try {
			Objects.requireNonNull(adapterOf(k, e)).apply(t, e);
		} catch (RuntimeException ex) {
			hold(t, "effect " + e.i() + " refused: " + ex.getMessage(), where(k, t, e));
			return false;
		}
		t.dirty = true; // (slice T4R fix round, P1-2) a member barrier owed until one passes
		kill(t, "apply:" + e.i());
		return true;
	}

	/**
	 * Fires every payload event not yet emitted: the commit's (the planned ones) or the abort's ({@code abort:*}) only. An event counts as
	 * emitted only once the env reports it delivered (T1 review P2-3): one queued for a later tick holds the txn, and a crash before its
	 * delivery fires it again (at least once). False while any is pending.
	 */
	private boolean fire(TxnEntry t, boolean aborted) {
		boolean all = true;
		for (var e : t.payloads.entrySet()) {
			String name = e.getKey();
			if (name.startsWith("abort:") != aborted || t.emitted.contains(name) || !e.getValue().isJsonObject()) {
				continue;
			}
			if (!env.emit(t, aborted ? name.substring("abort:".length()) : name, e.getValue().getAsJsonObject(), !t.live) && !opt.emittedOnQueue) {
				all = false;
				continue;
			}
			kill(t, "emit:" + name);
			t.emitted.add(name);
		}
		return all;
	}

	private void retire(TxnEntry t) {
		JsonObject left = new JsonObject();
		for (var e : t.payloads.entrySet()) {
			if (!t.emitted.contains(e.getKey())) {
				left.add(e.getKey(), e.getValue());
			}
		}
		open.remove(t.id);
		holds.release(t);
		cache.add(new ResultCache.Done(t.id, t.key, Objects.requireNonNull(t.decision).v(), t.result, left));
	}

	/** (§5.2) An effect's probe for the conservation check (UNKNOWN when its store can't be read now). */
	public Probe probeFor(TxnEntry t, Effect e) {
		TxnKind k = kinds.get(t.kind);
		return k == null ? Probe.UNKNOWN : probe(k, t, e);
	}

	private Probe probe(TxnKind k, TxnEntry t, Effect e) {
		try {
			return Objects.requireNonNull(adapterOf(k, e)).probe(t, e);
		} catch (RuntimeException ex) {
			return Probe.UNKNOWN;
		}
	}

	private static String where(TxnKind k, TxnEntry t, Effect e) {
		TxnKind.Adapter a = adapterOf(k, e);
		try {
			return a == null ? e.op() : a.where(t, e);
		} catch (RuntimeException ex) {
			return e.op() + " (effect " + e.i() + ")";
		}
	}

	/** Whether the journal is not known durable: an unacknowledged write, or the store in doubt (a load whose re-force did not return). */
	private boolean journalDoubt() {
		return unsynced || !opt.ignoreStoreDoubt && env.store().inDoubt();
	}

	private Status hold(TxnEntry t, String why, @Nullable String at) {
		t.held = why;
		t.heldAt = at;
		return Status.HELD;
	}

	/** Writes the journal; OK continues; otherwise the core is unsynced and the entry held until a rewrite is acknowledged. */
	private boolean sync(TxnEntry t) {
		DurableFile.Outcome o = env.store().write(toJson());
		if (o == DurableFile.Outcome.OK) {
			unsynced = false;
			return true;
		}
		unsynced = true;
		hold(t, o == DurableFile.Outcome.IN_DOUBT ? "txn.json in doubt" : "txn.json write refused", null);
		return false;
	}

	/** An unacknowledged journal: an IN_DOUBT installation re-confirmed, else the whole file written again. */
	private boolean resync() {
		DurableFile.Outcome o = env.store().inDoubt() ? env.store().confirm() : env.store().write(toJson());
		if (o == DurableFile.Outcome.OK && env.store().inDoubt()) {
			o = env.store().write(toJson());
		}
		if (o == DurableFile.Outcome.OK) {
			unsynced = false;
			return true;
		}
		return false;
	}

	private void kill(TxnEntry t, String step) {
		String point = KillPoints.name(t.kind, !t.live, step);
		KillPoints.reached(t.kind, point);
		env.kill(point);
		String alias = KillPoints.alias(t.kind);
		if (alias != null) {
			// (slice T4b) a removal's settle answers T2b's crate.settle points too (Steward's and the gates' names keep working)
			String ap = KillPoints.name(alias, !t.live, step);
			KillPoints.reached(alias, ap);
			env.kill(ap);
		}
		TxnKind k = kinds.get(t.kind);
		String legacy = k == null || !t.live ? null : k.alias(t, step);
		if (legacy != null) {
			env.kill(legacy); // (slice T3b) a legacy name of the same point (pile.adopt's SAC1, SAC2)
		}
		if (driving && env.pauseAt(point)) {
			t.paused = point;
			throw new Paused(); // (TEST dev.txn.pauseAt) everything before this point is done and synced: the drive stops here, the txn held
		}
	}

	// ------------------------------------------------------------------ ops (§3.6 "The ops command")

	/**
	 * {@code /architect txn resolve <id> commit|abort} (dev hook in T1). {@code abort} is refused once a decision exists or its D effect
	 * probes APPLIED or UNKNOWN (an external commit always wins); {@code commit} only from PREPARED_DONE (prepare effects known applied).
	 * Answers null when done, else why it was refused.
	 */
	public @Nullable String resolve(String id, String how) {
		TxnEntry t = open.get(id);
		if (t == null) {
			return "no open txn " + id;
		}
		TxnKind k = Objects.requireNonNull(kinds.get(t.kind));
		Effect d = t.dEffect();
		Probe dp = d == null ? null : probe(k, t, d);
		if (t.decision != null) {
			return id + " is decided (" + t.decision.v() + "): its decision is immutable";
		}
		if ("abort".equals(how)) {
			if (dp == Probe.APPLIED || dp == Probe.UNKNOWN) {
				return id + ": its decision probe is " + dp + "; an external commit always wins";
			}
			if (!beginAbort(k, t)) {
				return id + ": the abort could not be written";
			}
		} else if ("commit".equals(how)) {
			if (t.phase != Phase.PREPARED_DONE) {
				return id + ": its prepare effects are not known applied (phase " + t.phase + ")";
			}
			if (d != null) {
				if (!applyIfAbsent(k, t, d)) {
					return id + ": its D effect could not be applied";
				}
			} else {
				t.decision = Decision.commit();
				if (!sync(t)) {
					return id + ": the commit could not be written";
				}
			}
		} else {
			return "resolve takes commit or abort";
		}
		drive(t);
		return null;
	}

	// ------------------------------------------------------------------ JSON

	/** The whole journal: format, next, open (with quarantined entries kept raw for ops), retiring, done. */
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("format", FORMAT);
		o.addProperty("next", next);
		JsonArray op = new JsonArray();
		JsonArray rt = new JsonArray();
		for (TxnEntry t : open.values()) {
			JsonObject j = t.toJson();
			if (opt.phaseOnlySchema && t.decision != null && t.decision.isCommit() && t.phase != Phase.PREPARED_DONE) {
				j.add("decision", com.google.gson.JsonNull.INSTANCE); // the naive one-field schema: progress overwrote COMMITTED
			}
			(t.phase == Phase.RETIRING ? rt : op).add(j);
		}
		quarantined.forEach(q -> op.add(q.raw().deepCopy()));
		o.add("open", op);
		o.add("retiring", rt);
		o.add("done", cache.toJson());
		return o;
	}

	/** dev.txn.state: open entries, phases, decisions, holds, quarantine, the cache size, the load state. */
	public JsonObject state() {
		JsonObject o = new JsonObject();
		o.addProperty("loadFailed", loadFailed);
		o.addProperty("unsynced", unsynced);
		o.addProperty("next", next);
		JsonArray op = new JsonArray();
		int held = 0;
		for (TxnEntry t : open.values()) {
			JsonObject j = new JsonObject();
			j.addProperty("id", t.id);
			j.addProperty("kind", t.kind);
			j.addProperty("phase", t.phase.name());
			j.addProperty("decision", t.decision == null ? null : t.decision.v());
			j.addProperty("held", t.held);
			j.addProperty("heldAt", t.heldAt);
			JsonArray rs = new JsonArray();
			t.resources.forEach(rs::add);
			j.add("resources", rs);
			op.add(j);
			held += t.held != null ? 1 : 0;
		}
		o.add("open", op);
		o.addProperty("openCount", open.size());
		o.addProperty("heldCount", held);
		JsonArray q = new JsonArray();
		quarantined.forEach(x -> {
			JsonObject j = new JsonObject();
			j.addProperty("id", x.id());
			j.addProperty("why", x.why());
			q.add(j);
		});
		o.add("quarantined", q);
		o.addProperty("done", cache.size());
		return o;
	}
}
