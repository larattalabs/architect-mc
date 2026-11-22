package dev.larattalabs.architect.txn;

import com.google.gson.JsonParser;
import com.mojang.serialization.JsonOps;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R, R5; N6, docs/CONTRACT.md "Phase T4" §3 "a stack with its own data is an O cargo entry") A player-placed holder's stack that
 * carries its own data (a name, an enchantment, contents) in a group removal's region target: taken out of its holder (B {@code cargo.take},
 * a prepare effect: put back on an abort, its receipt in the chunk) and owed whole to the pile's owner (O {@code owed.owe}, reason
 * {@code cargo}, the stack kept as its own data on the owed entry: collected back exactly, never credited by id). One txn per removal's
 * holders, kind {@code removal.cargo}, run before the holders are replaced; nothing strands the removal any more.
 */
public final class CargoTxn {
	private CargoTxn() {
	}

	public static final String KIND = "removal.cargo", TAKE = "cargo.take";

	/**
	 * One stack taken out of a holder: its holder's cell and slot, the stack (its count included) and who it is owed to. (slice T4R-D fix round,
	 * P1-6) {@code pile}: a plain stack (no data of its own) credited into that owner's pile instead (an L effect after the take); null: owed
	 * whole (an O {@code cargo} entry).
	 */
	public record Stack(String key, String recipient, String dim, BlockPos pos, int slot, ItemStack stack, @Nullable String site, @Nullable String pile) {
		public Stack(String key, String recipient, String dim, BlockPos pos, int slot, ItemStack stack, @Nullable String site) {
			this(key, recipient, dim, pos, slot, stack, site, null);
		}
	}

	/** The stack as JSON text (the registry's codec: every component kept). */
	public static String encode(ServerLevel level, ItemStack st) {
		return ItemStack.CODEC.encodeStart(level.registryAccess().createSerializationContext(JsonOps.INSTANCE), st).getOrThrow().toString();
	}

	/** {@link #encode}'s stack back; empty when it can't be read. */
	public static ItemStack decode(MinecraftServer srv, String json) {
		return ItemStack.CODEC.parse(srv.registryAccess().createSerializationContext(JsonOps.INSTANCE), JsonParser.parseString(json)).result().orElse(
			ItemStack.EMPTY);
	}

	/** (slice T4R fix round, P1-5) A cargo stack's owed key: unique per txn and effect ({@code tx-n/i}), its source after it. */
	public static String oweKey(String txnId, int effect, String source) {
		return "cargo:" + txnId + "/" + effect + ":" + source;
	}

	/**
	 * (slice T4R-L) Whether the {@code removal.cargo} txn that an owed key {@link #oweKey} names is known to have ended without owing (aborted,
	 * or open with an abort decision): its key is no part of a removal's result. Unknown (evicted, not a cargo key): false.
	 */
	public static boolean aborted(String owedKey) {
		return aborted(owedKey, TxnServer.core());
	}

	/** (slice T4R-M) The id of the {@code removal.cargo} txn an owed key {@link #oweKey} names, or null (not such a key). */
	public static @Nullable String txnOf(String owedKey) {
		if (!owedKey.startsWith("cargo:tx-")) {
			return null;
		}
		int slash = owedKey.indexOf('/', 6);
		return slash < 0 ? null : owedKey.substring(6, slash);
	}

	/**
	 * (slice T4R-M) What {@code c} knows of the txn {@code id}: {@code "commit"} (open with an acknowledged commit decision, or retired committed
	 * or abandoned), {@code "abort"} (open with an acknowledged abort decision, or retired aborted), {@code "open"} (open, undecided or its
	 * decision not yet acknowledged on disk: slice T4R-N), {@code "unknown"} (neither
	 * open nor in the bounded result cache).
	 */
	public static String fate(String id, TxnCore c) {
		TxnEntry t = c.get(id);
		if (t != null) {
			// (slice T4R-N, the final check of f7607b13's P2) a decision counts only once the txn file acknowledged it: a refused or in-doubt
			// decision write leaves it in memory only, and a crash then loads the txn undecided (recovery aborts it). Until then: open
			return t.decision == null || !c.acknowledged() ? "open" : t.decision.isAbort() ? "abort" : "commit";
		}
		ResultCache.Done d = c.cache().byId(id);
		return d == null ? "unknown" : Decision.ABORT.equals(d.decision()) ? "abort" : "commit";
	}

