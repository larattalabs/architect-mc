package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.DurableFile.Outcome;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Consumer;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §4.1) The unit-level crash harness: every participant is an independent store with its own persisted
 * versions (an asynchronous save is just another version), writes can be refused or left IN_DOUBT, probes can go UNKNOWN, and the world can
 * crash (process: the page cache kept) or lose power (only forced versions survive). It drives the production {@link TxnCore} and its
 * {@link TxnRecovery} table through model adapters; nothing here re-implements recovery.
 *
 * <p>{@link #explore} crashes at every kill point, picks every combination of the participants' persisted versions, reloads, crashes the
 * recovery itself at each of its own points (to depth {@code depth}), then settles and checks the conservation equation (§5), exactly
 * once, liveness and the scenario's own checks. Exhaustive up to {@link #EXHAUSTIVE} schedules, then a seeded sample (the seed printed).
 *
 * <p>{@link Naive} switches each reviewed counterexample's broken behaviour back on (the model's T0 primitives, or one of TxnCore's TEST
 * seams), so every counterexample is shown failing first, then passing.
 */
final class TxnCrashModel {
	static final int EXHAUSTIVE = 200_000;

	/** The reviewed counterexamples' broken behaviours (TXN-gpt2/3/4.log), and NONE (as built). */
	enum Naive {
		NONE,
		/** gpt2 P1-1: the barrier acknowledges only the txn's own chunks but publishes the whole ledger. */
		BARRIER_SCOPE,
		/** gpt2 P1-2, gpt3 P1-3: a failed player replace (old .dat kept) is acknowledged by forcing whichever file exists. */
		PLAYER_ACK,
		/** gpt2 P1-4: receipts in the BE (a restore deletes them) and no PREPARED_DONE boundary. */
		BE_MARKER,
		/** gpt2 P1-5: a decision whose write is IN_DOUBT is read as not committed (JournalStore.fail's revert) and unwound. */
		INDOUBT_ABSENT,
		/** gpt2 P1-3, gpt3 P1-1: a generation loaded at start counts as durable without the load's re-force. */
		LOADED_GEN,
		/** gpt3 P1-2: one progress field; EFFECTS_DONE overwrote COMMITTED, so a committed txn reads as undecided. */
		PHASE_ONLY,
		/** gpt3 P1-2: an abandon's recorded split ignored (the generic forward loop). */
		SPLIT_IGNORED,
		/** gpt4 P1-1: a folder created in an earlier session is taken as durable because it exists. */
		ANCESTOR_DIR,
		/** gpt4 P1-2: a reconnect's disk-loaded player replaces the owed (failed logout) snapshot. */
		LOGIN_SNAPSHOT,
		/** gpt3 P2-5: a failed chunk serialization is recorded owed but never re-dirtied (tryMarkSaved ran first). */
		CHUNK_DEBT_NO_RETRY,
		/** gpt4 P2-3: event payloads captured at EFFECTS_DONE, after record.drop removed their source. */
		PAYLOAD_LATE,
		/** gpt4 P2-4: an aborted attempt's result answers its dedupe key. */
		CACHE_ABORTED,
		/** §4.1 legacy kinds: today's path with no journal (CXD's crate take before any record). */
		NO_JOURNAL,
		/** T1 review P1-1: recovery acts on a loaded journal whose re-force did not return. */
		STORE_DOUBT_IGNORED,
		/** T1 review P2-3: an event queued for a later tick counts as emitted before it is delivered. */
		EMIT_ON_QUEUE,
		/** T1 review P2-7: a marker that never reads APPLIED (and no PREPARED_DONE boundary): effects applied twice. */
		NO_MARKER
	}

	/** A crash: thrown at the armed kill point. */
	static final class Crash extends RuntimeException {
		Crash(String at) {
			super(at, null, false, false);
		}
	}

	// ------------------------------------------------------------------ stores

	/** One participant. {@code durableFile}: written through DurableFile (power loss keeps only its forced version). */
	static final class Store {
		final String name;
		final boolean async;
		final boolean durableFile;
		JsonObject mem;
		JsonObject disk;
		long diskGen;
		JsonObject durable;
		long durableGen;
		/** In-memory states since the last explicit write: what an asynchronous save could have persisted. */
		List<JsonObject> asyncSince = new ArrayList<>();
		/** Injections: the next explicit writes refused / left in doubt / their confirm failing. */
		int failWrites;
		int doubtWrites;
		int confirmFails;
		/** Players: the next saves fail silently (the old .dat kept, Util.safeReplaceFile's discarded boolean). */
		int silentFails;
		/** Injection: the write with this 1-based number (counted per store) renames but its folder force fails (IN_DOUBT). */
		int doubtAt;
		int writes;

		Store(String name, boolean async, boolean durableFile, JsonObject init) {
			this.name = name;
			this.async = async;
			this.durableFile = durableFile;
			mem = init.deepCopy();
			disk = init.deepCopy();
			durable = init.deepCopy();
		}

		Store copy() {
			Store s = new Store(name, async, durableFile, mem);
			s.disk = disk.deepCopy();
			s.diskGen = diskGen;
			s.durable = durable.deepCopy();
			s.durableGen = durableGen;
			asyncSince.forEach(x -> s.asyncSince.add(x.deepCopy()));
			s.failWrites = failWrites;
			s.doubtWrites = doubtWrites;
			s.confirmFails = confirmFails;
			s.silentFails = silentFails;
			s.doubtAt = doubtAt;
			s.writes = writes;
			return s;
		}

