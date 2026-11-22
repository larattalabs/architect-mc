package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.CrateSettle;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4b, docs/CONTRACT.md "Phase T4" §3, findings 1-3 of the T2b last-round review) A removal's refunds on the txn layer: the kinds
 * {@code removal.site} (a single site's removal, its cascade's members each their own) and {@code removal.road} (a road or cell site's).
 * Each runs after the removal's undo is committed (the journal's undo group is the decision, made durable before the txn begins, with the
 * removal's stash saved confirmed before that commit), and its plan starts with the W effect {@link #RESTORE} for the removed site: its
 * committed restore written again from the journal (idempotent) with the receipt {@code tx-n/i@restored} in every chunk it writes. Every
 * refund and the crate's settle come after it (T2b's crate.settle effects, and the L {@link #PILE_REFUND} of a stockpile's site), so a
 * barrier that publishes the ledger has saved the restored chunks first: a refund is never paid while its paid blocks stand (1a, 1b), never
 * on the evidence of a threshold or of a missing record (3a, 3b). The undo group's entries are kept until the txn retires (2a); a W apply
 * that fails holds and is retried, never paid past (2b).
 */
public final class RemovalTxn {
	private RemovalTxn() {
	}

	public static final String SITE = "removal.site", ROAD = "removal.road";
	/**
	 * (slice T4R, R1) A group's or stage's removal: one txn per removal call (N1), keyed {@code group:<id>[/stage]@<undoGroup>}, begun once its
	 * undo committed (the journal's undo group is the decision). Per paid member: its W {@link #RESTORE}, a member barrier, its L/O/settle
	 * (minOf its W), a member barrier; then the group's shared crate; then {@link #GROUP_DONE}, which waits for the group's own end.
	 */
	public static final String GROUP = "removal.group";
	/** (slice T4R) The R effect that waits until the group's removal ended (its queue entry gone): only then the txn finishes and fires its event. */
	public static final String GROUP_DONE = "group.done";
	/** The W effect: the removed site's committed restore. Data {@code dim}, {@code site}, {@code group}, {@code chunks} ([[cx, cz], ...]). */
	public static final String RESTORE = "site.restore";
	/**
	 * The L effect: a stockpile's site's refund credited into its pile under its own credit key ({@code site:<id>@<placedAt>}, the key
	 * {@code Builder.creditRefund} books), so the custody held for it comes back with it and its paid record goes. Data {@code owner},
	 * {@code key}, {@code pos}. Its items may be empty (a custody-only or a nothing credit).
	 */
	public static final String PILE_REFUND = "pile.refund";

	/** The W {@link #RESTORE} effect for {@code site}'s committed restore in undo group {@code group}, over {@code chunks}. */
	public static Effect.Builder restore(String dim, String site, String group, List<long[]> chunks, @Nullable JsonArray cells) {
		Effect.Builder b = restore(dim, site, group, chunks);
		return cells == null ? b : b.data("cells", cells);
	}

	public static Effect.Builder restore(String dim, String site, String group, List<long[]> chunks) {
		JsonArray cs = new JsonArray();
		for (long[] c : chunks) {
			JsonArray a = new JsonArray();
			a.add(c[0]);
			a.add(c[1]);
			cs.add(a);
		}
		return Effect.of(RESTORE, EffectClass.W).data("dim", dim).data("site", site).data("group", group).data("chunks", cs);
	}

	/** The L {@link #PILE_REFUND} effect. */
	public static Effect.Builder pileRefund(String owner, String key, java.util.Map<String, Integer> items, BlockPos at) {
		return Effect.of(PILE_REFUND, EffectClass.L).items(items).move("world", "stock").data("owner", owner).data("key", key).data("pos", CrateTxn
			.posJson(at));
	}

	static @Nullable ServerLevel level(Effect e) {
		MinecraftServer s = TxnServer.server();
		return s == null ? null : dev.larattalabs.architect.site.Sites.levelOf(s, e.data().get("dim").getAsString());
	}

	static String restoredKey(TxnEntry t, Effect e) {
		return e.key(t.id) + "@restored";
	}

	/** The chunks of a {@link #RESTORE} effect, loaded when recovering (a live txn reads only loaded ones): null when one is not loaded. */
	static java.util.@Nullable List<LevelChunk> chunks(TxnEntry t, ServerLevel level, Effect e) {
		java.util.List<LevelChunk> out = new java.util.ArrayList<>();
		for (JsonElement el : e.data().getAsJsonArray("chunks")) {
			JsonArray a = el.getAsJsonArray();
			LevelChunk ch = TestMove.chunkFor(t, level, new BlockPos(a.get(0).getAsInt() << 4, 0, a.get(1).getAsInt() << 4));
			if (ch == null) {
				return null;
			}
			out.add(ch);
		}
		return out;
	}

	static final TxnKind.Adapter RESTORER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("dim") && e.data().has("site") && e.data().has("group") && e.data().get("chunks") instanceof JsonArray ? null
				: "dim, site, group and chunks are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			String site = e.data().get("site").getAsString();
			String group = e.data().get("group").getAsString();
			if (CrateSettle.journalUnreadable() || CrateSettle.notReady() != null) {
				// (T4b fix round, finding 2) no journal read: its entries' absence is no evidence of a settled restore. (T4 final round) nor while
				// any record store is unread or failed (recovery runs before them): held, retried once they load
				return Probe.UNKNOWN;
			}
			if (!CrateSettle.undoneExists(site, group)) {
				// its undo group's entries are released only after this txn retires (or, for a removal settled before T4, once its restore read
				// restored at a start): nothing of it is left to write
				return Probe.APPLIED;
			}
			ServerLevel level = level(e);
			java.util.List<LevelChunk> cs = level == null ? null : chunks(t, level, e);
			if (cs == null) {
				return Probe.UNKNOWN;
			}
			String k = restoredKey(t, e);
			for (LevelChunk ch : cs) {
				if (!TestMove.receipts(ch).contains(k)) {
					return Probe.ABSENT;
				}
			}
			return Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			ServerLevel level = level(e);
			if (level == null) {
				throw new IllegalStateException("its dimension is not loaded");
			}
			java.util.List<LevelChunk> cs = chunks(t, level, e);
			if (cs == null) {
				throw new IllegalStateException("a chunk of its restore is not loaded");
			}
			String site = e.data().get("site").getAsString();
			String group = e.data().get("group").getAsString();
			if (CrateSettle.writeWaits(site, group)) {
				// (slice T4R, R1) a group member its group's removal still writes (over ticks, one member at a time): the W waits for that write and
				// only receipts it, never writes ahead of the group (nor a whole region in one tick)
				throw new IllegalStateException("waits for its group's write");
			}
			if (e.data().get("cells") instanceof JsonArray a) {
				recordFound(level, site, group, a); // (T4b fix round, N3) before any write: kept where recorded already (never re-read after it)
			}
			boolean clear = e.data().has("clear") && e.data().get("clear").getAsBoolean();
			JsonArray pcells = e.data().get("pcells") instanceof JsonArray pc ? pc : null;
			String pkey = e.data().has("pkey") ? e.data().get("pkey").getAsString() : null;
			if (pcells != null && pkey != null) {
				// (slice T4R-D, I2) the player's cells standing before the first write, first write wins (pos:block), in their chunks
				recordPfound(level, pkey, pcells);
			}
			TxnServer.asHolder(t, () -> CrateSettle.restoreSite(level, site, group, clear, null, null, null, null));
			if (pcells != null && pkey != null) {
				// (slice T4R-D, I2) the recorded cells gone after this W's write: receipted once per (effect, chunk), the same tick as @restored
				recordPgone(level, pkey, e.key(t.id) + "@pgone=", pcells);
			}
			String k = restoredKey(t, e);
			String tag = foundTag(site, group);
			String pre = e.key(t.id) + "@found=";
			for (LevelChunk ch : cs) {
				// (N3) what of its refunded cells stood here before the first write, receipted for this txn: its refunds pay min(planned, found)
				if (foundToAdd(TestMove.receipts(ch), pre)) {
					java.util.Map<String, Integer> f = entry(ch, tag);
					TestMove.addReceipt(ch, pre + encode(f == null ? java.util.Map.of() : f));
				}
				TestMove.addReceipt(ch, k); // the same tick as its cells: the chunk's save holds both
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a restore is never a prepare effect");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			JsonArray first = e.data().getAsJsonArray("chunks").isEmpty() ? null : e.data().getAsJsonArray("chunks").get(0).getAsJsonArray();
			return first == null ? "the restore of " + e.data().get("site").getAsString() : "chunk " + first.get(0).getAsInt() + "," + first.get(1).getAsInt();
		}
	};

	/** (slice T4R-D, I2) The chunk receipt of the player's cells standing before any write of {@code pkey} ({@code <owner>/<member>} or an extraction key). */
	static String pfoundTag(String pkey) {
		return "pfound:" + pkey + "=";
	}

	/** The chunks (packed) of {@code pcells} ([{pos, ...}]) and each one's cells. */
	static java.util.Map<Long, java.util.List<Long>> byChunk(JsonArray pcells) {
		java.util.Map<Long, java.util.List<Long>> out = new java.util.TreeMap<>();
		for (var el : pcells) {
			long pos = el.getAsJsonObject().get("pos").getAsLong();
			BlockPos p = BlockPos.of(pos);
			out.computeIfAbsent((long) (p.getX() >> 4) << 32 | (p.getZ() >> 4) & 0xFFFFFFFFL, k -> new java.util.ArrayList<>()).add(pos);
		}
		return out;
	}

	/**
	 * (slice T4R-D, I2) Records in each chunk of {@code pcells} that has none yet which of them stand now (before the first write: {@code
	 * pfound:<pkey>=pos:block,...}): first write wins, so a replay after a write reads it, never the world. Server thread; loads the chunks.
	 */
	public static void recordPfound(ServerLevel level, String pkey, JsonArray pcells) {
		String tag = pfoundTag(pkey);
		java.util.Map<Long, String> blockAt = new java.util.HashMap<>();
		pcells.forEach(el -> blockAt.put(el.getAsJsonObject().get("pos").getAsLong(), el.getAsJsonObject().get("block").getAsString()));
		for (var en : byChunk(pcells).entrySet()) {
			LevelChunk ch = level.getChunk((int) (en.getKey() >> 32), (int) (long) en.getKey());
			if (TestMove.receipts(ch).stream().anyMatch(r -> r.startsWith(tag))) {
				continue;
			}
			StringBuilder b = new StringBuilder();
			for (long pos : en.getValue()) {
				String block = blockAt.get(pos);
				if (block.equals(CrateSettle.blockIdAt(level, BlockPos.of(pos)))) {
					b.append(b.length() == 0 ? "" : ",").append(pos).append(':').append(block);
				}
			}
			TestMove.addReceipt(ch, tag + b);
		}
	}

	/** (slice T4R-D) The positions a {@code pfound} receipt in {@code ch} recorded standing, or null when it has none. */
	static java.util.@Nullable Map<Long, String> pfound(LevelChunk ch, String pkey) {
		String tag = pfoundTag(pkey);
		for (String r : TestMove.receipts(ch)) {
			if (r.startsWith(tag)) {
				java.util.Map<Long, String> m = new java.util.LinkedHashMap<>();
				String v = r.substring(tag.length());
				if (!v.isEmpty()) {
					for (String p : v.split(",")) {
						int c = p.indexOf(':');
						m.put(Long.parseLong(p.substring(0, c)), p.substring(c + 1));
					}
				}
				return m;
			}
		}
		return null;
	}

	/**
	 * (slice T4R-D, I2) After a W's write: in each chunk of {@code pcells} without a {@code pre} receipt ({@code <tx>/<i>@pgone=}), the cells its
	 * {@code pfound} recorded standing that no longer hold that block. Once per (effect, chunk), the same tick as the write.
	 */
	public static void recordPgone(ServerLevel level, String pkey, String pre, JsonArray pcells) {
		for (var en : byChunk(pcells).entrySet()) {
			LevelChunk ch = level.getChunk((int) (en.getKey() >> 32), (int) (long) en.getKey());
			if (!foundToAdd(TestMove.receipts(ch), pre)) {
				continue;
			}
			java.util.Map<Long, String> was = pfound(ch, pkey);
			StringBuilder b = new StringBuilder();
			if (was != null) {
				for (var w : was.entrySet()) {
					if (!w.getValue().equals(CrateSettle.blockIdAt(level, BlockPos.of(w.getKey())))) {
						b.append(b.length() == 0 ? "" : ",").append(w.getKey());
					}
				}
			}
			TestMove.addReceipt(ch, pre + b);
		}
	}

	/**
	 * (slice T4R-D, I2) The positions of {@code pcells} the W effect {@code w} receipted gone ({@code @pgone}), over its cells' chunks. Throws
	 * when a chunk can't be read or lacks the receipt (the W has not applied there: the caller's effect holds; a barrier precedes it).
	 */
	static java.util.Set<Long> pgone(TxnEntry t, Effect w, JsonArray pcells) {
		ServerLevel level = level(w);
		if (level == null) {
			throw new IllegalStateException("its dimension is not loaded");
		}
		String pre = w.key(t.id) + "@pgone=";
		java.util.Set<Long> out = new java.util.HashSet<>();
		for (var en : byChunk(pcells).entrySet()) {
			LevelChunk ch = TestMove.chunkFor(t, level, new BlockPos((int) (en.getKey() >> 32) << 4, 0, (int) (long) en.getKey() << 4));
			if (ch == null) {
				throw new IllegalStateException("a chunk of its player's cells is not loaded");
			}
			String rec = null;
			for (String r : TestMove.receipts(ch)) {
				if (r.startsWith(pre)) {
					rec = r.substring(pre.length());
					break;
				}
			}
			if (rec == null) {
				throw new IllegalStateException("its restore's player receipt is missing in a chunk (not written yet)");
			}
			if (!rec.isEmpty()) {
				for (String p : rec.split(",")) {
					out.add(Long.parseLong(p));
				}
			}
		}
		return out;
	}

	/** (N3) The chunk receipt naming what of a removal's refunded cells stood there before its restore's first write. */
	static String foundTag(String site, String group) {
		return "found:" + site + "@" + group + "=";
	}

	/** (N3) The recorded found amounts in {@code ch} for {@code tag}, or null when none were recorded there. */
	static java.util.@Nullable Map<String, Integer> entry(LevelChunk ch, String tag) {
		for (String r : TestMove.receipts(ch)) {
			if (r.startsWith(tag)) {
				return decode(r.substring(tag.length()));
			}
		}
		return null;
	}

	/**
	 * (T4b fix round, N3) Records, in each chunk of {@code cells} that has none yet, what of them stands now (before the restore's first write
	 * there). Server thread.
	 */
	public static void recordFound(ServerLevel level, String site, String group, JsonArray cells) {
		String tag = foundTag(site, group);
		java.util.Map<Long, java.util.Map<String, Integer>> now = CrateSettle.foundIn(level, cells);
		for (var en : now.entrySet()) {
			LevelChunk ch = level.getChunk((int) (en.getKey() >> 32), (int) (long) en.getKey());
			if (entry(ch, tag) == null) {
				TestMove.addReceipt(ch, tag + encode(en.getValue()));
			}
		}
	}

	static long chunkKey(LevelChunk ch) {
		return (long) ch.getPos().x() << 32 | ch.getPos().z() & 0xFFFFFFFFL;
	}

	static String encode(java.util.Map<String, Integer> m) {
		StringBuilder b = new StringBuilder();
		new java.util.TreeMap<>(m).forEach((k, v) -> b.append(b.length() == 0 ? "" : ",").append(k).append('*').append(v));
		return b.toString();
	}

	static java.util.Map<String, Integer> decode(String s) {
		java.util.Map<String, Integer> m = new java.util.TreeMap<>();
		if (!s.isEmpty()) {
			for (String p : s.split(",")) {
				int star = p.lastIndexOf('*');
				m.merge(p.substring(0, star), Integer.parseInt(p.substring(star + 1)), Integer::sum);
			}
		}
		return m;
	}

	/**
	 * (T4b fix round, N3) What the W effect {@code w} found standing of its refunded cells, summed over its chunks' receipts, or null when it
	 * recorded none (no cells planned: the planned amounts stand). Throws when a chunk can't be read (the caller's effect holds).
	 */
	static java.util.@Nullable Map<String, Integer> found(TxnEntry t, Effect w) {
		if (!(w.data().get("cells") instanceof JsonArray)) {
			return null;
		}
		ServerLevel level = level(w);
		java.util.List<LevelChunk> cs = level == null ? null : chunks(t, level, w);
		if (cs == null) {
			throw new IllegalStateException("a chunk of its restore is not loaded");
		}
		java.util.List<java.util.Collection<String>> per = new java.util.ArrayList<>();
		for (LevelChunk ch : cs) {
			per.add(TestMove.receipts(ch));
		}
		return sumFound(per, w.key(t.id) + "@found=");
	}

	/** (N3; the T4 final round's seam) Whether a W apply adds its {@code pre} found receipt to a chunk holding {@code receipts}. Pure. */
	static boolean foundToAdd(java.util.Collection<String> receipts, String pre) {
		// (T4 final round, P1 4) unique per (W effect, chunk): a replay over a chunk that kept its receipt appends none (it recorded what stood
		// before the first write; the chunk was written since)
		for (String r : receipts) {
			if (r.startsWith(pre)) {
				return false;
			}
		}
		return true;
	}

	/** (N3; the T4 final round's seam) The found amounts of one W effect over its chunks' receipts, or null when none recorded any. Pure. */
	static java.util.@Nullable Map<String, Integer> sumFound(java.util.List<? extends java.util.Collection<String>> perChunk, String pre) {
		java.util.Map<String, Integer> sum = new java.util.TreeMap<>();
		boolean any = false;
		for (java.util.Collection<String> rs : perChunk) {
			for (String r : rs) {
				if (r.startsWith(pre)) {
					any = true;
					decode(r.substring(pre.length())).forEach((k, v) -> sum.merge(k, v, Integer::sum));
					break; // (T4 final round, P1 4) one per chunk: a duplicate written before this fix counts once
				}
			}
		}
		return any ? sum : null;
	}

	/** (N3) The amount a refund effect pays: its planned items, capped by its W's found amounts when it names one ({@code minOf}). */
	static java.util.Map<String, Integer> amount(TxnEntry t, Effect e) {
		if (e.data().has("pof") && e.data().get("pcells") instanceof JsonArray pc) {
			// (slice T4R-D, I2) a player-blocks OWE: the recorded items of its cells its W receipted gone (stood before, gone after): once
			java.util.Set<Long> gone = pgone(t, t.effects.get(e.data().get("pof").getAsInt()), pc);
			java.util.Map<String, Integer> sum = new java.util.TreeMap<>();
			for (var el : pc) {
				JsonObject c = el.getAsJsonObject();
				if (gone.contains(c.get("pos").getAsLong())) {
					c.getAsJsonObject("items").entrySet().forEach(x -> sum.merge(x.getKey(), x.getValue().getAsInt(), Integer::sum));
				}
			}
			return sum;
		}
		if (!e.data().has("minOf")) {
			return e.items();
		}
		return CrateSettle.minOf(e.items(), found(t, t.effects.get(e.data().get("minOf").getAsInt())));
	}

	static final TxnKind.Adapter PILE_REFUNDER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("owner") && e.data().has("key") && e.data().has("pos") ? null : "owner, key and pos are required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return CrateSettle.refundBooked(e.data().get("owner").getAsString(), e.data().get("key").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			CrateSettle.bookRefund(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), amount(t, e), TestMove.posOf(e));
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a refund is never a prepare effect");
		}
	};

	/**
	 * (slice T4R fix round, P1-1) The D effect of a {@code removal.group}: its decision is the group's journal undo, committed before the txn
	 * begins. Its probe reads the journal (APPLIED once the undo group is in it; UNKNOWN while the journal can't be read), so the txn adopts the
	 * commit and never aborts: a refused barrier holds it, retried. It is never applied here.
	 */
	public static final String UNDO = "group.undo";

	/**
	 * (slice T4R-D, D5) The R effect of a single removal's owner txn ({@code removal.site}): every member's result snapshotted (refund, owed
	 * parts with their applied amounts, the counts) into {@code stockpiles.json}'s removal results, published by the barrier after it, before
	 * the txn retires. Its probe reads the loaded table. Data {@code owner}.
	 */
	public static final String SNAPSHOT = "removal.snapshot";

	static final TxnKind.Adapter SNAPSHOTTER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("owner") ? null : "owner is required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return dev.larattalabs.architect.site.OwnerRemovals.snapshotted(e.data().get("owner").getAsString()) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			dev.larattalabs.architect.site.OwnerRemovals.snapshot(t, e.data().get("owner").getAsString(), amounts(t));
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never a prepare effect");
		}
	};

	/**
	 * (slice T4R-D, D5) What each L and O effect of {@code t} paid, by effect index: an O effect its applied amount (recorded with its marker),
	 * an L effect its amount (planned, capped by its W's found receipts). Throws while one can't be read (held, retried).
	 */
	public static java.util.Map<Integer, java.util.Map<String, Integer>> amounts(TxnEntry t) {
		java.util.Map<Integer, java.util.Map<String, Integer>> out = new java.util.TreeMap<>();
		for (Effect f : t.effects) {
			if (CrateTxn.OWE.equals(f.op())) {
				java.util.Map<String, Integer> a = dev.larattalabs.architect.site.OwedLedger.amountOf(f.key(t.id));
				if (a == null) {
					throw new IllegalStateException("effect " + f.i() + "'s owed amount is not recorded");
				}
				out.put(f.i(), a);
			} else if (CrateTxn.PILE_CREDIT.equals(f.op()) || PILE_REFUND.equals(f.op())) {
				out.put(f.i(), amount(t, f));
			}
		}
		return out;
	}

	/** (TEST seam) Whether undo group {@code g} reached the world journal. */
	static java.util.function.Predicate<String> UNDO_COMMITTED = dev.larattalabs.architect.site.Groups::undoInJournal;

	/** (slice T4R-D) Whether undo group {@code g} reached the world journal (an owner record's decision). */
	public static boolean undoCommitted(String g) {
		return UNDO_COMMITTED.test(g);
	}

	/** (slice T4R fix round, P1-1) {@link #UNDO} for undo group {@code undo}. */
	public static Effect.Builder undoDecision(String undo) {
		return Effect.of(UNDO, EffectClass.D).data("group", undo);
	}

	static final TxnKind.Adapter UNDO_DECIDER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("group") ? null : "group is required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			if (UNDO_COMMITTED.test(e.data().get("group").getAsString())) {
				return Probe.APPLIED;
			}
			return CrateSettle.journalUnreadable() ? Probe.UNKNOWN : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			throw new IllegalStateException("the group's undo commits in the world journal, never here: held until it reads committed");
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a decision is never compensated");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "the world journal's undo group " + e.data().get("group").getAsString();
		}
	};

	/** (slice T4R) {@link #GROUP_DONE}: applied (a no-op) once its group's removal ended; while the removal runs it waits. */
	static final TxnKind.Adapter GROUP_DONER = new TxnKind.Adapter() {
		@Override
		public @Nullable String invalid(Effect e) {
			return e.data().has("group") ? null : "group is required";
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return dev.larattalabs.architect.site.Groups.liveRemoval(t.key) ? Probe.ABSENT : Probe.APPLIED;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			if (dev.larattalabs.architect.site.Groups.liveRemoval(t.key)) {
				throw new IllegalStateException("waits for its group's removal to end");
			}
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("never a prepare effect");
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "the removal of group " + e.data().get("group").getAsString();
		}
	};

	static TxnKind kind(String name) {
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
			public TxnKind.Adapter adapter(Effect e) {
				return switch (e.op()) {
					case RESTORE -> RESTORER;
					case PILE_REFUND -> PILE_REFUNDER;
					case GROUP_DONE -> GROUP_DONER;
					case UNDO -> UNDO_DECIDER;
					case SNAPSHOT -> SNAPSHOTTER;
					case CrateTxn.TAKE -> CrateTxn.ADAPTER;
					case CrateTxn.RESTORE -> CrateTxn.RESTORE_ADAPTER;
					case CrateTxn.RELEASE -> CrateTxn.RELEASER;
					case CrateTxn.PILE_CREDIT -> CrateTxn.CREDITOR;
					case CrateTxn.OWE -> CrateTxn.OWER;
					default -> null;
				};
			}

			@Override
			public com.google.gson.JsonObject result(TxnEntry t) {
				return CrateTxn.resultOf(t); // (T4b fix round, P2) its owed keys, replayed from the cache
			}
		};
	}

	public static final TxnKind ROAD_KIND = kind(ROAD);

	/**
	 * (slice T4R-D, I5) {@code removal.site}: one single removal's owner txn ({@code removal:<base>@<undoGroup>}), decided by its committed
	 * journal undo ({@link #UNDO}), never aborted; it owns every member's W, settle, OWE, snapshot and events.
	 */
	public static final TxnKind SITE_KIND = new TxnKind() {
		final TxnKind base = kind(SITE);

		@Override
		public String name() {
			return SITE;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public String decider() {
			return "journal";
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return base.adapter(e);
		}

		@Override
		public com.google.gson.JsonObject result(TxnEntry t) {
			return base.result(t);
		}
	};

	/** (slice T4R fix round, P1-1) {@code removal.group}: decided by its committed journal undo ({@link #UNDO}), never by its own file. */
	public static final TxnKind GROUP_KIND = new TxnKind() {
		final TxnKind base = kind(GROUP);

		@Override
		public String name() {
			return GROUP;
		}

		@Override
		public int kv() {
			return 1;
		}

		@Override
		public String decider() {
			return "journal";
		}

		/**
		 * (slice T4R fix round, Steward's changes §1) A revision undo's stage removal answers Steward's aliases at its txn's points: RVU1 at its
		 * decision (the committed undo adopted: D applied and recorded), RVU2 at its effects' barrier (the region drained, every member written
		 * and settled, still after D, before its event and retirement). Both finish after a restart (the txn recovers forward).
		 */
		@Override
		public @Nullable String alias(TxnEntry t, String step) {
			if (!(t.payloads.get("removal_finished") instanceof com.google.gson.JsonObject p) || !p.has("revisionId")) {
				return null;
			}
			if ("decided".equals(step)) {
				return "RVU1";
			}
			return "barrier:effects".equals(step) ? "RVU2" : null;
		}

		@Override
		public TxnKind.Adapter adapter(Effect e) {
			return base.adapter(e);
		}

		@Override
		public com.google.gson.JsonObject result(TxnEntry t) {
			return base.result(t);
		}
	};

	/**
	 * (T4 final round, P1 3) The site or road whose removal {@code t} settles ({@code ""} when {@code t} is no removal's txn): its W restore's
	 * site, else its effects' {@code site}.
	 */
	static String siteOf(TxnEntry t) {
		if (!t.kind.startsWith("removal.")) {
			return "";
		}
		for (Effect e : t.effects) {
			if (e.data().has("site")) {
				return e.data().get("site").getAsString();
			}
		}
		return "";
	}

	/**
	 * (slice T4R-L, the final check's P1-1) The sites whose removal holds accept {@code t}'s adapter writes ({@code TxnServer.boxHeld}): every
	 * site its effects name and every member it settles (a {@code removal.group} txn writes each member's restore, not only its first's); empty
	 * when {@code t} is no removal's txn. Any other removal's hold still refuses it.
	 */
	public static java.util.Set<String> sitesOf(TxnEntry t) {
		if (!t.kind.startsWith("removal.")) {
			return java.util.Set.of();
		}
		java.util.Set<String> out = new java.util.HashSet<>();
		for (Effect e : t.effects) {
			if (e.data().has("site")) {
				out.add(e.data().get("site").getAsString());
			}
			if (e.member() != null) {
				out.add(e.member());
			}
		}
		return out;
	}

	/** (slice T4R, P1-4) A group's REMOVAL_FINISHED from its txn's payload and result: kind region or group (never both), the full result. */
	static dev.larattalabs.architect.api.RemovalFinished finished(TxnEntry t, com.google.gson.JsonObject p) {
		com.google.gson.JsonObject res = t.result != null && t.result.has("refund") ? t.result : CrateTxn.resultOf(t);
		java.util.Map<String, Integer> refund = CrateTxn.itemsOf(p, "drops");
		CrateTxn.itemsOf(res, "refund").forEach((k, v) -> refund.merge(k, v, Integer::sum));
		java.util.Map<String, Integer> handed = CrateTxn.itemsOf(p, "handed");
		java.util.List<String> cascaded = new java.util.ArrayList<>();
		if (p.get("cascaded") instanceof JsonArray c) {
			c.forEach(x -> cascaded.add(x.getAsString()));
		}
		java.util.List<String> owed = new java.util.ArrayList<>();
		if (res.get("owed") instanceof JsonArray o) {
			o.forEach(x -> owed.add(x.getAsString()));
		}
		if (p.get("owed") instanceof JsonArray po) {
			po.forEach(x -> {
				if (!owed.contains(x.getAsString())) {
					owed.add(x.getAsString()); // (fix round, P1-6) its data cargo's owed keys
				}
			});
		}
		dev.larattalabs.architect.api.RemoveResult rr = new dev.larattalabs.architect.api.RemoveResult(true, List.of(), dev.larattalabs.architect.apiimpl.Views.items(
			refund), p.has("restored") ? p.get("restored").getAsInt() : 0, p.has("kept") ? p.get("kept").getAsInt() : 0, handed, cascaded, owed);
		String stage = p.has("stage") ? p.get("stage").getAsString() : null;
		Integer rid = p.has("revisionId") ? p.get("revisionId").getAsInt() : null;
		String region = p.has("region") ? p.get("region").getAsString() : null;
		return dev.larattalabs.architect.apiimpl.ApiEvents.finishedOf(p.get("group").getAsString(), stage, rid, region, rr);
	}

	/** (slice T4R fix round) Whether {@code t} removes a site whose own removal writes now ({@link CrateSettle#WRITING}): its boxes accept it. */
	static boolean writingOwn(TxnEntry t) {
		java.util.Set<String> w = CrateSettle.WRITING;
		if (w.isEmpty()) {
			return false;
		}
		for (Effect e : t.effects) {
			if (e.data().has("site") && w.contains(e.data().get("site").getAsString())) {
				return true;
			}
		}
		return false;
	}

	/** A removal box (N3): {@code rbox:<dim>@x0,y0,z0:x1,y1,z1}. While an open removal txn names one, no player breaks a block in it. */
	public static String box(String dim, int x0, int y0, int z0, int x1, int y1, int z1) {
		return "rbox:" + dim + "@" + x0 + "," + y0 + "," + z0 + ":" + x1 + "," + y1 + "," + z1;
	}

	/** Whether {@code pos} lies in a removal box an open (or retiring) removal txn names (N3's hold). O(open txns), none open: O(1). */
	public static boolean boxHeld(String dim, int x, int y, int z) {
		return boxHeld(dim, x, y, z, null);
	}

	/** {@link #boxHeld}, {@code writer}'s own removal box exempt (its adapters write there). */
	public static boolean boxHeld(String dim, int x, int y, int z, @Nullable TxnEntry writer) {
		TxnCore c = TxnServer.core();
		if (c.holds().isEmpty()) {
			return false;
		}
		for (TxnEntry t : c.open()) {
			if (!t.kind.startsWith("removal.") || t == writer || writingOwn(t)) {
				continue;
			}
			for (String r : t.resources) {
				if (r.startsWith("rbox:") && inBox(r, dim, x, y, z)) {
					return true;
				}
			}
		}
		return false;
	}

	static boolean inBox(String r, String dim, int x, int y, int z) {
		int at = r.lastIndexOf('@');
		if (at < 0 || !r.substring(5, at).equals(dim)) {
			return false;
		}
		String[] ab = r.substring(at + 1).split(":");
		if (ab.length != 2) {
			return false;
		}
		String[] a = ab[0].split(","), b = ab[1].split(",");
		try {
			return x >= Integer.parseInt(a[0]) && y >= Integer.parseInt(a[1]) && z >= Integer.parseInt(a[2]) && x <= Integer.parseInt(b[0])
				&& y <= Integer.parseInt(b[1]) && z <= Integer.parseInt(b[2]);
		} catch (NumberFormatException e) {
			return false;
		}
	}
}