	/** (TEST seam, slice T4R-M hooks) {@link #aborted(String)} against {@code c}. */
	public static boolean aborted(String owedKey, TxnCore c) {
		if (!owedKey.startsWith("cargo:tx-")) {
			return false;
		}
		int slash = owedKey.indexOf('/', 6);
		if (slash < 0) {
			return false;
		}
		String id = owedKey.substring(6, slash);
		TxnEntry t = c.get(id);
		if (t != null) {
			return t.decision != null && c.acknowledged() && t.decision.isAbort(); // (slice T4R-N) as fate: acknowledged decisions only
		}
		ResultCache.Done d = c.cache().byId(id);
		return d != null && Decision.ABORT.equals(d.decision());
	}

	static String itemId(ItemStack st) {
		return net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(st.getItem()).toString();
	}

	/**
	 * Owes {@code stacks} (each taken out of its holder first) in one txn, keyed {@code key}. Null when done (or replayed); else why not (refused
	 * before anything changed, or held after the decision: then its stacks are owed by recovery, never lost). Server thread.
	 */
	public static @Nullable String owe(ServerLevel level, String key, List<Stack> stacks) {
		return owe(level, key, stacks, new java.util.ArrayList<>());
	}

	/**
	 * {@link #owe}, adding the owed keys it creates to {@code owedKeys}. (slice T4R fix round, P1-5) Each owed key is the txn's and the
	 * effect's ({@code cargo:tx-n/i:<source>}), never the holder's slot alone: a later take from the same slot is a new entry, never a probe
	 * of an earlier (ended) one.
	 */
	public static @Nullable String owe(ServerLevel level, String key, List<Stack> stacks, List<String> owedKeys) {
		Prepared p = prepare(level, key, stacks);
		if (p.entry() == null) {
			return p.why();
		}
		owedKeys.addAll(p.keys());
		return drive(p.entry());
	}

	/** (slice T4R-L) A begun, planned and persisted {@code removal.cargo} txn (nothing applied yet) and the owed keys it will create. */
	public record Prepared(@Nullable TxnEntry entry, @Nullable String why, List<String> keys) {
	}

	/**
	 * (slice T4R-L, the final check's P2) {@link #owe}'s first half: the txn begun, planned and persisted, nothing applied (an undecided entry
	 * recovered after a restart is compensated: nothing is owed). Its caller records {@link Prepared#keys} where its result reads them (a group
	 * removal: in its queue, confirmed) before {@link #drive} can commit an owed entry. No entry: done (replayed, or nothing to owe; why null)
	 * or refused before anything changed (why).
	 */
	public static Prepared prepare(ServerLevel level, String key, List<Stack> stacks) {
		List<String> keys = new java.util.ArrayList<>();
		if (stacks.isEmpty()) {
			return new Prepared(null, null, keys);
		}
		TxnCore c = TxnServer.core();
		List<String> res = new java.util.ArrayList<>();
		String dim = stacks.get(0).dim();
		for (Stack s : stacks) {
			String r = CrateTxn.resource(dim, s.pos());
			if (!res.contains(r)) {
				res.add(r);
			}
			if (s.pile() != null && !res.contains("pile:" + s.pile())) {
				res.add("pile:" + s.pile()); // (fix round P1-6) the pile it credits stays while it is open
			}
		}
		TxnCore.Started st = c.begin(KIND, key, res, stacks.get(0).recipient());
		if (st.status() == TxnCore.Begin.REPLAYED) {
			return new Prepared(null, null, keys);
		}
		if (st.status() != TxnCore.Begin.NEW) {
			return new Prepared(null, st.status().name().toLowerCase(java.util.Locale.ROOT) + ": " + st.detail(), keys);
		}
		TxnEntry t = st.entry();
		for (Stack s : stacks) {
			Map<String, Integer> items = Map.of(itemId(s.stack()), s.stack().getCount());
			String enc = encode(level, s.stack());
			c.plan(t, Effect.of(TAKE, EffectClass.B).prepare().items(items).move("holder", Effect.TRANSIT).data("dim", dim).data("pos", CrateTxn.posJson(s
				.pos())).data("slot", s.slot()).data("stack", enc));
			String owedKey = oweKey(t.id, t.effects.size(), s.key());
			if (s.pile() != null && s.stack().getComponentsPatch().isEmpty()) {
				// (fix round P1-6) a plain stack credited into the pile, once (its key: this txn's and effect's), after its take
				c.plan(t, Effect.of(CrateTxn.PILE_CREDIT, EffectClass.L).items(items).move(Effect.TRANSIT, "stock").data("owner", s.pile()).data("key", owedKey)
					.data("pos", CrateTxn.posJson(s.pos())));
				continue;
			}
			keys.add(owedKey);
			Effect.Builder ow = Effect.of(CrateTxn.OWE, EffectClass.O).items(items).move(Effect.TRANSIT, "owed").data("key", owedKey).data("recipient", s
				.recipient()).data("dim", dim).data("pos", CrateTxn.posJson(s.pos())).data("reason", dev.larattalabs.architect.site.OwedLedger.CARGO).data(
					"stack", enc);
			if (s.site() != null) {
				ow.data("site", s.site());
			}
			c.plan(t, ow);
		}
		if (c.persist(t) == dev.larattalabs.architect.site.DurableFile.Outcome.REFUSED) {
			return new Prepared(null, "txn.json refused", List.of());
		}
		return new Prepared(t, null, List.copyOf(keys));
	}