		void set(JsonObject s) {
			mem = s.deepCopy();
			if (async) {
				asyncSince.add(mem.deepCopy());
			}
		}

		JsonObject edit() {
			return mem.deepCopy();
		}

		Outcome save() {
			if (failWrites > 0) {
				failWrites--;
				return Outcome.REFUSED;
			}
			disk = mem.deepCopy();
			diskGen++;
			asyncSince.clear();
			writes++;
			if (doubtWrites > 0 || writes == doubtAt) {
				doubtWrites = Math.max(0, doubtWrites - 1);
				return Outcome.IN_DOUBT;
			}
			durable = disk.deepCopy();
			durableGen = diskGen;
			return Outcome.OK;
		}

		boolean confirm() {
			if (confirmFails > 0) {
				confirmFails--;
				return false;
			}
			durable = disk.deepCopy();
			durableGen = diskGen;
			return true;
		}

		boolean inDoubt() {
			return durableGen < diskGen;
		}

		/** A process crash: the installed file (the page cache kept), or any later in-memory state an asynchronous save captured. */
		List<JsonObject> candidates() {
			List<JsonObject> c = new ArrayList<>();
			c.add(disk);
			c.addAll(asyncSince);
			return c;
		}
	}

	// ------------------------------------------------------------------ the world

	final class World {
		final Map<String, Store> stores = new LinkedHashMap<>();
		final Naive naive;
		final List<String> events = new ArrayList<>();
		final List<String> notes = new ArrayList<>();
		TxnCore core;
		int kills;
		int crashAt = Integer.MAX_VALUE;
		@Nullable String crashedAt;
		/** The architect folder's entry in the world folder is durable (gpt4 P1-1); a power loss without it loses txn.json and the ledger. */
		boolean dirEntryDurable = true;
		/** The folder exists on disk (created this session or an earlier one). */
		boolean dirExists = true;
		/** This session's DurableFile created the folder and still owes its entry's force (retried before every write; forgotten at a restart). */
		boolean dirOwed;
		/** Injection: the next forces of a created folder's entry fail. */
		int dirForceFails;
		/** The world just before its last load (to replay that load with a crash armed). */
		@Nullable World preLoad;
		/** Chunks whose last write failed (owed, T0's ChunkDebt), and whether each was re-dirtied for the retry. */
		final Map<String, Boolean> chunkDebt = new TreeMap<>();
		/** Players whose last save failed: the kept snapshot (T0's PlayerSaves debt). */
		final Map<String, JsonObject> playerDebt = new TreeMap<>();
		/** Chunks the next barrier's serialization fails for (once each). */
		final List<String> serializeFails = new ArrayList<>();
		/** BARRIER_SCOPE: the chunks the running txn touched (the only ones its barrier acknowledges). */
		final List<String> scope = new ArrayList<>();

		World(Naive naive) {
			this.naive = naive;
		}

		Store store(String name) {
			Store s = stores.get(name);
			if (s == null) {
				throw new IllegalArgumentException("no store " + name);
			}
			return s;
		}

		Store add(String name, boolean async, boolean durableFile, JsonObject init) {
			Store s = new Store(name, async, durableFile, init);
			stores.put(name, s);
			return s;
		}

		TxnCore.Options options() {
			TxnCore.Options o = TxnCore.Options.defaults();
			o.phaseOnlySchema = naive == Naive.PHASE_ONLY;
			o.cacheAborted = naive == Naive.CACHE_ABORTED;
			o.redoPrepare = naive == Naive.BE_MARKER || naive == Naive.NO_MARKER;
			o.ignoreStoreDoubt = naive == Naive.STORE_DOUBT_IGNORED;
			o.emittedOnQueue = naive == Naive.EMIT_ON_QUEUE;
			if (naive == Naive.SPLIT_IGNORED) {
				o.rules = (d, p, dp, live) -> d != null && d.isAbandon() ? TxnRecovery.TABLE.next(Decision.commit(), p, dp, live) : TxnRecovery.TABLE.next(
					d, p, dp, live);
			}
			return o;
		}

		/** A fresh core over this world, loaded from txn.json as it is now (in memory: its disk was just installed by a restart). */
		TxnCore newCore() {
			TxnCore c = new TxnCore(new Env(this), options());
			for (TxnKind k : kinds(this)) {
				c.register(k);
			}
			Store t = stores.get("txn");
			JsonObject doc = t == null || !t.mem.has("format") ? null : t.mem;
			c.load(doc, null);
			return c;
		}

		void kill(String point) {
			kills++;
			if (kills == crashAt) {
				crashedAt = point;
				throw new Crash(point);
			}
		}

		World copy() {
			World w = new World(naive);
			stores.forEach((k, v) -> w.stores.put(k, v.copy()));
			w.events.addAll(events);
			w.notes.addAll(notes);
			w.dirEntryDurable = dirEntryDurable;
			w.dirExists = dirExists;
			w.dirOwed = dirOwed;
			w.dirForceFails = dirForceFails;
			w.unknown.addAll(unknown);
			w.deferEvents = deferEvents;
			w.queued.addAll(queued);
			w.delivered.addAll(delivered);
			w.chunkDebt.putAll(chunkDebt);
			playerDebt.forEach((k, v) -> w.playerDebt.put(k, v.deepCopy()));
			w.serializeFails.addAll(serializeFails);
			w.scope.addAll(scope);
			return w;
		}

