package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R-D, D1c) The R1 pre-commit producers ({@link RegionTargets#dropPlayerBlocks}, {@link RoadBuilder#dropPlayerMatches}, combined per
 * target) never drop a player's block: its extractable cells (kept cells stay standing, never extracted) are written back to their before by
 * one {@code removal.pblocks} txn per <b>extraction attempt</b>, key {@code pblocks:<target>@<placedAt>#<gen>}, and paid once into the owed
 * ledger from chunk receipts ({@code pfound}, {@code @pgone}), behind the barrier. The attempts live in {@code stockpiles.json}
 * ({@code extractions}): P0 records the attempt ({@code planned}, its cells held from then) in a confirmed save before the txn begins; the
 * txn decides COMMIT at its begin and has no prepare effect; its {@code extraction.snapshot} marks it {@code kept} with its result before it
 * retires. A start finds a {@code planned} attempt with no txn: {@code aborted} (nothing of it ran), its holds released; a later attempt
 * takes a new generation. A retry allocates a generation only for newly extractable cells.
 */
public final class Extractions {
	private Extractions() {
	}

	public static final String KIND = "removal.pblocks";
	/** Target key ({@code <id>@<placedAt>}) -> {gen, attempts: {gen: {key, cells, state, result?}}}. */
	private static final Map<String, JsonObject> TABLE = new TreeMap<>();

	static String tkey(Infra t) {
		return t.id() + "@" + t.placedAt();
	}

	static String key(String tkey, int gen) {
		return "pblocks:" + tkey + "#" + gen;
	}

	// ------------------------------------------------------------------ persistence

	static synchronized @Nullable JsonObject json() {
		if (TABLE.isEmpty()) {
			return null;
		}
		JsonObject o = new JsonObject();
		TABLE.forEach((k, v) -> o.add(k, v.deepCopy()));
		return o;
	}

	static synchronized void read(@Nullable JsonElement e) {
		TABLE.clear();
		resolving = false; // (a world's load) a resolver queued by an earlier world never ran
		if (e instanceof JsonObject o) {
			o.entrySet().forEach(x -> TABLE.put(x.getKey(), x.getValue().getAsJsonObject()));
		}
		CrateSettle.boxesChanged();
	}

	/** The holds of every planned or open attempt: its cells, one by one, named by the attempt key (its txn's writer exemption). */
	static synchronized List<JsonObject> holds() {
		List<JsonObject> out = new ArrayList<>();
		for (JsonObject t : TABLE.values()) {
			for (var a : t.getAsJsonObject("attempts").entrySet()) {
				JsonObject at = a.getValue().getAsJsonObject();
				String st = at.get("state").getAsString();
				if (!st.equals("planned") && !st.equals("open")) {
					continue;
				}
				for (JsonElement el : at.getAsJsonArray("cells")) {
					long pos = el.getAsJsonObject().get("pos").getAsLong();
					BlockPos p = BlockPos.of(pos);
					JsonObject h = new JsonObject();
					h.addProperty("dim", at.get("dim").getAsString());
					h.addProperty("site", at.get("key").getAsString());
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

	/** Admission areas of the planned and open attempts (§4.2 (b)). */
	static synchronized void areas(List<RemovalAreas.Area> out) {
		for (JsonObject h : holds()) {
			JsonArray b = h.getAsJsonArray("box");
			String k = h.get("site").getAsString();
			out.add(new RemovalAreas.Area(h.get("dim").getAsString(), new dev.larattalabs.architect.placement.Anchors.Bounds(b.get(0).getAsInt(), b.get(1)
				.getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), "the return of player blocks (" + k + ")", k,
				new dev.larattalabs.architect.api.Busy(dev.larattalabs.architect.api.Busy.Kind.PLAYER_BLOCKS_RETURNING, k, "extraction", null)));
		}
	}

	/** The cells of the kept attempts of {@code t} (they are written back: a refund tally skips them). */
	static synchronized it.unimi.dsi.fastutil.longs.LongOpenHashSet extracted(Infra t) {
		it.unimi.dsi.fastutil.longs.LongOpenHashSet out = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		JsonObject tb = TABLE.get(tkey(t));
		if (tb != null) {
			for (var a : tb.getAsJsonObject("attempts").entrySet()) {
				for (JsonElement el : a.getValue().getAsJsonObject().getAsJsonArray("cells")) {
					out.add(el.getAsJsonObject().get("pos").getAsLong());
				}
			}
		}
		return out;
	}

	/** Forgets {@code t}'s attempts that are done (kept or aborted): its record is deleted. */
	static synchronized void forget(Infra t) {
		JsonObject tb = TABLE.get(tkey(t));
		if (tb == null) {
			return;
		}
		boolean live = false;
		for (var a : tb.getAsJsonObject("attempts").entrySet()) {
			String st = a.getValue().getAsJsonObject().get("state").getAsString();
			live |= st.equals("planned") || st.equals("open");
		}
		if (!live) {
			TABLE.remove(tkey(t));
			Stockpiles.owedChanged();
		}
	}

	// ------------------------------------------------------------------ the cells

	/** One extractable cell: its position, the player's block, its before (SNBT) and what it returns. */
	static JsonObject spec(ServerLevel level, BlockPos p, BlockState now, BlockState was, @Nullable String recipient) {
		JsonObject o = new JsonObject();
		o.addProperty("pos", p.asLong());
		o.addProperty("block", Builder.blockId(now));
		o.addProperty("was", net.minecraft.nbt.NbtUtils.writeBlockState(was).toString());
		Map<String, Integer> items = new TreeMap<>();
		Cells.cost(now).forEach(c -> items.merge(c.item(), c.count(), Integer::sum));
		o.add("items", Builder.counts(items));
		var rec = dev.larattalabs.architect.placed.Placed.record(level, p);
		if (recipient != null) {
			o.addProperty("recipient", recipient);
		} else if (rec != null) {
			o.addProperty("recipient", rec.placer().toString());
		}
		return o;
	}

	/** Both producers' extractable cells of {@code t} now, combined, one per position (nothing written). */
	static List<JsonObject> extractable(ServerLevel level, Infra t) {
		List<JsonObject> sink = new ArrayList<>();
		RegionTargets.dropPlayerBlocks(level, t, false, null, sink);
		RoadBuilder.dropPlayerMatches(level, t, false, sink);
		Map<Long, JsonObject> by = new LinkedHashMap<>();
		sink.forEach(c -> by.putIfAbsent(c.get("pos").getAsLong(), c));
		return new ArrayList<>(by.values());
	}

	/** The before written back at {@code pos} (txn W apply): the attempt's {@code was}. Server thread. */
	public static boolean writeBack(ServerLevel level, long pos, String was) {
		BlockState st;
		try {
			st = dev.larattalabs.architect.journal.WorldJournal.state(dev.larattalabs.architect.journal.Journal.Value.of(net.minecraft.nbt.TagParser
				.parseCompoundFully(was), null));
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException e) {
			throw new IllegalStateException("its before can't be read: " + e.getMessage());
		}
		return dev.larattalabs.architect.placed.Placed.set(level, BlockPos.of(pos), st, Sites.CELL_FLAGS);
	}

	// ------------------------------------------------------------------ the attempt

	/**
	 * Extracts {@code t}'s player blocks, as far as it can go now. Null when done (nothing extractable, or every attempt kept); else why it
	 * waits (an attempt held, a save refused): the caller waits (a group) or answers PLAYER_BLOCKS_RETURNING (a standalone road). Server thread.
	 */
	static @Nullable String run(MinecraftServer srv, ServerLevel level, Infra t, @Nullable String requester) {
		String tk = tkey(t);
		JsonObject tb;
		synchronized (Extractions.class) {
			tb = TABLE.get(tk);
		}
		if (tb != null) {
			for (var a : tb.getAsJsonObject("attempts").entrySet()) {
				JsonObject at = a.getValue().getAsJsonObject();
				String st = at.get("state").getAsString();
				if (st.equals("planned") || st.equals("open")) {
					String why = drive(srv, level, tk, at);
					if (why != null) {
						return why;
					}
				}
			}
		}
		List<JsonObject> cells = extractable(level, t);
		if (cells.isEmpty()) {
			return null; // only kept cells (or none): no attempt
		}
		String rec = t.owner() != null ? t.owner() : t.construction() != null && t.construction().owner() != null ? t.construction().owner()
			: "architect:unowned"; // the road's recipient, as roadStash names it
		for (JsonObject c : cells) {
			if (!c.has("recipient")) {
				c.addProperty("recipient", OwnerRemovals.recipient(null, rec, requester));
			}
		}
		// P0: a new generation, recorded (planned) and saved confirmed before anything else: its cells are held from here
		int gen;
		JsonObject at = new JsonObject();
		synchronized (Extractions.class) {
			tb = TABLE.computeIfAbsent(tk, k -> {
				JsonObject o = new JsonObject();
				o.addProperty("gen", 0);
				o.add("attempts", new JsonObject());
				return o;
			});
			gen = tb.get("gen").getAsInt() + 1;
			tb.addProperty("gen", gen);
			at.addProperty("key", key(tk, gen));
			at.addProperty("dim", t.dimension());
			at.addProperty("target", t.id());
			JsonArray ca = new JsonArray();
			cells.forEach(ca::add);
			at.add("cells", ca);
			at.addProperty("state", "planned");
			tb.getAsJsonObject("attempts").add(String.valueOf(gen), at);
		}
		Stockpiles.owedChanged();
		CrateSettle.boxesChanged();
		try {
			Stockpiles.saveWithWorldConfirmed(srv);
		} catch (IllegalStateException e) {
			synchronized (Extractions.class) {
				tb.getAsJsonObject("attempts").remove(String.valueOf(gen)); // nothing of it happened: forgotten, its generation unused
			}
			CrateSettle.boxesChanged();
			return "the attempt's save was refused: " + e.getMessage();
		}
		dev.larattalabs.architect.journal.WorldJournal.kill("P0");
		dev.larattalabs.architect.journal.WorldJournal.kill("P0b");
		return drive(srv, level, tk, at);
	}

	/** Begins (or attaches to) attempt {@code at}'s txn and drives it; marks it kept once retired. Null when kept; else why it waits. */
	static @Nullable String drive(MinecraftServer srv, ServerLevel level, String tk, JsonObject at) {
		String key = at.get("key").getAsString();
		TxnCore c = TxnServer.core();
		JsonArray cells = at.getAsJsonArray("cells");
		List<String> res = new ArrayList<>();
		for (JsonElement el : cells) {
			BlockPos p = BlockPos.of(el.getAsJsonObject().get("pos").getAsLong());
			res.add("cell:" + at.get("dim").getAsString() + "@" + p.getX() + "," + p.getY() + "," + p.getZ());
		}
		TxnCore.Started s = c.begin(KIND, key, res, null);
		TxnEntry t;
		switch (s.status()) {
			case UNAVAILABLE:
				return "records unreadable (" + s.detail() + ")";
			case HELD:
				return "held: " + s.detail();
			case REPLAYED:
				keep(at, null);
				return null;
			case ATTACHED:
				t = s.entry();
				break;
			default: {
				t = s.entry();
				JsonArray pc = new JsonArray();
				cells.forEach(x -> {
					JsonObject q = new JsonObject();
					q.add("pos", x.getAsJsonObject().get("pos"));
					q.add("block", x.getAsJsonObject().get("block"));
					q.add("was", x.getAsJsonObject().get("was"));
					pc.add(q);
				});
				List<long[]> chunks = new ArrayList<>();
				java.util.Set<Long> seen = new java.util.HashSet<>();
				for (JsonElement el : cells) {
					BlockPos p = BlockPos.of(el.getAsJsonObject().get("pos").getAsLong());
					if (seen.add(CrateSettle.pack(p.getX() >> 4, p.getZ() >> 4))) {
						chunks.add(new long[] {p.getX() >> 4, p.getZ() >> 4});
					}
				}
				int w = c.plan(t, RemovalTxn.cellsRestore(at.get("dim").getAsString(), key, chunks, pc)).i();
				c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(key));
				JsonArray player = new JsonArray();
				cells.forEach(player::add);
				for (Effect.Builder b : OwnerRemovals.playerOwes0("player:" + key, at.get("target").getAsString(), at.get("dim").getAsString(), w, player)) {
					c.plan(t, b.member(key));
				}
				c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(key));
				c.plan(t, Effect.of(RemovalTxn.EXTRACTION_SNAPSHOT, EffectClass.R).data("target", tk).data("gen", at.get("key").getAsString()));
				DurableFile.Outcome o = c.persist(t);
				if (o == DurableFile.Outcome.REFUSED) {
					return "txn.json refused its intent";
				}
				synchronized (Extractions.class) {
					at.addProperty("state", "open");
				}
				Stockpiles.owedChanged();
			}
		}
		c.drive(t);
		if (c.get(t.id) != null) {
			return t.held() != null ? t.held() : "in progress";
		}
		if (c.cache().committed(key) == null) {
			resolveLater(srv); // (fix round P1-5) ended aborted: the resolver marks it aborted and releases its holds
			return "its extraction txn ended without its commit";
		}
		keep(at, null);
		return null;
	}

	private static void keep(JsonObject at, @Nullable JsonObject result) {
		synchronized (Extractions.class) {
			at.addProperty("state", "kept");
			if (result != null) {
				at.add("result", result);
			}
		}
		Stockpiles.owedChanged();
		CrateSettle.boxesChanged();
	}

	/** (the probe of {@code extraction.snapshot}) Whether attempt {@code key} of target {@code tk} is kept. */
	public static synchronized boolean snapshotted(String tk, String key) {
		JsonObject at = attempt(tk, key);
		return at != null && at.get("state").getAsString().equals("kept");
	}

	/** (the apply of {@code extraction.snapshot}) The attempt kept, its owed parts recorded from the applied amounts. */
	public static void snapshot(TxnEntry t, String tk, String key, Map<Integer, Map<String, Integer>> amounts) {
		JsonObject at;
		synchronized (Extractions.class) {
			at = attempt(tk, key);
		}
		if (at == null) {
			throw new IllegalStateException("attempt " + key + " is not recorded");
		}
		JsonArray parts = new JsonArray();
		for (Effect e : t.effects()) {
			Map<String, Integer> a = amounts.get(e.i());
			if (a != null && !a.isEmpty() && dev.larattalabs.architect.txn.CrateTxn.OWE.equals(e.op())) {
				JsonObject q = new JsonObject();
				q.addProperty("key", e.data().get("key").getAsString());
				q.addProperty("recipient", e.data().get("recipient").getAsString());
				q.addProperty("reason", e.data().get("reason").getAsString());
				q.add("items", Builder.counts(a));
				parts.add(q);
			}
		}
		JsonObject r = new JsonObject();
		r.add("owedParts", parts);
		keep(at, r);
		Architect.LOGGER.info("Extraction {}: kept, owed {}", key, parts);
	}

	private static @Nullable JsonObject attempt(String tk, String key) {
		JsonObject tb = TABLE.get(tk);
		if (tb == null) {
			return null;
		}
		for (var a : tb.getAsJsonObject("attempts").entrySet()) {
			if (a.getValue().getAsJsonObject().get("key").getAsString().equals(key)) {
				return a.getValue().getAsJsonObject();
			}
		}
		return null;
	}

	/**
	 * (a start) Each planned attempt with no txn: aborted (nothing of it ran: P0 is before the intent), its holds released; an open attempt's
	 * txn recovers in the core (installed or undecided, the core's fate rule), kept once retired; one whose txn retired: kept. (fix round P1-5)
	 * An attempt whose txn is still open at the start (an undecided intent the core aborts, retired only at the first tick) is resolved by the
	 * same rule once its txn retires: the resolver runs each tick ({@link TxnServer#later}) while any attempt is planned or open.
	 */
	static void atStart(MinecraftServer srv) {
		atStart(srv, k -> TxnServer.core().open().stream().anyMatch(t -> k.equals(t.key)), k -> TxnServer.core().cache().committed(k) != null,
			TxnServer::later);
	}

	/** (TEST seam) {@link #atStart(MinecraftServer)} with the core's open and committed keys as predicates (no resolver scheduled). */
	static void atStart(@Nullable MinecraftServer srv, java.util.function.Predicate<String> openKey, java.util.function.Predicate<String> committedKey) {
		atStart(srv, openKey, committedKey, r -> {
		});
	}

	/** (TEST seam) {@link #atStart(MinecraftServer)} scheduling its resolver through {@code later} (the server: the next tick). */
	static void atStart(@Nullable MinecraftServer srv, java.util.function.Predicate<String> openKey, java.util.function.Predicate<String> committedKey,
		java.util.function.Consumer<Runnable> later) {
		synchronized (Extractions.class) {
			for (JsonObject tb : TABLE.values()) {
				for (var a : tb.getAsJsonObject("attempts").entrySet()) {
					JsonObject at = a.getValue().getAsJsonObject();
					if (at.get("state").getAsString().equals("planned") && openKey.test(at.get("key").getAsString())) {
						at.addProperty("state", "open"); // (fix round P1-5) its txn's intent is durable: it is open, resolved once that txn retires
					}
				}
			}
		}
		resolve(srv, openKey, committedKey, true);
		resolveLater(srv, openKey, committedKey, later);
	}

	/** Whether the resolver is scheduled (one at a time; a world's load clears it with the table). */
	private static boolean resolving;

	/**
	 * (fix round P1-5) The resolver, each tick while an attempt is planned or open: {@link #resolve} once the stores and the txn core are ready
	 * (a load that failed decides nothing), then again next tick while one is left. Server thread.
	 */
	static void resolveLater(@Nullable MinecraftServer srv, java.util.function.Predicate<String> openKey, java.util.function.Predicate<String> committedKey,
		java.util.function.Consumer<Runnable> later) {
		synchronized (Extractions.class) {
			if (resolving || !anyLive()) {
				return;
			}
			resolving = true;
		}
		later.accept(() -> {
			synchronized (Extractions.class) {
				resolving = false;
			}
			if (srv == null || ready()) {
				resolve(srv, openKey, committedKey, false);
			}
			resolveLater(srv, openKey, committedKey, later);
		});
	}

	/** The live server's resolver (an attempt left planned or open by a held or aborted drive). Server thread. */
	static void resolveLater(MinecraftServer srv) {
		resolveLater(srv, k -> TxnServer.core().open().stream().anyMatch(t -> k.equals(t.key)), k -> TxnServer.core().cache().committed(k) != null,
			TxnServer::later);
	}

	/** (fix round P1-5) {@link #resolve} now, at run time (a removal's admission asks it first: an attempt whose txn retired holds nothing). */
	static void resolveNow(MinecraftServer srv) {
		if (anyLive() && ready()) {
			resolve(srv, k -> TxnServer.core().open().stream().anyMatch(t -> k.equals(t.key)), k -> TxnServer.core().cache().committed(k) != null, false);
		}
	}

	private static boolean ready() {
		return CrateSettle.notReady() == null && TxnServer.core().loadFailed() == null;
	}

	/** Whether any attempt is open (its txn begun: it is resolved once that txn retires). A planned one is driven by its caller's retry. */
	static synchronized boolean anyLive() {
		for (JsonObject tb : TABLE.values()) {
			for (var a : tb.getAsJsonObject("attempts").entrySet()) {
				if (a.getValue().getAsJsonObject().get("state").getAsString().equals("open")) {
					return true;
				}
			}
		}
		return false;
	}

	/**
	 * The fate rule over every attempt whose txn is not open: committed (retired committed) -> kept; an open attempt whose txn ended without a
	 * commit -> aborted (its txn ended aborted: nothing of it ran; a committed one is kept by its own snapshot before it retires); at a start
	 * ({@code start}) also a planned one with no txn -> aborted (its intent never became durable). At run time a planned attempt with no txn
	 * is its caller's (a begin that was held): its retry drives it. Saved confirmed when it changed anything; a refused save is redone by the
	 * next resolve or start.
	 */
	static void resolve(@Nullable MinecraftServer srv, java.util.function.Predicate<String> openKey, java.util.function.Predicate<String> committedKey,
		boolean start) {
		boolean changed = false;
		synchronized (Extractions.class) {
			for (JsonObject tb : TABLE.values()) {
				for (var a : tb.getAsJsonObject("attempts").entrySet()) {
					JsonObject at = a.getValue().getAsJsonObject();
					String st = at.get("state").getAsString();
					String key = at.get("key").getAsString();
					if (st.equals("kept") || st.equals("aborted") || openKey.test(key) || !start && st.equals("planned") && !committedKey.test(key)) {
						continue;
					}
					if (committedKey.test(key)) {
						at.addProperty("state", "kept");
						changed = true;
					} else {
						at.addProperty("state", "aborted");
						changed = true;
						Architect.LOGGER.info("Extraction {}: no txn open and none committed (its intent never made durable, or it ended aborted): aborted, nothing of it"
							+ " ran", key);
					}
				}
			}
		}
		if (changed) {
			Stockpiles.owedChanged();
			CrateSettle.boxesChanged();
			if (srv == null) {
				return;
			}
			try {
				Stockpiles.saveWithWorldConfirmed(srv);
			} catch (IllegalStateException e) {
				Architect.LOGGER.warn("Extractions: the resolved states are not saved yet ({}): they are saved with the next save, or resolved again at the next start",
					e.getMessage());
			}
		}
	}
}