	/** (slice T4R-L) {@link #owe}'s second half: a {@link #prepare}d txn driven. Null when done; else why not (as {@link #owe}). */
	public static @Nullable String drive(TxnEntry t) {
		TxnCore c = TxnServer.core();
		TxnCore.Status s = c.drive(t);
		if (t.decision != null && t.decision.isAbort()) {
			return "aborted: " + t.result.get("refused");
		}
		return s == TxnCore.Status.HELD || t.held() != null ? "held(decided): " + Holds.decided(t) : null;
	}

	static final TxnKind.Adapter TAKER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("dim") && e.data().has("pos") && e.data().has("slot") && e.data().has("stack") ? null : "dim, pos, slot and stack are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = CrateTxn.level(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, TestMove.posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			List<String> r = TestMove.receipts(ch);
			return r.contains(e.compKey(t.id)) ? Probe.COMPENSATED : r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = CrateTxn.level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null || !(level.getBlockEntity(p) instanceof Container box)) {
					throw new IllegalStateException("the holder is not loaded or gone");
				}
				int slot = e.data().get("slot").getAsInt();
				ItemStack now = box.getItem(slot);
				ItemStack want = decode(level.getServer(), e.data().get("stack").getAsString());
				if (want.isEmpty() || !ItemStack.matches(now, want)) {
					throw new IllegalStateException("the holder's slot " + slot + " no longer holds " + itemId(want)); // checked before any change
				}
				box.setItem(slot, ItemStack.EMPTY);
				box.setChanged();
				TestMove.addReceipt(ch, e.key(t.id)); // the same tick, the same chunk
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = CrateTxn.level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null || !(level.getBlockEntity(p) instanceof Container box)) {
					throw new IllegalStateException("the holder is not loaded or gone: its stack stays in transit (held)");
				}
				int slot = e.data().get("slot").getAsInt();
				if (!box.getItem(slot).isEmpty()) {
					throw new IllegalStateException("the holder's slot " + slot + " is taken: its stack stays in transit (held)");
				}
				box.setItem(slot, decode(level.getServer(), e.data().get("stack").getAsString()));
				box.setChanged();
				TestMove.addReceipt(ch, e.compKey(t.id));
			});
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "holder at " + TestMove.posOf(e).toShortString();
		}
	};

	public static final TxnKind KIND_DEF = new TxnKind() {
		@Override
		public String name() {
			return KIND;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return switch (e.op()) {
				case TAKE -> TAKER;
				case CrateTxn.OWE -> CrateTxn.OWER;
				case CrateTxn.PILE_CREDIT -> CrateTxn.CREDITOR; // (fix round P1-6) a plain stack into the pile
				default -> null;
			};
		}

		@Override
		public com.google.gson.JsonObject result(TxnEntry t) {
			return CrateTxn.resultOf(t);
		}
	};
}