		/**
		 * A process crash: each store at the chosen persisted version ({@code pick[i]} indexes its {@link Store#candidates}), the in-memory
		 * state lost, the transient debts with it (offline snapshots are memory too). Then the load: a DurableFile store is re-forced (TXN)
		 * before its generation counts; LOADED_GEN trusts it as loaded.
		 */
		World restart(int[] pick) {
			World w = copy();
			int i = 0;
			for (Store s : w.stores.values()) {
				JsonObject c = s.candidates().get(pick[i++]);
				s.disk = c.deepCopy();
				s.mem = c.deepCopy();
				s.asyncSince.clear();
				if (!s.durableFile) {
					s.durable = c.deepCopy(); // vanilla stores (chunks, players): on disk is on disk; the O model covers DurableFile stores only
					s.durableGen = s.diskGen;
				}
			}
			w.playerDebt.clear();
			w.chunkDebt.clear();
			w.serializeFails.clear();
			w.scope.clear();
			w.queued.clear();
			w.delivered.clear();
			w.dirOwed = false;
			w.kills = 0;
			w.crashAt = Integer.MAX_VALUE;
			w.preLoad = w.copy();
			w.load();
			return w;
		}

		/** The start: DurableFile stores confirmed (TXN), the folder's entry confirmed (TXN), the core loaded, recovery, the legacy resolvers. */
		void load() {
			for (Store s : stores.values()) {
				if (s.durableFile && naive != Naive.LOADED_GEN) {
					s.confirm(); // T0: load re-forces the installed file and its folders before its generation counts
				} else if (s.durableFile) {
					s.durableGen = s.diskGen; // LOADED_GEN: the loaded generation trusted, nothing forced (the durable copy is still the old one)
				}
			}
			if (dirExists && !dirEntryDurable && naive != Naive.ANCESTOR_DIR) {
				dirEntryDurable = true; // T0's fix round: every ancestor entry confirmed at load, also one an earlier session created
			}
			core = newCore();
			core.recover();
			legacy(this);
		}

		/** A power loss: every DurableFile store back at its forced version; without a durable folder entry, the folder is gone. */
		World powerLoss() {
			World w = copy();
			for (Store s : w.stores.values()) {
				if (s.durableFile) {
					boolean inArchitect = !s.name.equals("journal"); // the journal sits beside the world, in its own folder
					JsonObject v = inArchitect && !w.dirEntryDurable ? new JsonObject() : s.durable;
					s.mem = v.deepCopy();
					s.disk = v.deepCopy();
					s.durable = v.deepCopy();
					s.diskGen = s.durableGen = inArchitect && !w.dirEntryDurable ? 0 : s.durableGen;
				} else {
					s.mem = s.disk.deepCopy();
				}
				s.asyncSince.clear();
			}
			if (!w.dirEntryDurable) {
				w.dirExists = false;
				w.dirEntryDurable = true;
			}
			w.playerDebt.clear();
			w.chunkDebt.clear();
			w.dirOwed = false;
			w.kills = 0;
			w.crashAt = Integer.MAX_VALUE;
			w.preLoad = w.copy();
			w.load();
			return w;
		}

		/** The load again, on this world (a rewound copy), with whatever crash is armed. */
		void reload() {
			load();
		}

		/**
		 * A DurableFile write into the architect folder: a missing folder is created and its entry forced first (T0); a force that fails
		 * refuses the write and leaves the entry owed for the next write of this session only.
		 */
		boolean folder() {
			if (!dirExists) {
				dirExists = true;
				dirEntryDurable = false;
				dirOwed = true;
			}
			if (dirOwed) {
				if (dirForceFails > 0) {
					dirForceFails--;
					return false;
				}
				dirEntryDurable = true;
				dirOwed = false;
			}
			return true;
		}

		/** Ticks until nothing changes (faults cleared first: a held txn becomes readable, an IN_DOUBT file confirms). */
		void settle() {
			for (Store s : stores.values()) {
				s.failWrites = s.doubtWrites = s.confirmFails = s.silentFails = s.doubtAt = 0;
				if (s.inDoubt()) {
					s.confirm();
				}
			}
			unknown.clear();
			for (int i = 0; i < 8 && !core.open().isEmpty(); i++) {
				tickEvents();
				core.tick();
			}
			tickEvents();
		}

		/** The game's next tick: the queued events delivered. */
		void tickEvents() {
			for (String e : List.copyOf(queued)) {
				events.add(e);
				delivered.add(e);
			}
			queued.clear();
		}

		// ---------------------------------------------------------------- the global barrier (T0's, modelled; §3.1)

