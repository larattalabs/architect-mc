package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.survival.Refunds;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R-D, D1a/D2/D5; design rev 3 "Decisions part 4": the direct-write core) A single removal call (a site and its cascade) has one
 * durable <b>owner record</b> and one <b>owner txn</b> ({@code removal.site}, key {@code removal:<base>@<undoGroup>}), decided by the
 * committed journal undo (never aborted). The record is saved confirmed in {@code stockpiles.json} ({@code removals}) before the undo commits
 * whenever a member is paid or has player cells; it holds every member's box and crate cell (its footprint) from then until it is forgotten
 * (RD2), and the owner txn's writer exemption covers every member it names. Recovery builds the txn from the record alone.
 * <p>
 * Per member, in the record's order: its W {@code site.restore} (receipted per chunk; the player's cells {@code pfound} before the first
 * write and {@code @pgone} after it), a member barrier, its settle (crate, pile refund; min of its W) and one OWE {@code player_blocks} per
 * recipient (only the cells its W receipted gone), a member barrier; then {@code removal.snapshot} (each member's immutable result into
 * {@code removalResults}); then the core's effects barrier, one REMOVAL_FINISHED per member from its snapshot, retirement. After it: the
 * pending records saved confirmed (RD1, {@link Sites#saveConfirmed}), then the record forgotten in one confirmed ledger save (RD2), then
 * auto-collect of the player's blocks for online recipients ({@link AutoCollect}).
 * <p>
 * No player block becomes an item entity on this path: it is owed, once.
 */
public final class OwnerRemovals {
	private OwnerRemovals() {
	}

	/** Owner key -> its record (stockpiles.json {@code removals}). */
	private static final Map<String, JsonObject> RECORDS = new TreeMap<>();
	/** (D5, Q8b) {@code <kind>:<id>} -> the last completed result; {@code owner:<key>} marks an owner's snapshot. At most {@link #RESULT_BOUND}. */
	private static final LinkedHashMap<String, JsonObject> RESULTS = new LinkedHashMap<>();
	static final int RESULT_BOUND = 1024;
	/** Owner key -> its txn begun this session (transient; a restart attaches through the core). */
	private static final Map<String, TxnEntry> LIVE = new java.util.HashMap<>();
	/** Owner keys whose txn retired this session, waiting for RD1/RD2 (transient: a restart replays the key and runs them). */
	private static final Set<String> FINISHING = new LinkedHashSet<>();

	public static String key(String base, String undo) {
		return "removal:" + base + "@" + undo;
	}

	// ------------------------------------------------------------------ persistence (stockpiles.json)

	static synchronized boolean empty() {
		return RECORDS.isEmpty() && RESULTS.isEmpty();
	}

	static synchronized @Nullable JsonObject recordsJson() {
		if (RECORDS.isEmpty()) {
			return null;
		}
		JsonObject o = new JsonObject();
		RECORDS.forEach((k, v) -> o.add(k, v.deepCopy()));
		return o;
	}

	static synchronized @Nullable JsonObject resultsJson() {
		if (RESULTS.isEmpty()) {
			return null;
		}
		JsonObject o = new JsonObject();
		RESULTS.forEach((k, v) -> o.add(k, v.deepCopy()));
		return o;
	}

	static synchronized void read(@Nullable JsonElement records, @Nullable JsonElement results) {
		RECORDS.clear();
		RESULTS.clear();
		LIVE.clear();
		FINISHING.clear();
		scheduled = false; // (a world's load) a recovery tick queued by an earlier world never ran
		if (records instanceof JsonObject o) {
			o.entrySet().forEach(e -> RECORDS.put(e.getKey(), e.getValue().getAsJsonObject()));
		}
		if (results instanceof JsonObject o) {
			o.entrySet().forEach(e -> RESULTS.put(e.getKey(), e.getValue().getAsJsonObject()));
		}
		CrateSettle.boxesChanged();
	}

	/** (TEST seam, dev.removal.owners) The records as they are now. */
	public static synchronized Map<String, JsonObject> records() {
		Map<String, JsonObject> m = new TreeMap<>();
		RECORDS.forEach((k, v) -> m.put(k, v.deepCopy()));
		return m;
	}

	static synchronized @Nullable JsonObject record(String key) {
		JsonObject o = RECORDS.get(key);
		return o == null ? null : o.deepCopy();
	}

	static synchronized void put(String key, JsonObject rec) {
		RECORDS.put(key, rec.deepCopy());
		Stockpiles.owedChanged();
		CrateSettle.boxesChanged();
	}

	static synchronized void forget(String key) {
		if (RECORDS.remove(key) != null) {
			Stockpiles.owedChanged();
			CrateSettle.boxesChanged();
		}
		LIVE.remove(key);
	}

	// ------------------------------------------------------------------ recipients (Q1, Q7)

	/** The recipient of a player's cell: its PT placer, else the site's recipient, else (unowned) the requester, else unclaimed. Pure. */
	static String recipient(@Nullable String placer, String siteRecipient, @Nullable String requester) {
		if (placer != null && !placer.isEmpty()) {
			return placer;
		}
		if (siteRecipient != null && !"architect:unowned".equals(siteRecipient)) {
			return siteRecipient;
		}
		return requester != null && !requester.isEmpty() ? requester : OwedLedger.UNCLAIMED;
	}

	// ------------------------------------------------------------------ the record

	static JsonArray box(dev.larattalabs.architect.placement.Anchors.Bounds b) {
		JsonArray a = new JsonArray();
		for (int v : new int[] {b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()}) {
			a.add(v);
		}
		return a;
	}

	/** A member's player cells with recipients resolved ({pos, block, items, recipient}). */
	static JsonArray playerOf(Site s, Refunds.@Nullable Tally t, @Nullable String requester) {
		JsonArray a = new JsonArray();
		if (t == null) {
			return a;
		}
		String rec = CrateSettle.recipientOf(s);
		for (Refunds.Cell c : t.playerCells()) {
			JsonObject x = new JsonObject();
			x.addProperty("pos", c.pos());
			x.addProperty("block", c.block());
			x.add("items", Builder.counts(c.items()));
			x.addProperty("recipient", recipient(c.recipient(), rec, requester));
			a.add(x);
		}
		return a;
	}

	/** Whether a single removal needs an owner record: a member is paid (a stash) or has player cells. Pure. */
	static boolean needed(Map<String, @Nullable JsonObject> stashes, Map<String, Builder.Deconstruction> decs) {
		for (JsonObject st : stashes.values()) {
			if (st != null) {
				return true;
			}
		}
		for (Builder.Deconstruction d : decs.values()) {
			if (d != null && !d.tally().playerCells().isEmpty()) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The owner record of a single removal of {@code base} in undo group {@code undo}: {@code order} its roads and cell sites first, then its
	 * sites top first, the base last; per member its box, its stash ({@code settle}, null when unpaid), its player cells and its result parts
	 * ({@code fin}). Pure of the world.
	 */
	static JsonObject build(String base, String undo, String dim, @Nullable String requester, String title, List<String> infra, List<Site> sites,
		Map<String, Builder.Deconstruction> decs, Map<String, @Nullable JsonObject> stashes, Map<String, JsonObject> fins) {
		JsonObject o = new JsonObject();
		o.addProperty("v", 1);
		o.addProperty("kind", "site");
		o.addProperty("base", base);
		o.addProperty("undoGroup", undo);
		o.addProperty("dim", dim);
		o.addProperty("title", title);
		if (requester != null) {
			o.addProperty("requester", requester);
		}
		JsonArray order = new JsonArray();
		JsonObject members = new JsonObject();
		for (String c : infra) {
			Infra inf = Infras.get(c) != null ? Infras.get(c) : Infras.pending(c);
			if (inf == null) {
				continue;
			}
			order.add(c);
			JsonObject m = new JsonObject();
			JsonObject st = stashes.get(c); // (fix round P1-7) a paid road's stash, as its standalone removal's: its refunds settle in this txn
			m.addProperty("paid", st != null);
			m.addProperty("infra", true);
			m.add("box", box(inf.box()));
			if (st != null) {
				m.add("settle", st.deepCopy());
			}
			m.add("player", new JsonArray());
			members.add(c, m);
		}
		for (Site x : sites) {
			order.add(x.id());
			JsonObject m = new JsonObject();
			JsonObject st = stashes.get(x.id());
			m.addProperty("paid", st != null);
			m.add("box", box(x.restoreBox()));
			if (st != null) {
				m.add("settle", st.deepCopy());
			}
			Builder.Deconstruction d = decs.get(x.id());
			m.add("player", playerOf(x, d == null ? null : d.tally(), requester));
			JsonObject fin = fins.get(x.id());
			if (fin != null) {
				m.add("fin", fin.deepCopy());
			}
			m.addProperty("title", Sites.describe(x.id()));
			members.add(x.id(), m);
		}
		o.add("order", order);
		o.add("members", members);
		o.add("r1", new JsonArray());
		return o;
	}

	// ------------------------------------------------------------------ holds (I6: the footprint)

	/** The holds of every record, as pseudo-stashes for {@link CrateSettle#heldOf}: each member's box and crate cell, named by the member. */
	static synchronized List<JsonObject> holds() {
		List<JsonObject> out = new ArrayList<>();
		for (JsonObject r : RECORDS.values()) {
			out.addAll(holdsOf(r));
		}
		return out;
	}

	/** One record's holds (pure). */
	static List<JsonObject> holdsOf(JsonObject r) {
		List<JsonObject> out = new ArrayList<>();
		{
			String dim = r.get("dim").getAsString();
			for (var e : r.getAsJsonObject("members").entrySet()) {
				JsonObject m = e.getValue().getAsJsonObject();
				if (m.get("box") instanceof JsonArray b) {
					JsonObject h = new JsonObject();
					h.addProperty("dim", dim);
					h.addProperty("site", e.getKey());
					h.add("box", b.deepCopy());
					if (m.get("hold") instanceof JsonArray hc) {
						h.add("hold", hc.deepCopy()); // (Adopt PT2) its delta cells only
					}
					out.add(h);
				}
				if (m.get("settle") instanceof JsonObject st && CrateSettle.hasCrate(st)) {
					BlockPos p = CrateSettle.posOf(st);
					JsonObject h = new JsonObject();
					h.addProperty("dim", st.get("dim").getAsString());
					h.addProperty("site", e.getKey());
					JsonArray b = new JsonArray();
					for (int v : new int[] {p.getX(), p.getY(), p.getZ(), p.getX(), p.getY(), p.getZ()}) {
						b.add(v);
					}
					h.add("box", b);
					out.add(h);
				}
			}
		}
		return out;
	}

	/** The areas of every record's footprint, for admission ({@link RemovalAreas}): each member's box and crate cell. */
	static synchronized void areas(List<RemovalAreas.Area> out) {
		for (var r : RECORDS.entrySet()) {
			for (JsonObject h : holdsOf(r.getValue())) {
				JsonArray b = h.getAsJsonArray("box");
				out.add(new RemovalAreas.Area(h.get("dim").getAsString(), new dev.larattalabs.architect.placement.Anchors.Bounds(b.get(0).getAsInt(), b.get(1)
					.getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), "the removal of " + r.getValue().get("base")
						.getAsString(), h.get("site").getAsString()));
			}
		}
	}

	/** The live owner record naming {@code member} (pending or standing), or null. */
	public static synchronized @Nullable String ownerOf(String member) {
		for (var r : RECORDS.entrySet()) {
			if (r.getValue().getAsJsonObject("members").has(member)) {
				return r.getKey();
			}
		}
		return null;
	}

	/** (A2) The base and owner of the live record {@code key}, for a typed busy answer: [base, owner id or null]. */
	static synchronized String @Nullable [] who(String key) {
		JsonObject r = RECORDS.get(key);
		if (r == null) {
			return null;
		}
		String base = r.get("base").getAsString();
		Site s = Sites.pendingRecord(base) != null ? Sites.pendingRecord(base) : Sites.get(base);
		return new String[] {base, s == null ? null : s.owner()};
	}

	/** (Sites check) {@code id|undoGroup} of every member of every record in {@code stockpiles.json} {@code f}: owned, never judged. */
	static void ownedAtStart(java.nio.file.Path f, Set<String> out) throws java.io.IOException {
		if (!java.nio.file.Files.isRegularFile(f)) {
			return;
		}
		JsonObject root = com.google.gson.JsonParser.parseString(java.nio.file.Files.readString(f, java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject();
		if (root.get("removals") instanceof JsonObject rs) {
			for (var e : rs.entrySet()) {
				JsonObject r = e.getValue().getAsJsonObject();
				String g = r.get("undoGroup").getAsString();
				r.getAsJsonObject("members").keySet().forEach(id -> out.add(id + "|" + g));
			}
		}
	}

	// ------------------------------------------------------------------ the owner txn

	/** Its resources: a box per member, every crate cell and pile its settles touch. */
	static List<String> resources(JsonObject rec) {
		Set<String> res = new LinkedHashSet<>();
		String dim = rec.get("dim").getAsString();
		res.add("site:" + key(rec.get("base").getAsString(), rec.get("undoGroup").getAsString()));
		for (var e : rec.getAsJsonObject("members").entrySet()) {
			JsonObject m = e.getValue().getAsJsonObject();
			if (m.get("box") instanceof JsonArray b) {
				res.add(RemovalTxn.box(dim, b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5)
					.getAsInt()));
			}
			if (m.get("settle") instanceof JsonObject st) {
				if (CrateSettle.hasCrate(st)) {
					res.add(dev.larattalabs.architect.txn.CrateTxn.resource(st.get("dim").getAsString(), CrateSettle.posOf(st)));
				}
				if (st.has("pile") && Stockpiles.get(st.get("pile").getAsString()) != null) {
					res.add("pile:" + st.get("pile").getAsString());
				}
			}
		}
		return List.copyOf(res);
	}

	/** The cells whose chunks a member's W receipts: its refund cells and its player cells. */
	static @Nullable JsonArray chunkCells(@Nullable JsonArray cells, JsonArray player) {
		if (cells == null && player.isEmpty()) {
			return null;
		}
		JsonArray a = new JsonArray();
		if (cells != null) {
			cells.forEach(a::add);
		}
		player.forEach(a::add);
		return a;
	}

	/**
	 * Begins (or attaches to, or replays) the owner txn of record {@code key}. Null once it is begun, attached or replayed; else why it waits.
	 * Server thread.
	 */
	static @Nullable String begin(MinecraftServer srv, String key) {
		if (LIVE.containsKey(key) || FINISHING.contains(key)) {
			return null;
		}
		JsonObject rec = record(key);
		if (rec == null) {
			return null;
		}
		String why = CrateSettle.notReady();
		if (why != null) {
			return why;
		}
		TxnCore c = TxnServer.core();
		String undo = rec.get("undoGroup").getAsString();
		Site bs = Sites.pendingRecord(rec.get("base").getAsString());
		TxnCore.Started s = c.begin(RemovalTxn.SITE, key, resources(rec), bs == null ? null : bs.owner());
		switch (s.status()) {
			case UNAVAILABLE:
				return "records unreadable (" + s.detail() + ")";
			case HELD:
				return "held: " + s.detail();
			case REPLAYED:
				FINISHING.add(key); // retired already (a crash before RD2): its cleanup runs
				return null;
			case ATTACHED:
				LIVE.put(key, s.entry());
				return null;
			default:
				break;
		}
		TxnEntry t = s.entry();
		c.plan(t, RemovalTxn.undoDecision(undo));
		String dim = rec.get("dim").getAsString();
		ServerLevel level = Sites.levelOf(srv, dim);
		if (level == null) {
			return dim + " is not loaded";
		}
		JsonObject members = rec.getAsJsonObject("members");
		List<String> sites = new ArrayList<>();
		for (JsonElement el : rec.getAsJsonArray("order")) {
			String m = el.getAsString();
			JsonObject mm = members.getAsJsonObject(m);
			JsonObject st = mm.get("settle") instanceof JsonObject x ? x : null;
			JsonArray cells = st != null && st.get("cells") instanceof JsonArray ca ? ca : null;
			JsonArray player = mm.get("player") instanceof JsonArray pa ? pa : new JsonArray();
			int w = -1;
			if (CrateSettle.undoneExists(m, undo)) {
				try {
					Effect.Builder wb = RemovalTxn.restore(dim, m, undo, CrateSettle.chunksOf(level, m, undo, chunkCells(cells, player)), cells).member(m).data("clear",
						new com.google.gson.JsonPrimitive(true));
					if (!player.isEmpty()) {
						JsonArray pc = new JsonArray();
						player.forEach(p -> {
							JsonObject q = new JsonObject();
							q.add("pos", p.getAsJsonObject().get("pos"));
							q.add("block", p.getAsJsonObject().get("block"));
							pc.add(q);
						});
						wb.data("pkey", key + "/" + m).data("pcells", pc);
					}
					w = c.plan(t, wb).i();
				} catch (Sites.SiteException e) {
					return "the restore of " + m + " can't be read: " + e.getMessage();
				}
			}
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(m));
			if (st != null) {
				for (Effect.Builder b : CrateSettle.planInto(level, st, w, m, new LinkedHashSet<>())) {
					c.plan(t, b);
				}
			}
			if (w >= 0 && !player.isEmpty()) {
				for (Effect.Builder b : playerOwes(key, m, dim, w, player)) {
					c.plan(t, b);
				}
			}
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(m));
			if (!mm.has("infra") || !mm.get("infra").getAsBoolean()) {
				sites.add(m);
			}
		}
		c.plan(t, Effect.of(RemovalTxn.SNAPSHOT, EffectClass.R).data("owner", key));
		for (String m : sites) {
			JsonObject p = new JsonObject();
			p.addProperty("owner", key);
			p.addProperty("member", m);
			c.payload(t, "removal_finished:" + m, p); // (D5) one REMOVAL_FINISHED per member, from its snapshot
		}
		DurableFile.Outcome o = c.persist(t);
		if (o == DurableFile.Outcome.REFUSED) {
			return "txn.json refused its intent";
		}
		LIVE.put(key, t);
		Architect.LOGGER.info("Removal of {}: owner txn {} ({}) begun over {} member(s) (undo {})", rec.get("base").getAsString(), t.id, key, members.size(),
			undo);
		return null;
	}

	/** One OWE {@code player_blocks} per recipient of {@code member}'s player cells, paid from its W ({@code w})'s receipts. Pure. */
	static List<Effect.Builder> playerOwes(String key, String member, String dim, int w, JsonArray player) {
		return playerOwes0("player:" + key + "/" + member, member, dim, w, player);
	}

	/** {@link #playerOwes} keyed {@code <prefix>:<recipient>} (an extraction: {@code player:<extraction key>:<recipient>}). Pure. */
	static List<Effect.Builder> playerOwes0(String prefix, String member, String dim, int w, JsonArray player) {
		Map<String, JsonArray> by = new LinkedHashMap<>();
		Map<String, Map<String, Integer>> planned = new LinkedHashMap<>();
		for (JsonElement el : player) {
			JsonObject c = el.getAsJsonObject();
			String r = c.get("recipient").getAsString();
			JsonObject q = new JsonObject();
			q.add("pos", c.get("pos"));
			q.add("items", c.get("items"));
			by.computeIfAbsent(r, k -> new JsonArray()).add(q);
			Map<String, Integer> m = planned.computeIfAbsent(r, k -> new TreeMap<>());
			c.getAsJsonObject("items").entrySet().forEach(x -> m.merge(x.getKey(), x.getValue().getAsInt(), Integer::sum));
		}
		List<Effect.Builder> out = new ArrayList<>();
		for (var e : by.entrySet()) {
			BlockPos at = BlockPos.of(e.getValue().get(0).getAsJsonObject().get("pos").getAsLong());
			out.add(Effect.of(dev.larattalabs.architect.txn.CrateTxn.OWE, EffectClass.O).items(planned.get(e.getKey())).move("world", "owed").data("key", prefix + ":"
				+ e.getKey()).data("recipient", e.getKey()).data("dim", dim).data("pos", CrateSettle.posJsonOf(at)).data("reason",
					OwedLedger.PLAYER_BLOCKS).data("site", member).data("pof", w).data("pcells", e.getValue()).member(member));
		}
		return out;
	}

	/**
	 * Drives the owner txn of {@code key} as far as it goes now, then (once retired) RD1, RD2 and auto-collect. Null when it is done (or gone);
	 * else why it is held. Server thread.
	 */
	static @Nullable String drive(MinecraftServer srv, String key) {
		String why = begin(srv, key);
		if (why != null) {
			return why;
		}
		TxnEntry t = LIVE.get(key);
		if (t != null) {
			TxnCore c = TxnServer.core();
			if (c.get(t.id) != null) {
				c.drive(t);
				if (c.get(t.id) != null) {
					return t.held() != null ? t.held() : "in progress";
				}
			}
			if (c.cache().committed(key) == null) {
				LIVE.remove(key); // (never: journal-decided) begun again
				return "its owner txn ended without its commit: begun again";
			}
			LIVE.remove(key);
			FINISHING.add(key);
		}
		if (FINISHING.contains(key)) {
			return cleanup(srv, key);
		}
		return null;
	}

	/** (TEST) kill points RD1 (pending saved, record not forgotten) and RD2 (record forgotten, not yet collected). */
	static @Nullable String cleanup(MinecraftServer srv, String key) {
		JsonObject rec = record(key);
		if (rec == null) {
			FINISHING.remove(key);
			return null;
		}
		// RD1: the pending records, as the removal left them, confirmed on disk before the record goes (I11)
		String no = Sites.saveConfirmed(srv);
		if (no != null) {
			return "RD1 held: " + no;
		}
		dev.larattalabs.architect.journal.WorldJournal.kill("RD1");
		forget(key);
		try {
			Stockpiles.saveWithWorldConfirmed(srv);
		} catch (IllegalStateException e) {
			put(key, rec); // RD2 held: the record stays, retried (a later start replays the key and runs it again)
			return "RD2 held: " + e.getMessage();
		}
		dev.larattalabs.architect.journal.WorldJournal.kill("RD2");
		FINISHING.remove(key);
		Architect.LOGGER.info("Removal of {}: owner {} retired; its record forgotten", rec.get("base").getAsString(), key);
		AutoCollect.afterRetire(srv, rec, results(key));
		return null;
	}

	/** Every record's txn driven (a start's recovery, then each tick while one is held). Server thread. */
	static void driveAll(MinecraftServer srv) {
		for (String k : List.copyOf(RECORDS.keySet())) {
			JsonObject rec = record(k);
			if (rec == null) {
				continue;
			}
			if (!LIVE.containsKey(k) && !FINISHING.contains(k) && TxnServer.core().open().stream().noneMatch(t -> k.equals(t.key)) && TxnServer.core().cache()
				.committed(k) == null && !RemovalTxn.undoCommitted(rec.get("undoGroup").getAsString())) {
				if (CrateSettle.journalUnreadable()) {
					continue;
				}
				// FKC1: the record saved, the undo never committed: nothing of it happened; the record and its holds go
				Architect.LOGGER.info("Removal of {}: its undo never committed (a stop before it): its owner record goes, nothing paid", rec.get("base")
					.getAsString());
				forget(k);
				try {
					Stockpiles.saveWithWorldConfirmed(srv);
				} catch (IllegalStateException e) {
					put(k, rec);
				}
				continue;
			}
			drive(srv, k);
		}
	}

	private static boolean scheduled;

	/** Recovery on the first tick after every store loaded, then each tick while a record is left. */
	static void startLater(MinecraftServer srv) {
		if (scheduled) {
			return;
		}
		scheduled = true;
		TxnServer.later(() -> tickLater(srv));
	}

	private static void tickLater(MinecraftServer srv) {
		scheduled = false;
		synchronized (OwnerRemovals.class) {
			if (RECORDS.isEmpty()) {
				return;
			}
		}
		if (SaveHold.admits(srv) && CrateSettle.notReady() == null) {
			driveAll(srv);
		}
		synchronized (OwnerRemovals.class) {
			if (RECORDS.isEmpty()) {
				return;
			}
		}
		startLater(srv);
	}

	// ------------------------------------------------------------------ the snapshot (D5, I10)

	/** Whether owner {@code key}'s snapshot is in the loaded results table (the probe of {@code removal.snapshot}). */
	public static synchronized boolean snapshotted(String key) {
		return RESULTS.containsKey("owner:" + key);
	}

	/**
	 * Writes each member's immutable result (refund: its L amounts; owed parts: its O effects' applied amounts; restored, kept, hand-down,
	 * cascade from its record) into the results table, under {@code site:<member>} and {@code owner:<key>}; the barrier after it publishes it.
	 */
	public static void snapshot(TxnEntry t, String key, Map<Integer, Map<String, Integer>> amounts, @Nullable JsonObject groupPayload) {
		JsonObject rec = record(key);
		if (rec == null && groupPayload != null) {
			groupSnapshot(t, key, amounts, groupPayload);
			return;
		}
		JsonObject members = rec == null ? new JsonObject() : rec.getAsJsonObject("members");
		JsonObject all = new JsonObject();
		Map<String, JsonObject> per = new LinkedHashMap<>();
		for (Effect e : t.effects()) {
			String m = e.member();
			if (m == null || !amounts.containsKey(e.i())) {
				continue;
			}
			JsonObject r = per.computeIfAbsent(m, k -> fresh(members.get(k) instanceof JsonObject mm ? mm : new JsonObject()));
			Map<String, Integer> a = amounts.get(e.i());
			if (dev.larattalabs.architect.txn.CrateTxn.OWE.equals(e.op())) {
				if (!a.isEmpty()) {
					JsonObject p = new JsonObject();
					p.addProperty("key", e.data().get("key").getAsString());
					p.addProperty("recipient", e.data().get("recipient").getAsString());
					p.addProperty("reason", e.data().get("reason").getAsString());
					p.add("items", Builder.counts(a));
					r.getAsJsonArray("owedParts").add(p);
				}
			} else {
				JsonObject rf = r.getAsJsonObject("refund");
				a.forEach((k, v) -> rf.addProperty(k, (rf.has(k) ? rf.get(k).getAsInt() : 0) + v));
			}
		}
		for (String m : members.keySet()) {
			per.computeIfAbsent(m, k -> fresh(members.getAsJsonObject(k)));
		}
		synchronized (OwnerRemovals.class) {
			per.forEach((m, r) -> {
				all.add(m, r);
				putResult("site:" + m, r);
			});
			putResult("owner:" + key, all);
		}
		Stockpiles.owedChanged();
	}

	/**
	 * (D5, D1b) A group's, stage's, region's or revision's one aggregate result: every member's L amounts and O parts summed, the counts from its
	 * payload; under {@code group:<id>} or {@code region:<id>}, {@code stage:<group>/<stage>}, the alias {@code revision:<region>#<rid>}.
	 */
	static void groupSnapshot(TxnEntry t, String key, Map<Integer, Map<String, Integer>> amounts, JsonObject p) {
		JsonObject r = fresh(new JsonObject());
		r.addProperty("restored", p.has("restored") ? p.get("restored").getAsInt() : 0);
		r.addProperty("kept", p.has("kept") ? p.get("kept").getAsInt() : 0);
		r.add("handed", p.get("handed") instanceof JsonObject h ? h.deepCopy() : new JsonObject());
		r.add("cascaded", p.get("cascaded") instanceof JsonArray c ? c.deepCopy() : new JsonArray());
		JsonObject rf = r.getAsJsonObject("refund");
		if (p.get("drops") instanceof JsonObject d) {
			d.entrySet().forEach(x -> rf.addProperty(x.getKey(), x.getValue().getAsInt())); // a legacy instant member's dropped refund
		}
		for (Effect e : t.effects()) {
			Map<String, Integer> a = amounts.get(e.i());
			if (a == null) {
				continue;
			}
			if (dev.larattalabs.architect.txn.CrateTxn.OWE.equals(e.op())) {
				if (!a.isEmpty()) {
					JsonObject q = new JsonObject();
					q.addProperty("key", e.data().get("key").getAsString());
					q.addProperty("recipient", e.data().get("recipient").getAsString());
					q.addProperty("reason", e.data().get("reason").getAsString());
					q.add("items", Builder.counts(a));
					r.getAsJsonArray("owedParts").add(q);
				}
			} else {
				a.forEach((k, v) -> rf.addProperty(k, (rf.has(k) ? rf.get(k).getAsInt() : 0) + v));
			}
		}
		synchronized (OwnerRemovals.class) {
			String group = p.get("group").getAsString();
			if (p.has("stage")) {
				putResult("stage:" + group + "/" + p.get("stage").getAsString(), r);
				if (p.has("revisionId") && p.has("revRegion")) {
					putResult("revision:" + p.get("revRegion").getAsString() + "#" + p.get("revisionId").getAsInt(), r);
				}
			} else if (p.has("region")) {
				putResult("region:" + p.get("region").getAsString(), r);
			} else {
				putResult("group:" + group, r);
			}
			putResult("owner:" + key, r);
		}
		Stockpiles.owedChanged();
	}

	private static JsonObject fresh(JsonObject member) {
		JsonObject r = new JsonObject();
		r.add("refund", new JsonObject());
		r.add("owedParts", new JsonArray());
		JsonObject fin = member.get("fin") instanceof JsonObject f ? f : new JsonObject();
		r.addProperty("restored", fin.has("restored") ? fin.get("restored").getAsInt() : 0);
		r.addProperty("kept", fin.has("kept") ? fin.get("kept").getAsInt() : 0);
		r.add("handed", fin.get("handed") instanceof JsonObject h ? h.deepCopy() : new JsonObject());
		r.add("cascaded", fin.get("cascaded") instanceof JsonArray c ? c.deepCopy() : new JsonArray());
		return r;
	}

	/** (Q8b) Puts a result, the oldest evicted past {@link #RESULT_BOUND} (an open owner's marker never: it is its snapshot's probe). */
	static synchronized void putResult(String k, JsonObject r) {
		RESULTS.remove(k);
		RESULTS.put(k, r.deepCopy());
		var it = RESULTS.entrySet().iterator();
		while (RESULTS.size() > RESULT_BOUND && it.hasNext()) {
			var e = it.next();
			if (e.getKey().startsWith("owner:") && RECORDS.containsKey(e.getKey().substring(6))) {
				continue;
			}
			it.remove();
		}
	}

	/** The snapshot of owner {@code key} (member -> result), or empty. */
	static synchronized Map<String, JsonObject> results(String key) {
		Map<String, JsonObject> out = new LinkedHashMap<>();
		if (RESULTS.get("owner:" + key) instanceof JsonObject o) {
			o.entrySet().forEach(e -> out.put(e.getKey(), e.getValue().getAsJsonObject().deepCopy()));
		}
		return out;
	}

	/** (Q8) The last completed result of {@code kind:id}, or null. */
	public static synchronized @Nullable JsonObject result(String kind, String id) {
		JsonObject o = RESULTS.get(kind + ":" + id);
		return o == null ? null : o.deepCopy();
	}

	/** A result as the internal {@link Sites.Removed} (its owed keys and parts included). */
	static Sites.Removed removed(Site site, JsonObject r, List<String> notes) {
		Map<String, Integer> refund = new TreeMap<>();
		r.getAsJsonObject("refund").entrySet().forEach(e -> refund.put(e.getKey(), e.getValue().getAsInt()));
		Map<String, Integer> handed = new TreeMap<>();
		r.getAsJsonObject("handed").entrySet().forEach(e -> handed.put(e.getKey(), e.getValue().getAsInt()));
		List<String> cascaded = new ArrayList<>();
		r.getAsJsonArray("cascaded").forEach(x -> cascaded.add(x.getAsString()));
		List<String> owed = new ArrayList<>();
		List<JsonObject> parts = new ArrayList<>();
		r.getAsJsonArray("owedParts").forEach(x -> {
			owed.add(x.getAsJsonObject().get("key").getAsString());
			parts.add(x.getAsJsonObject());
		});
		return new Sites.Removed(site, Map.copyOf(refund), r.get("restored").getAsInt(), r.get("kept").getAsInt(), Map.copyOf(handed), List.copyOf(cascaded),
			notes, List.copyOf(owed), List.copyOf(parts));
	}

	/** The REMOVAL_FINISHED of {@code member} of owner {@code key}, from its snapshot (at least once: a re-fire reads the same snapshot). */
	public static void finished(String key, String member) {
		JsonObject r = result("site", member);
		if (r == null) {
			Architect.LOGGER.warn("Removal {}: no snapshot of {} for its REMOVAL_FINISHED", key, member);
			return;
		}
		Site s = Sites.pendingRecord(member);
		Sites.Removed rm = removed(s, r, List.of());
		dev.larattalabs.architect.apiimpl.ApiEvents.removalFinished(member, rm);
	}
}
