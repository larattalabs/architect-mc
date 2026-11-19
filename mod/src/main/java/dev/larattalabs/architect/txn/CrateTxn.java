package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import dev.larattalabs.architect.site.Sites;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2b) The crate's side of the txn layer, for every kind that takes a construction crate's stock (T2b's removal kinds, T3b's
 * adoption). <b>Stable interface</b> (docs/CONTRACT.md "Slice T2b part 2a as built"):
 * <ul>
 * <li>{@link #resource(String, BlockPos)}: the hold, {@code crate:<dim>@x,y,z}. While a txn holds it, the crate's cell is frozen (the T2a
 * holds) and its ledger refuses every writer but the holder's adapter: inserts (screen, hopper, dropper, dev), the feed's consume, any
 * {@code takeStock} (a finish, a deconstruct, an orphan click, a road), {@code adopt} (skipped, retried later).</li>
 * <li>{@link #take(String, BlockPos, Map)}: the B effect {@code crate.take} (a prepare effect): exactly {@code items} out of the crate's
 * stock into transit, its receipt {@code tx-n/i} in the chunk attachment {@code architect_mc:txn_receipts} in the same change; its
 * compensation puts them back with {@code tx-n/i!c}. Its probe reads the chunk: APPLIED / COMPENSATED / ABSENT, UNKNOWN when the chunk is not
 * loaded (a live txn) or the crate is gone without a receipt. A kind answers {@link #ADAPTER} for op {@link #TAKE}.</li>
 * </ul>
 * The crate's block entity carries nothing of the txn: a restore that removes it leaves the chunk's receipts (§3.4 B).
 */
public final class CrateTxn {
	private CrateTxn() {
	}

	public static final String TAKE = "crate.take";
	/**
	 * (slice T2b part 2b) The W effect {@code crate.restore}: the crate's cell back to its snapshot as the holder, with the receipt
	 * {@code tx-n/i@restored} in the chunk attachment in the same change. Probe: the receipt, or the cell no longer a crate (APPLIED);
	 * UNKNOWN unloaded. Data {@code dim}, {@code pos}, {@code state} (the snapshot block state), {@code nbt} (its block entity, optional).
	 * Stable for T3b: {@link #restore(String, BlockPos, String, String)} and {@link #ADAPTER} answers it.
	 */
	public static final String RESTORE = "crate.restore";
	/** (part 2b) The R effect {@code crate.release}: the crate owner's CRATE journal entries released; probe: none active (APPLIED). */
	public static final String RELEASE = "crate.release";
	/** (part 2b) The L effect {@code pile.credit} (keyed by {@code key} in the pile's credited set) and the O effect {@code owed.owe}. */
	public static final String PILE_CREDIT = "pile.credit", OWE = "owed.owe";
	/** (part 2b) The kind: a removed construction site's crate stock (and a crate-fed site's refunds) settled once, keyed. */
	public static final String SETTLE = "crate.settle";

	/** A position as the effects' {@code pos} (no TestMove: its attachment registers at class load). */
	static JsonArray posJson(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	/** The crate hold resource. */
	public static String resource(String dim, BlockPos p) {
		return "crate:" + dim + "@" + p.getX() + "," + p.getY() + "," + p.getZ();
	}

	/** The {@code crate.take} effect of {@code items} from the crate at {@code p} (a prepare effect: compensated on an abort). */
	public static Effect.Builder take(String dim, BlockPos p, Map<String, Integer> items) {
		return Effect.of(TAKE, EffectClass.B).prepare().items(items).move("crate", Effect.TRANSIT).data("dim", dim).data("pos", posJson(p));
	}

	/** The {@code crate.restore} effect of the crate cell at {@code p} back to {@code state} (and {@code nbt}). */
	public static Effect.Builder restore(String dim, BlockPos p, String state, @Nullable String nbt) {
		Effect.Builder b = Effect.of(RESTORE, EffectClass.W).data("dim", dim).data("pos", posJson(p)).data("state", state);
		return nbt == null ? b : b.data("nbt", nbt);
	}

	/** A W restore's receipt in the chunk: {@code tx-n/i@restored} (the same name and shape as T3b's wip 3cea8c81, so the merge is one hunk). */
	public static String restoredKey(TxnEntry t, Effect e) {
		return e.key(t.id) + "@restored";
	}

	/** The settle's dedupe key: {@code crate:<crateOwner>@x,y,z/<siteKey>} (a re-run after a crash attaches or replays, never re-takes). */
	public static String settleKey(String crateOwner, BlockPos p, String siteKey) {
		return "crate:" + crateOwner + "@" + p.getX() + "," + p.getY() + "," + p.getZ() + "/" + siteKey;
	}

	/**
	 * One settle's input. {@code stock}: the crate's (taken by e0); {@code refund}: a crate-fed site's refunds (owed {@code group_refund} or
	 * credited); {@code pile}: the recipient's pile owner, or null (owed); {@code restore}: the crate's cell restored and its journal entry
	 * released ({@code crateOwner}); false for a refund-only settle.
	 */
	public record Settle(String key, String dim, BlockPos pos, Map<String, Integer> stock, Map<String, Integer> refund, String recipient,
		@Nullable String pile, @Nullable String site, @Nullable String region, @Nullable String state, @Nullable String nbt,
		@Nullable String crateOwner, boolean restore) {
	}

	/** What a settle answered: owed keys, what it gave back (owed or credited), a hold's detail, a refusal. */
	public record Answer(List<String> owed, Map<String, Integer> given, @Nullable String held, @Nullable String refused, boolean replayed) {
	}

	/** The pure plan of a settle (R-1): its effects in order. The seam {@code CrateSettlePlanTest} drives. */
	static List<Effect.Builder> plan(Settle in) {
		List<Effect.Builder> out = new java.util.ArrayList<>();
		if (!in.stock().isEmpty()) {
			out.add(take(in.dim(), in.pos(), in.stock()));
			out.add(book(in, in.key(), in.stock(), dev.larattalabs.architect.site.OwedLedger.CRATE_SETTLE));
		}
		if (!in.refund().isEmpty()) {
			out.add(book(in, "refund:" + in.key(), in.refund(), dev.larattalabs.architect.site.OwedLedger.GROUP_REFUND).move("world", in.pile() != null
				? "stock" : "owed"));
		}
		if (in.restore()) {
			out.add(restore(in.dim(), in.pos(), java.util.Objects.requireNonNull(in.state()), in.nbt()));
			out.add(Effect.of(RELEASE, EffectClass.R).data("owner", java.util.Objects.requireNonNull(in.crateOwner())));
		}
		return out;
	}

	static Effect.Builder book(Settle in, String key, Map<String, Integer> items, String reason) {
		if (in.pile() != null) {
			return Effect.of(PILE_CREDIT, EffectClass.L).items(items).move(Effect.TRANSIT, "stock").data("owner", in.pile()).data("key", key);
		}
		Effect.Builder b = Effect.of(OWE, EffectClass.O).items(items).move(Effect.TRANSIT, "owed").data("key", key).data("recipient", in.recipient())
			.data("dim", in.dim()).data("pos", posJson(in.pos())).data("reason", reason);
		if (in.site() != null) {
			b.data("site", in.site());
		}
		if (in.region() != null) {
			b.data("region", in.region());
		}
		return b;
	}

	/** Runs one settle. Server thread. A begin refused (held, journal unavailable) touches nothing: the crate keeps its stock. */
	public static Answer settle(Settle in) {
		return settle(in, SETTLE, List.of(), List.of(), List.of());
	}

	/**
	 * (slice T4b) {@link #settle(Settle)} as kind {@code kind} ({@link RemovalTxn#SITE} or {@link RemovalTxn#ROAD}): {@code first} planned
	 * before the settle's effects (the removed site's W restore), {@code last} after them (a stockpile's site's refund), {@code more} held
	 * besides the crate (the removal's box). The crate is held only when the settle takes from it or restores it.
	 */
	public static Answer settle(Settle in, String kind, List<Effect.Builder> first, List<Effect.Builder> last, List<String> more) {
		TxnCore c = TxnServer.core();
		List<String> res = new java.util.ArrayList<>(more);
		if (SETTLE.equals(kind) || !in.stock().isEmpty() || in.restore()) {
			res.add(resource(in.dim(), in.pos()));
		}
		TxnCore.Started s = c.begin(kind, in.key(), res, in.recipient());
		if (s.status() == TxnCore.Begin.UNAVAILABLE) {
			return new Answer(List.of(), Map.of(), null, "journal_unavailable: " + s.detail(), false);
		}
		if (s.status() == TxnCore.Begin.REPLAYED) {
			return new Answer(owedOf(in), Map.of(), null, null, true);
		}
		if (s.status() == TxnCore.Begin.ATTACHED) {
			return new Answer(owedOf(in), Map.of(), s.detail() != null ? s.detail() : "attached", null, true);
		}
		if (s.status() == TxnCore.Begin.HELD) {
			return new Answer(List.of(), Map.of(), null, "held: " + s.detail(), false);
		}
		TxnEntry t = s.entry();
		for (Effect.Builder b : first) {
			c.plan(t, b);
		}
		for (Effect.Builder b : plan(in)) {
			c.plan(t, b);
		}
		for (Effect.Builder b : last) {
			c.plan(t, b);
		}
		dev.larattalabs.architect.site.DurableFile.Outcome p = c.persist(t);
		if (p == dev.larattalabs.architect.site.DurableFile.Outcome.REFUSED) {
			return new Answer(List.of(), Map.of(), null, "journal_unavailable: txn.json " + p, false);
		}
		TxnCore.Status st = c.drive(t);
		if (t.decision != null && t.decision.isAbort()) {
			// e0 or its barrier refused: the stock stays in (or goes back to) the crate. (T2b fix round P1-a) the reason as a plain string, never
			// a quoted JSON element (it never matched "aborted: barrier"); an abort whose compensation is held (its barrier refused too) is
			// held: the crate stays under the hold, retried
			com.google.gson.JsonElement why = t.result.get("refused");
			String reason = why == null || why.isJsonNull() ? "?" : why.isJsonPrimitive() ? why.getAsString() : why.toString();
			return new Answer(List.of(), Map.of(), st == TxnCore.Status.HELD || t.held() != null ? "abort held: " + Holds.decided(t) : null, "aborted: " + reason, false);
		}
		Map<String, Integer> given = new java.util.TreeMap<>(in.stock());
		in.refund().forEach((k, v) -> given.merge(k, v, Integer::sum));
		return new Answer(owedOf(in), given, st == TxnCore.Status.HELD || t.held() != null ? Holds.decided(t) : null, null, false);
	}

	static List<String> owedOf(Settle in) {
		if (in.pile() != null) {
			return List.of();
		}
		List<String> out = new java.util.ArrayList<>();
		if (!in.stock().isEmpty()) {
			out.add(in.key());
		}
		if (!in.refund().isEmpty()) {
			out.add("refund:" + in.key());
		}
		return out;
	}

	/** {@code crate.restore}: the cell back as the holder, its receipt in the same chunk change. */
	public static final TxnKind.Adapter RESTORE_ADAPTER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("dim") || !e.data().has("pos") || !e.data().has("state") ? "dim, pos and state are required" : null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			BlockPos p = TestMove.posOf(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			if (TestMove.receipts(ch).contains(restoredKey(t, e))) {
				return Probe.APPLIED;
			}
			return level.getBlockEntity(p) instanceof CrateBlockEntity ? Probe.ABSENT : Probe.APPLIED; // the cell no longer a crate: restored
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				if (ch == null) {
					throw new IllegalStateException("the crate's chunk is not loaded");
				}
				dev.larattalabs.architect.site.CrateSettle.restoreCell(level, p, e.data().get("state").getAsString(), e.data().has("nbt") ? e.data().get("nbt")
					.getAsString() : null);
				TestMove.addReceipt(ch, restoredKey(t, e)); // the same tick, the same chunk
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a restore is never a prepare effect");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "crate cell at " + TestMove.posOf(e).toShortString();
		}
	};

	static final TxnKind.Adapter RELEASER = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return dev.larattalabs.architect.site.CrateSettle.journalActive(e.data().get("owner").getAsString()) ? Probe.ABSENT : Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			dev.larattalabs.architect.site.CrateSettle.releaseJournal(e.data().get("owner").getAsString());
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a release is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("owner") ? null : "owner is required";
		}
	};

	static final TxnKind.Adapter CREDITOR = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return dev.larattalabs.architect.site.CrateSettle.credited(e.data().get("owner").getAsString(), e.data().get("key").getAsString()) ? Probe.APPLIED
				: Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			dev.larattalabs.architect.site.CrateSettle.credit(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), e.items());
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a credit is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("owner") && e.data().has("key") && !e.items().isEmpty() ? null : "owner, key and items are required";
		}
	};

	static final TxnKind.Adapter OWER = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			String key = e.data().get("key").getAsString();
			return dev.larattalabs.architect.site.OwedLedger.applied(e.key(t.id)) || dev.larattalabs.architect.site.OwedLedger.known(key) ? Probe.APPLIED
				: Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			com.google.gson.JsonObject d = e.data();
			BlockPos p = TestMove.posOf(e);
			MinecraftServer s = TxnServer.server();
			long tick = s == null ? 0 : s.getTickCount();
			var entry = new dev.larattalabs.architect.site.OwedLedger.Entry(d.get("key").getAsString(), d.get("recipient").getAsString(), d.get("dim")
				.getAsString(), p.getX(), p.getY(), p.getZ(), e.items(), d.get("reason").getAsString(), tick, System.currentTimeMillis(), d.has("site") ? d
					.get("site").getAsString() : null, d.has("region") ? d.get("region").getAsString() : null);
			dev.larattalabs.architect.site.OwedLedger.owe(entry, e.key(t.id));
			dev.larattalabs.architect.site.Stockpiles.owedChanged();
			OwedTxn.changed(entry);
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("an owe is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			com.google.gson.JsonObject d = e.data();
			return d.has("key") && d.has("recipient") && d.has("dim") && d.has("pos") && d.has("reason") && !e.items().isEmpty() ? null
				: "key, recipient, dim, pos, reason and items are required";
		}
	};

	static @Nullable ServerLevel level(Effect e) {
		MinecraftServer s = TxnServer.server();
		return s == null ? null : Sites.levelOf(s, e.data().get("dim").getAsString());
	}

	public static final TxnKind SETTLE_KIND = new TxnKind() {
		@Override
		public String name() {
			return SETTLE;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return switch (e.op()) {
				case TAKE -> ADAPTER;
				case RESTORE -> RESTORE_ADAPTER;
				case RELEASE -> RELEASER;
				case PILE_CREDIT -> CREDITOR;
				case OWE -> OWER;
				default -> null;
			};
		}
	};

	public static final TxnKind.Adapter ADAPTER = new TxnKind.Adapter() {
		@Nullable ServerLevel level(Effect e) {
			MinecraftServer s = TxnServer.server();
			return s == null ? null : Sites.levelOf(s, e.data().get("dim").getAsString());
		}

		@Nullable CrateBlockEntity crate(ServerLevel level, BlockPos p) {
			return level.getBlockEntity(p) instanceof CrateBlockEntity c ? c : null;
		}

		@Override
		public @Nullable String invalid(Effect e) {
			if (!(e.data().get("dim") instanceof com.google.gson.JsonPrimitive d) || !d.isString() || !(e.data().get("pos") instanceof JsonArray a)
				|| a.size() != 3) {
				return "dim and pos are required";
			}
			String bad = TestMoveCells.dimRefusal(d.getAsString());
			return bad != null ? bad : e.items().isEmpty() ? "no items" : null;
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, TestMove.posOf(e));
			if (ch == null) {
				return Probe.UNKNOWN;
			}
			List<String> r = TestMove.receipts(ch);
			if (r.contains(e.compKey(t.id))) {
				return Probe.COMPENSATED;
			}
			return r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				CrateBlockEntity c = level == null ? null : crate(level, p);
				if (ch == null || c == null) {
					throw new IllegalStateException("the crate is not loaded or gone");
				}
				if (!c.ledger().take(e.items())) {
					throw new IllegalStateException("the crate no longer holds " + e.items()); // checked before any change
				}
				TestMove.addReceipt(ch, e.key(t.id)); // the same tick, the same chunk: one snapshot holds both
				c.ledgerChanged();
			});
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			TxnServer.asHolder(t, () -> {
				ServerLevel level = level(e);
				BlockPos p = TestMove.posOf(e);
				LevelChunk ch = level == null ? null : TestMove.chunkFor(t, level, p);
				CrateBlockEntity c = level == null ? null : crate(level, p);
				if (ch == null || c == null) {
					throw new IllegalStateException("the crate is not loaded or gone: its stock stays in transit (held)");
				}
				c.ledger().putBack(e.items());
				TestMove.addReceipt(ch, e.compKey(t.id));
				c.ledgerChanged();
			});
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			BlockPos p = TestMove.posOf(e);
			return "crate at " + p.toShortString();
		}
	};
}