		TxnEnv.Barrier barrier() {
			// players: every online player saved; a failed save owed with its snapshot; acknowledged only on its real replace result
			for (Store p : stores.values()) {
				if (!p.name.startsWith("player:")) {
					continue;
				}
				if (p.silentFails > 0) {
					p.silentFails--;
					if (naive != Naive.PLAYER_ACK) {
						playerDebt.put(p.name, p.mem.deepCopy());
						return TxnEnv.Barrier.refused("player " + p.name + ": replace failed");
					}
					continue; // PLAYER_ACK: the old .dat is forced and the save counted
				}
				p.save();
				playerDebt.remove(p.name);
			}
			for (var e : List.copyOf(playerDebt.keySet())) {
				return TxnEnv.Barrier.refused("player " + e + " owed");
			}
			// chunks: a flushed save of every one; a failed serialization owed (re-dirtied for the retry, unless CHUNK_DEBT_NO_RETRY)
			for (Store c : stores.values()) {
				if (!c.name.startsWith("chunk:")) {
					continue;
				}
				if (serializeFails.remove(c.name)) {
					chunkDebt.put(c.name, naive != Naive.CHUNK_DEBT_NO_RETRY);
					continue;
				}
				Boolean debt = chunkDebt.get(c.name);
				if (debt != null && !debt) {
					continue; // never re-dirtied: the flushed save skips a chunk marked saved, so the debt is never paid
				}
				if (c.failWrites > 0) {
					c.failWrites--;
					chunkDebt.put(c.name, true);
					continue;
				}
				c.save();
				chunkDebt.remove(c.name);
			}
			for (String c : chunkDebt.keySet()) {
				if (naive == Naive.BARRIER_SCOPE && !scope.contains(c)) {
					continue; // BARRIER_SCOPE: a chunk outside the txn is not waited for
				}
				return TxnEnv.Barrier.refused("chunk " + c + " owed");
			}
			// the ledger, through DurableFile
			Store l = stores.get("ledger");
			List<Await> aw = new ArrayList<>();
			if (l != null) {
				if (!folder()) {
					return TxnEnv.Barrier.refused("ledger: the architect folder's entry could not be forced");
				}
				Outcome o = l.save();
				if (o != Outcome.OK) {
					return TxnEnv.Barrier.refused("ledger " + o);
				}
				aw.add(new Await("ledger", l.diskGen));
			}
			for (Store s : stores.values()) {
				if (s.durableFile && !s.name.equals("txn") && !s.name.equals("ledger") && s.diskGen > 0) {
					aw.add(new Await(s.name, s.diskGen)); // a record store's installed generation: met once it is confirmed
				}
			}
			return TxnEnv.Barrier.ok(aw);
		}

		/** (gpt4 P1-2) A player logs in: the disk file loaded; an owed snapshot is restored over it (T0's fix), unless LOGIN_SNAPSHOT. */
		void login(String player) {
			Store p = store(player);
			JsonObject owed = playerDebt.get(player);
			p.set(p.disk.deepCopy());
			if (owed != null && naive != Naive.LOGIN_SNAPSHOT) {
				p.set(owed); // the kept snapshot wins over the older file; it stays owed until a save of it succeeds
			} else {
				playerDebt.remove(player); // LOGIN_SNAPSHOT: the live (disk-loaded) player supersedes the debt merely by existing
			}
		}

		/** Events re-fired by recovery are delivered on the next tick (the game's queue), not at once; a restart loses the queue. */
		boolean deferEvents;
		final List<String> queued = new ArrayList<>();
		final java.util.Set<String> delivered = new java.util.HashSet<>();

		/** Probes that read UNKNOWN until the world settles (an unloaded chunk, an offline player). */
		final Set<String> unknown = new java.util.HashSet<>();
	}

	// ------------------------------------------------------------------ the env

	static final class Env implements TxnEnv {
		final World w;

		Env(World w) {
			this.w = w;
		}

		@Override
		public TxnStore store() {
			Store t = w.stores.computeIfAbsent("txn", k -> new Store("txn", false, true, new JsonObject()));
			return new TxnStore() {
				@Override
				public Outcome write(JsonObject doc) {
					if (!w.folder()) {
						return Outcome.REFUSED;
					}
					t.set(doc);
					return t.save();
				}

				@Override
				public Outcome confirm() {
					return t.confirm() ? Outcome.OK : Outcome.IN_DOUBT;
				}

				@Override
				public boolean inDoubt() {
					return t.inDoubt();
				}
			};
		}

		@Override
		public Barrier barrier() {
			return w.barrier();
		}

		@Override
		public boolean satisfied(Await a) {
			Store s = w.stores.get(a.store());
			return s != null && s.durableGen >= a.gen();
		}

		@Override
		public void kill(String point) {
			w.kill(point);
		}

		@Override
		public boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed) {
			String line = t.id + ":" + event + ":" + payload;
			if (w.delivered.contains(line)) {
				return true;
			}
			if (replayed && w.deferEvents) {
				if (!w.queued.contains(line)) {
					w.queued.add(line); // delivered on the next tick (World.tickEvents); a crash before it loses the queue
				}
				return false;
			}
			w.events.add(line);
			w.delivered.add(line);
			return true;
		}

		@Override
		public long tick() {
			return 0;
		}

		@Override
		public long wall() {
			return 0;
		}
	}

	// ------------------------------------------------------------------ state helpers

	static Map<String, Integer> items(JsonObject s, String f) {
		Map<String, Integer> m = new TreeMap<>();
		if (s.get(f) instanceof JsonObject o) {
			o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
		}
		return m;
	}

	static void addItems(JsonObject s, String f, Map<String, Integer> it, int sign) {
		JsonObject o = s.get(f) instanceof JsonObject x ? x : new JsonObject();
		for (var e : it.entrySet()) {
			int v = (o.has(e.getKey()) ? o.get(e.getKey()).getAsInt() : 0) + sign * e.getValue();
			if (v < 0) {
				throw new IllegalStateException("not enough " + e.getKey() + " in " + f);
			}
			if (v == 0) {
				o.remove(e.getKey());
			} else {
				o.addProperty(e.getKey(), v);
			}
		}
		s.add(f, o);
	}

	static boolean has(JsonObject s, String set, String k) {
		if (s.get(set) instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e.getAsString().equals(k)) {
					return true;
				}
			}
		}
		return false;
	}

	static void put(JsonObject s, String set, String k) {
		JsonArray a = s.get(set) instanceof JsonArray x ? x : new JsonArray();
		a.add(k);
		s.add(set, a);
	}

	static JsonObject obj(Object... kv) {
		JsonObject o = new JsonObject();
		for (int i = 0; i < kv.length; i += 2) {
			Object v = kv[i + 1];
			if (v instanceof JsonElement e) {
				o.add((String) kv[i], e);
			} else if (v instanceof Number n) {
				o.addProperty((String) kv[i], n);
			} else if (v instanceof Boolean b) {
				o.addProperty((String) kv[i], b);
			} else if (v instanceof Map<?, ?> m) {
				JsonObject x = new JsonObject();
				m.forEach((a, b) -> x.addProperty((String) a, (Number) b));
				o.add((String) kv[i], x);
			} else {
				o.addProperty((String) kv[i], String.valueOf(v));
			}
		}
		return o;
	}

	static String storeOf(Effect e) {
		return e.data().get("store").getAsString();
	}

	// ------------------------------------------------------------------ the model kinds

	/** The ops, by store field: take/put (B, a container), credit/debit (L), give/ptake (P), drop (R), decide (D), restore (W). */
	static TxnKind.Adapter adapter(World w, String op) {
		return switch (op) {
			case "take", "ptake", "debit", "unowe" -> new Move(w, op, -1);
			case "put", "give", "credit", "owe" -> new Move(w, op, +1);
			case "drop" -> new Drop(w);
			case "decide" -> new Decide(w);
			case "restore" -> new Restore(w);
			default -> null;
		};
	}

	static String field(String op) {
		return switch (op) {
			case "take", "put" -> "items";
			case "debit", "credit" -> "stock";
			case "unowe", "owe" -> "owed"; // (slice T2b) the owed ledger's entries
			default -> "inv";
		};
	}

	/** Items out of (sign -1) or into (+1) a store's field, its receipt in the same atomic unit (the chunk attachment, or the BE for BE_MARKER). */
	record Move(World w, String op, int sign) implements TxnKind.Adapter {
		String receipts(Effect e) {
			return w.naive == Naive.BE_MARKER && e.cls() == EffectClass.B ? "be" : "receipts";
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("store") ? "no store" : !w.stores.containsKey(storeOf(e)) ? "no store " + storeOf(e) : e.items().isEmpty() ? "no items"
				: null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			if (w.unknown.contains(storeOf(e))) {
				return Probe.UNKNOWN;
			}
			if (w.naive == Naive.NO_MARKER) {
				return Probe.ABSENT; // the broken marker: never read
			}
			JsonObject s = w.store(storeOf(e)).mem;
			if (has(s, receipts(e), e.compKey(t.id))) {
				return Probe.COMPENSATED;
			}
			String key = e.data().has("key") ? e.data().get("key").getAsString() : e.key(t.id);
			return has(s, receipts(e), key) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			if (e.data().has("refuse") && w.notes.remove("refuse-once")) {
				throw new IllegalStateException("refused (model: a transient refusal)");
			}
			Store st = w.store(storeOf(e));
			JsonObject s = st.edit();
			addItems(s, field(op), e.items(), sign);
			put(s, receipts(e), e.data().has("key") ? e.data().get("key").getAsString() : e.key(t.id));
			st.set(s);
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			Store st = w.store(storeOf(e));
			JsonObject s = st.edit();
			addItems(s, field(op), e.items(), -sign);
			put(s, receipts(e), e.compKey(t.id));
			st.set(s);
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return storeOf(e);
		}
	}

	/** R: drops a record in a DurableFile record store (written at once); the record's absence is the probe. */
	record Drop(World w) implements TxnKind.Adapter {
		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("store") || !e.data().has("id") ? "store and id are required" : !w.stores.containsKey(storeOf(e)) ? "no store" : null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			JsonObject recs = w.store(storeOf(e)).mem.getAsJsonObject("records");
			return recs != null && recs.has(e.data().get("id").getAsString()) ? Probe.ABSENT : Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			Store st = w.store(storeOf(e));
			JsonObject s = st.edit();
			s.getAsJsonObject("records").remove(e.data().get("id").getAsString());
			st.set(s);
			if (st.save() == Outcome.REFUSED) {
				st.set(st.disk);
				throw new IllegalStateException("record store refused");
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a record drop is never a prepare effect");
		}
	}

	/** D: the journal's undo commit, {@code undoGroup = txn id}, in the journal's DurableFile index. */
	record Decide(World w) implements TxnKind.Adapter {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			Store j = w.store("journal");
			if (j.inDoubt()) {
				if (w.naive == Naive.INDOUBT_ABSENT) {
					return has(j.mem, "groups", t.id) ? Probe.APPLIED : Probe.ABSENT; // the head reverted in memory: read as not committed
				}
				return Probe.UNKNOWN; // IN_DOUBT counts as UNKNOWN (§3.4 D)
			}
			return has(j.mem, "groups", t.id) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			Store j = w.store("journal");
			JsonObject s = j.edit();
			put(s, "groups", t.id);
			j.set(s);
			Outcome o = j.save();
			if (o == Outcome.REFUSED) {
				j.set(j.disk);
				throw new IllegalStateException("journal index refused");
			}
			if (o == Outcome.IN_DOUBT && w.naive == Naive.INDOUBT_ABSENT) {
				JsonObject old = j.edit(); // JournalStore.fail (main 968): the in-memory head restored to the old index
				JsonArray g = new JsonArray();
				if (old.get("groups") instanceof JsonArray a) {
					a.forEach(x -> {
						if (!x.getAsString().equals(t.id)) {
							g.add(x);
						}
					});
				}
				old.add("groups", g);
				j.mem = old;
				w.notes.add("commit-threw");
				throw new IllegalStateException("journal commit failed (naive: read as not committed)");
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("D is never compensated");
		}
	}

	/** W: the restore of a chunk: its container's cells put back to before (whatever they hold is gone), receipted per chunk. */
	record Restore(World w) implements TxnKind.Adapter {
		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("store") || !w.stores.containsKey(storeOf(e)) ? "no store" : null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			if (w.unknown.contains(storeOf(e))) {
				return Probe.UNKNOWN;
			}
			return has(w.store(storeOf(e)).mem, "receipts", e.key(t.id) + "@restored") ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			Store st = w.store(storeOf(e));
			JsonObject s = st.edit();
			restoreChunk(s);
			put(s, "receipts", e.key(t.id) + "@restored");
			st.set(s);
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("W is never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return storeOf(e);
		}
	}

	static void restoreChunk(JsonObject s) {
		s.add("items", new JsonObject()); // the building's container is gone with what it held
		s.add("be", new JsonArray()); // its BE (and BE_MARKER's receipts) with it
		s.addProperty("restored", true);
	}

	/** A model kind: its ops' adapters over the world; {@code commitAfterPrepare} false after a naive commit threw (the legacy unwind). */
	static TxnKind kind(World w, String name, String decider) {
		return new TxnKind() {
			@Override
			public String name() {
				return name;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public String decider() {
				return decider;
			}

			@Override
			public TxnKind.Adapter adapter(Effect e) {
				return TxnCrashModel.adapter(w, e.op());
			}

			@Override
			public boolean commitAfterPrepare(TxnEntry t) {
				return !w.notes.contains("commit-threw") && !w.notes.contains("block:" + t.key);
			}

			@Override
			public JsonObject abortPayload(TxnEntry t) {
				return name.equals("removal") ? obj("batch", t.key, "placed", 0) : null;
			}

			@Override
			public JsonObject result(TxnEntry t) {
				JsonObject r = obj("removed", true);
				if (w.naive == Naive.PAYLOAD_LATE && name.equals("removal")) {
					// round 3: the SiteView captured at EFFECTS_DONE, from the sites store record.drop already emptied
					JsonObject recs = w.store("sites").mem.getAsJsonObject("records");
					JsonElement site = recs == null ? null : recs.get(t.key);
					r.add("site", site == null ? com.google.gson.JsonNull.INSTANCE : site);
				}
				return r;
			}
		};
	}

	static List<TxnKind> kinds(World w) {
		return List.of(kind(w, "move", "txn"), kind(w, "removal", "journal"), kind(w, "deposit", "txn"), kind(w, "charge", "txn"));
	}

	// ------------------------------------------------------------------ legacy resolvers (run after txn recovery, on unheld resources)

	static void legacy(World w) {
		// settle: an owed record of the queue that no txn holds is paid into the ledger (CXD's settle, PSV's decCredit)
		Store q = w.stores.get("queue");
		Store l = w.stores.get("ledger");
		if (q != null && l != null && q.mem.get("records") instanceof JsonObject recs) {
			for (String id : List.copyOf(recs.keySet())) {
				if (w.core.holds().holder("rec:" + id) != null) {
					continue;
				}
				JsonObject ls = l.edit();
				addItems(ls, "stock", items(recs.getAsJsonObject(id), "items"), +1);
				l.set(ls);
				JsonObject qs = q.edit();
				qs.getAsJsonObject("records").remove(id);
				q.set(qs);
				q.save();
				w.notes.add("legacy-settled:" + id);
			}
		}
		// the journal's own replay: a committed undo group whose chunk is not restored, and no txn holds it, is restored at start
		Store j = w.stores.get("journal");
		if (j != null && j.mem.get("groups") instanceof JsonArray gs) {
			for (JsonElement g : gs) {
				String id = g.getAsString();
				ResultCache.Done d = w.core.cache().byId(id);
				if (w.core.get(id) != null || d != null && !Decision.ABORT.equals(d.decision())) {
					continue; // a txn owns this undo group: its W effects are the restore (an aborted one's D never happened, so the journal replays)
				}
				if (w.core.holds().holder("site:" + id) != null) {
					continue;
				}
				for (Store c : w.stores.values()) {
					if (c.name.startsWith("chunk:") && c.mem.has("site") && c.mem.get("site").getAsString().equals(id) && !c.mem.has("restored")) {
						JsonObject s = c.edit();
						restoreChunk(s);
						c.set(s);
						w.notes.add("legacy-restored:" + c.name);
					}
				}
			}
		}
	}

	// ------------------------------------------------------------------ conservation and checks

	/** Every item held anywhere: containers, stock, inventories, owed records, plus each open txn's transit by its probes (§5.2). */
	static Map<String, Long> total(World w) {
		Conservation c = new Conservation();
		for (Store s : w.stores.values()) {
			c.add(s.name + ".items", items(s.mem, "items"));
			c.add(s.name + ".stock", items(s.mem, "stock"));
			c.add(s.name + ".inv", items(s.mem, "inv"));
			c.add(s.name + ".owedItems", items(s.mem, "owed"));
			if (s.mem.get("records") instanceof JsonObject recs) {
				recs.entrySet().forEach(e -> c.add(s.name + ".owed", items(e.getValue().getAsJsonObject(), "items")));
			}
		}
		c.inTransit(w.core);
		return c.total();
	}

	/** A scenario: its stores, its operation (driven through the core, or the legacy path for NO_JOURNAL), its own checks. */
	interface Scenario {
		void setup(World w);

		void op(World w);

		/** The scenario's own expectations after settling (an event's payload, the recorded split); empty when they hold. */
		default List<String> check(World w, Map<String, Long> baseline) {
			return List.of();
		}

		/** Whether a txn may legitimately stay held after settling (a declared UNKNOWN). */
		default boolean heldAllowed() {
			return false;
		}
	}

	/** A violation: where it crashed, the versions picked, what broke. */
	record Violation(String schedule, String what) {
		@Override
		public String toString() {
			return what + " <- " + schedule;
		}
	}

	/** The result of an exploration. */
	record Result(int schedules, List<Violation> violations, @Nullable Long seed) {
		boolean clean() {
			return violations.isEmpty();
		}
	}

	World fresh(Scenario sc, Naive naive) {
		World w = new World(naive);
		sc.setup(w);
		w.core = w.newCore();
		return w;
	}

	/** Runs the operation once with the crash armed at kill {@code crashAt} (MAX: none); the world as it stands then. */
	World run(Scenario sc, Naive naive, int crashAt) {
		World w = fresh(sc, naive);
		w.kills = 0;
		w.crashAt = crashAt;
		try {
			sc.op(w);
			w.settle();
		} catch (Crash c) {
			// the world stops here
		}
		return w;
	}

	/**
	 * Every kill point × every combination of persisted versions × recovery crashed at each of its own points to {@code depth}; then the
	 * world settles and is checked. A world with more than {@link #EXHAUSTIVE} schedules is sampled ({@code seed} printed).
	 */
	Result explore(Scenario sc, Naive naive, int depth) {
		return explore(sc, naive, depth, EXHAUSTIVE, Long.getLong("txn.model.seed", 0x7171L));
	}

	/**
	 * As {@link #explore(Scenario, Naive, int)}; a crash point whose version combinations exceed {@code cap} is sampled instead ({@link
	 * #SAMPLE} seeded random combinations, the seed in the result: T1 review P2-8), never truncated.
	 */
	Result explore(Scenario sc, Naive naive, int depth, int cap, long seed) {
		Random rnd = new Random(seed);
		boolean[] sampled = {false};
		World base = fresh(sc, naive);
		Map<String, Long> baseline = total(base);
		World clean = run(sc, naive, Integer.MAX_VALUE);
		List<Violation> out = new ArrayList<>();
		int[] count = {0};
		check(sc, clean, baseline, "no crash", out);
		count[0]++;
		int points = clean.kills;
		for (int c = 1; c <= points; c++) {
			World w = run(sc, naive, c);
			String at = "crash at #" + c + " " + w.crashedAt;
			List<int[]> all = picks(w, cap);
			if (all == null) {
				sampled[0] = true;
				all = randomPicks(w, rnd, SAMPLE);
			}
			for (int[] pick : all) {
				World r;
				try {
					r = w.restart(pick);
				} catch (Crash x) {
					continue;
				}
				recoverCrashing(sc, r, baseline, at + " pick " + java.util.Arrays.toString(pick) + (sampled[0] ? " (seed " + seed + ")" : ""), depth, out, count);
				if (out.size() > 20) {
					return new Result(count[0], out, sampled[0] ? seed : null);
				}
			}
		}
		return new Result(count[0], out, sampled[0] ? seed : null);
	}

	/** Seeded random version combinations, {@code n} of them. */
	static List<int[]> randomPicks(World w, Random rnd, int n) {
		List<Store> ss = new ArrayList<>(w.stores.values());
		List<int[]> out = new ArrayList<>();
		for (int i = 0; i < n; i++) {
			int[] p = new int[ss.size()];
			for (int k = 0; k < p.length; k++) {
				p[k] = rnd.nextInt(ss.get(k).candidates().size());
			}
			out.add(p);
		}
		return out;
	}

	static final int SAMPLE = 2_000;

	/** Recovery crashed at each of its own points (to {@code depth}), every crash restarted at every version combination, then checked. */
	void recoverCrashing(Scenario sc, World r, Map<String, Long> baseline, String at, int depth, List<Violation> out, int[] count) {
		finish(sc, r, baseline, at, out, count);
		if (depth <= 1) {
			return;
		}
		// recovery's own points: replay this restart's recovery with a crash armed at each of them
		World probe = rewind(r);
		int n;
		try {
			probe.crashAt = Integer.MAX_VALUE;
			probe.kills = 0;
			probe.reload();
			probe.settle();
			n = probe.kills;
		} catch (Crash x) {
			n = 0;
		}
		for (int k = 1; k <= n; k++) {
			World x = rewind(r);
			x.kills = 0;
			x.crashAt = k;
			try {
				x.reload();
				x.settle();
				continue; // the point was not reached this time
			} catch (Crash c) {
				// crashed inside recovery
			}
			List<int[]> xs = picks(x, EXHAUSTIVE);
			for (int[] pick : xs == null ? randomPicks(x, new Random(k), SAMPLE) : xs) {
				World y;
				try {
					y = x.restart(pick);
				} catch (Crash c) {
					continue;
				}
				recoverCrashing(sc, y, baseline, at + " / recovery crash #" + k + " " + x.crashedAt + " pick " + java.util.Arrays.toString(pick), depth - 1,
					out, count);
			}
		}
	}

	/** The world as it was just before its last load (its stores and flags), to replay that load with a crash armed. */
	World rewind(World r) {
		World w = (r.preLoad != null ? r.preLoad : r).copy();
		w.preLoad = r.preLoad;
		return w;
	}

	void finish(Scenario sc, World r, Map<String, Long> baseline, String at, List<Violation> out, int[] count) {
		count[0]++;
		try {
			r.settle();
		} catch (Crash c) {
			out.add(new Violation(at, "crash point armed during settle"));
			return;
		}
		check(sc, r, baseline, at, out);
	}

	void check(Scenario sc, World w, Map<String, Long> baseline, String at, List<Violation> out) {
		// exactly once (T1 review P2-7): every effect's receipt, and its compensation's, at most once in its store
		for (Store s : w.stores.values()) {
			for (String set : new String[] {"receipts", "be"}) {
				Map<String, Integer> n = new TreeMap<>();
				if (s.mem.get(set) instanceof JsonArray a) {
					a.forEach(x -> n.merge(x.getAsString(), 1, Integer::sum));
				}
				n.forEach((k, c) -> {
					if (c > 1) {
						out.add(new Violation(at, "exactly once: " + k + " applied " + c + " times in " + s.name));
					}
				});
			}
		}
		Map<String, Long> t = total(w);
		if (!t.equals(baseline)) {
			Map<String, Long> d = new TreeMap<>(t);
			baseline.forEach((k, v) -> d.merge(k, -v, Long::sum));
			d.values().removeIf(v -> v == 0);
			out.add(new Violation(at, "conservation: " + d + " (positive minted, negative lost)"));
		}
		if (!sc.heldAllowed() && !w.core.open().isEmpty()) {
			out.add(new Violation(at, "liveness: still open " + w.core.state().get("open")));
		}
		for (String s : sc.check(w, baseline)) {
			out.add(new Violation(at, s));
		}
	}

	/** Every combination of each store's crash candidates, or null when there are more than {@code cap} (then sample). */
	static @Nullable List<int[]> picks(World w, int cap) {
		List<Store> ss = new ArrayList<>(w.stores.values());
		long n = 1;
		for (Store s : ss) {
			n *= s.candidates().size();
			if (n > cap) {
				return null;
			}
		}
		List<int[]> out = new ArrayList<>();
		int[] cur = new int[ss.size()];
		fill(ss, 0, cur, out);
		return out;
	}

	private static void fill(List<Store> ss, int i, int[] cur, List<int[]> out) {
		if (i == ss.size()) {
			out.add(cur.clone());
			return;
		}
		int n = ss.get(i).candidates().size();
		for (int k = 0; k < n; k++) {
			cur[i] = k;
			fill(ss, i + 1, cur, out);
		}
	}

	/** A seeded sample of {@code n} schedules (beyond {@link #EXHAUSTIVE}): a random crash point and random versions each time. */
	Result sample(Scenario sc, Naive naive, int n, long seed) {
		Random rnd = new Random(seed);
		World base = fresh(sc, naive);
		Map<String, Long> baseline = total(base);
		int points = run(sc, naive, Integer.MAX_VALUE).kills;
		List<Violation> out = new ArrayList<>();
		int[] count = {0};
		for (int i = 0; i < n && out.size() <= 20; i++) {
			int c = 1 + rnd.nextInt(Math.max(1, points));
			World w = run(sc, naive, c);
			List<Store> ss = new ArrayList<>(w.stores.values());
			int[] pick = new int[ss.size()];
			for (int k = 0; k < pick.length; k++) {
				pick[k] = rnd.nextInt(ss.get(k).candidates().size());
			}
			World r = w.restart(pick);
			finish(sc, r, baseline, "seed " + seed + " #" + i + " crash at " + w.crashedAt + " pick " + java.util.Arrays.toString(pick), out, count);
		}
		return new Result(count[0], out, seed);
	}

	static void apply(World w, Consumer<World> f) {
		f.accept(w);
	}
}
