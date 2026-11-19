package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import dev.larattalabs.architect.txn.CrateTxn;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2b part 2b) The site side of {@code crate.settle} ({@link CrateTxn#settle}): a removed construction site's crate settles once, at
 * settle time (after the removal's commit and its restore), in one keyed txn. Before it the crate keeps its stock and its cell (the removal's
 * undo leaves the crate's journal entry out: {@link #excluded}), so a crash anywhere before the settle's intent leaves an orphan crate with its
 * stock (clickable): no loss. The hooks here are the package-private parts the txn adapters reach.
 */
public final class CrateSettle {
	private CrateSettle() {
	}

	/** What a removal's settle needs of its crate, read at prepare (nothing taken). */
	record Ref(String dim, BlockPos pos, String crateOwner, String siteKey, boolean shared, Construction.Crate cell, String recipient,
		@Nullable String pile, @Nullable String site, @Nullable String region) {
	}

	/** The crate a removal of {@code s} settles, or null (no crate, a crate other sites or roads still build from, a stockpile's target). */
	static @Nullable Ref refOf(Site s) {
		Construction c = s.construction();
		if (c == null || c.crate() == null || !Builder.otherBuildingShared(s).isEmpty() || s.group() != null && !RoadBuilder.building(s.group()).isEmpty()) {
			return null;
		}
		Construction.Crate cc = c.crate();
		String recipient = recipientOf(s);
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		return new Ref(s.dimension(), new BlockPos(cc.x(), cc.y(), cc.z()), Builder.crateOwner(s), Builder.creditKey(s), Builder.sharedGroup(s) != null, cc,
			recipient, pileOf(recipient, s.dimension()), s.id(), regionOf(g));
	}

	static String recipientOf(Site s) {
		Construction c = s.construction();
		return s.owner() != null ? s.owner() : c != null && c.owner() != null ? c.owner() : "architect:unowned";
	}

	static @Nullable String pileOf(String recipient, String dim) {
		Stockpiles.Pile p = Stockpiles.get(recipient);
		return p != null && p.dimension.equals(dim) ? recipient : null;
	}

	static @Nullable String regionOf(@Nullable SiteGroupRec g) {
		return g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
	}

	// ------------------------------------------------------------------ the stash: a settle's input, fixed at prepare and persisted

	/**
	 * The settle a removal of {@code s} owes, fixed now (at prepare, before the undo is planned) and persisted with its pending record
	 * ({@link Site.Pending#settle}) or its group's queue: the txn key, the crate (cell snapshot, owner) and {@code refund} (a crate-fed site's
	 * refunds). The crate's stock is read at settle time from the crate itself (it never leaves the crate before). Null: nothing to settle.
	 * Both the undo's exclusion ({@link #excluded}) and the settle read this one snapshot, never the world as it stands later.
	 */
	static @Nullable JsonObject stash(Site s, Map<String, Integer> refund) {
		Construction c = s.construction();
		if (c == null || c.crate() == null) {
			return null;
		}
		Ref r = refOf(s);
		if (r != null) {
			return stashOf(CrateTxn.settleKey(r.crateOwner(), r.pos(), r.siteKey()), r.dim(), r.pos(), r.recipient(), r.pile(), r.site(), r.region(), refund,
				r.crateOwner(), r.cell(), r.shared() ? s.group() : null);
		}
		if (refund.isEmpty()) {
			return null;
		}
		// the crate stays (shared and still building others, or a road builds from it): this site's refunds alone, keyed by this placement
		String recipient = recipientOf(s);
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		return stashOf("crate-refund:" + Builder.creditKey(s), s.dimension(), new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()), recipient,
			pileOf(recipient, s.dimension()), s.id(), regionOf(g), refund, null, null, null);
	}

	/** A group removal's shared crate (once every member is written), or null: it settles with a group key, its stock only. */
	static @Nullable JsonObject groupStash(String group, List<Site> members) {
		for (Site m : members) {
			SiteGroupRec g = Builder.sharedGroup(m);
			if (g != null && m.construction() != null && m.construction().crate() != null && group.equals(g.id())) {
				Construction.Crate cc = m.construction().crate();
				BlockPos pos = new BlockPos(cc.x(), cc.y(), cc.z());
				String recipient = recipientOf(m);
				return stashOf(CrateTxn.settleKey(g.crateOwner(), pos, "group:" + group), m.dimension(), pos, recipient, pileOf(recipient, m.dimension()),
					m.id(), regionOf(g), Map.of(), g.crateOwner(), cc, group);
			}
		}
		return null;
	}

	/**
	 * (T2b part 2b, coordinator must-fix) A completed site's crate as it is built: its leftover stock owed {@code crate_settle} or credited to
	 * the recipient's pile, its cell restored and its entry released, never dropped. Keyed {@code built:<creditKey>}: a later removal of the
	 * BUILT site settles under its own key ({@link #stash}), so its refunds never replay this answer.
	 */
	static JsonObject builtStash(Site s) {
		Construction.Crate cc = java.util.Objects.requireNonNull(s.construction().crate());
		BlockPos pos = new BlockPos(cc.x(), cc.y(), cc.z());
		String recipient = recipientOf(s);
		SiteGroupRec shared = Builder.sharedGroup(s);
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		String owner = Builder.crateOwner(s);
		return stashOf(CrateTxn.settleKey(owner, pos, "built:" + Builder.creditKey(s)), s.dimension(), pos, recipient, pileOf(recipient, s.dimension()),
			s.id(), regionOf(g), Map.of(), owner, cc, shared != null ? shared.id() : null);
	}

	/** A road's group crate as the last road completes or goes (its stock; {@code refund}: a removal's refunds), keyed by this placement. */
	static JsonObject roadStash(Infra road, Construction.Crate cc, Map<String, Integer> refund, String why) {
		BlockPos pos = new BlockPos(cc.x(), cc.y(), cc.z());
		String recipient = road.owner() != null ? road.owner() : road.construction() != null && road.construction().owner() != null ? road.construction()
			.owner() : "architect:unowned";
		SiteGroupRec g = road.group() == null ? null : Sites.group(road.group());
		String owner = SiteGroupRec.CRATE_PREFIX + road.group();
		return stashOf(CrateTxn.settleKey(owner, pos, why + ":" + RoadBuilder.creditKey(road)), road.dimension(), pos, recipient, pileOf(recipient, road
			.dimension()), road.id(), regionOf(g), refund, owner, cc, road.group());
	}

	/** (T2b fix round P1-b) A road's refunds alone (its group's crate kept: another still builds from it, or none), owed or credited at {@code at}. */
	static JsonObject roadRefundStash(Infra road, BlockPos at, Map<String, Integer> refund) {
		String recipient = road.owner() != null ? road.owner() : road.construction() != null && road.construction().owner() != null ? road.construction()
			.owner() : "architect:unowned";
		SiteGroupRec g = road.group() == null ? null : Sites.group(road.group());
		return stashOf("crate-refund:" + RoadBuilder.creditKey(road), road.dimension(), at, recipient, pileOf(recipient, road.dimension()), road.id(),
			regionOf(g), refund, null, null, null);
	}

	/**
	 * (slice T4b, N8) A stockpile's construction site's removal: its refunds (and the custody held under its credit key) credited into its pile
	 * under {@code site:<id>@<placedAt>} by the removal's txn, after its restore ({@link RemovalTxn#PILE_REFUND}), never ahead of it as a held
	 * pending credit. Kept with the others in the durable stash, saved confirmed before the undo commits.
	 */
	static JsonObject pileStash(Site s, Builder.Deconstruction d) {
		JsonObject o = new JsonObject();
		o.addProperty("key", "pile-refund:" + d.key());
		o.addProperty("dim", s.dimension());
		o.addProperty("pos", d.at().asLong());
		o.addProperty("recipient", d.stockpile());
		o.addProperty("pile", d.stockpile());
		o.addProperty("site", s.id());
		o.addProperty("pileKey", d.key());
		o.add("refund", Builder.counts(d.credit()));
		return o;
	}

	/** Whether {@code stash} is a stockpile site's refund ({@link #pileStash}). */
	static boolean isPileStash(@Nullable JsonObject stash) {
		return stash != null && stash.has("pileKey");
	}

	/** (slice T4b) {@code stash} told which undo group its removal committed (its W restore's source). */
	static JsonObject withGroup(JsonObject stash, String group) {
		stash.addProperty("undoGroup", group);
		return stash;
	}

	/** The latest undo group {@code siteId}'s journal holds undone, or null (none committed, or its entries released). */
	static @Nullable String latestUndone(String siteId) {
		String group = null;
		long at = Long.MIN_VALUE;
		for (dev.larattalabs.architect.journal.JournalStore.Meta m : SiteJournal.entries(siteId)) {
			if (m.status() == dev.larattalabs.architect.journal.Journal.Status.UNDONE && m.undoGroup() != null && m.undoneAt() >= at) {
				at = m.undoneAt();
				group = m.undoGroup();
			}
		}
		return group;
	}

	/** Whether {@code siteId} still has entries of undo group {@code group} (its W restore not yet settled). Server thread. */
	public static boolean undoneExists(String siteId, String group) {
		return !SiteJournal.undone(siteId, group).isEmpty();
	}

	/** Whether {@code siteId} has any active (not undone) entry but its crates': a removal of it was never committed. */
	static boolean standsInJournal(String siteId) {
		return SiteJournal.active(siteId).stream().anyMatch(m -> !m.kind().equals(WorldJournal.CRATE));
	}

	// ------------------------------------------------------------------ (slice T4b) the W restore's hooks

	/** Restores this session wrote already, {@code site|group}: the W effect then only receipts them (the cells are in memory). */
	private static final java.util.Set<String> RESTORED_NOW = java.util.concurrent.ConcurrentHashMap.newKeySet();

	/** {@code site}'s committed restore in {@code group} was just written (R4, a restore job): the removal's W effect receipts it. */
	static void markRestored(String site, String group) {
		RESTORED_NOW.add(site + "|" + group);
	}

	static void clearRestored() {
		RESTORED_NOW.clear();
	}

	/**
	 * The W effect's write: {@code site}'s committed restore in {@code group}, from its journal entries (idempotent: the befores again). Only once
	 * the Sites check has run (the records and the journal both loaded) and every store loaded: otherwise it throws and the txn holds.
	 */
	public static void restoreSite(ServerLevel level, String site, String group) {
		String why = notReady();
		if (why != null) {
			throw new IllegalStateException(why);
		}
		if (RESTORED_NOW.remove(site + "|" + group)) {
			return;
		}
		try {
			SiteJournal.writeNow(level, site, group);
		} catch (Sites.SiteException e) {
			throw new IllegalStateException("the restore of " + site + " could not be written: " + e.getMessage());
		}
	}

	/** Why a removal's txn may not act now: a store that failed to load (never read as "empty"), or the Sites check not run yet. */
	static @Nullable String notReady() {
		if (Sites.loadFailed() || Stockpiles.loadFailed() || Placement.loadFailed()) {
			return "records unreadable"; // (T4b, finding 3b; Steward: "Architect's records didn't load; it waits")
		}
		return Sites.ready() ? null : "records not loaded yet";
	}

	/** The chunks {@code site}'s restore in {@code group} writes ([cx, cz]), read from its journal entries. */
	static List<long[]> chunksOf(ServerLevel level, String site, String group) throws Sites.SiteException {
		SiteJournal.Restore r = SiteJournal.restore(level, site, group);
		java.util.TreeSet<Long> set = new java.util.TreeSet<>();
		for (List<SiteJournal.CellWrite> l : List.of(r.cells(), r.pre(), r.halves())) {
			for (SiteJournal.CellWrite w : l) {
				set.add(pack(BlockPos.getX(w.pos()) >> 4, BlockPos.getZ(w.pos()) >> 4));
			}
		}
		if (r.box() != null) {
			for (int cx = r.box().minX() >> 4; cx <= r.box().maxX() >> 4; cx++) {
				for (int cz = r.box().minZ() >> 4; cz <= r.box().maxZ() >> 4; cz++) {
					set.add(pack(cx, cz));
				}
			}
		}
		List<long[]> out = new java.util.ArrayList<>();
		for (long c : set) {
			out.add(new long[] {(int) (c >> 32), (int) c});
		}
		return out;
	}

	private static long pack(int cx, int cz) {
		return (long) cx << 32 | cz & 0xFFFFFFFFL;
	}

	/** Whether {@code owner}'s pile booked {@code key} (the L probe of a stockpile site's refund). */
	public static boolean refundBooked(String owner, String key) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		return p != null && p.ledger.credited(key);
	}

	/**
	 * A stockpile site's refund credited under its own key, as {@code Builder.creditRefund} books it (its custody with it, its paid record
	 * dropped; a credit of nothing drops its pending credit and paid record). Its pile dissolved meanwhile: refused (the txn holds).
	 */
	public static void bookRefund(MinecraftServer srv, String owner, String key, Map<String, Integer> items, BlockPos at) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		if (p == null) {
			throw new IllegalStateException(owner + " has no stockpile now");
		}
		if (items.isEmpty() && p.ledger.custody(key).isEmpty()) {
			Stockpiles.creditOfNothing(p, key);
			p.ledger.credit(key, new TreeMap<>(), Stockpiles.capacity(srv, p), Stockpiles::maxStack); // the probe's key: booked once
			Stockpiles.changed(p);
			return;
		}
		Stockpiles.credit(srv, p, key, new TreeMap<>(items), at);
		Stockpiles.changed(p);
	}

	private static JsonObject stashOf(String key, String dim, BlockPos pos, String recipient, @Nullable String pile, @Nullable String site,
		@Nullable String region, Map<String, Integer> refund, @Nullable String crateOwner, Construction.@Nullable Crate cell, @Nullable String sharedGroup) {
		JsonObject o = new JsonObject();
		o.addProperty("key", key);
		o.addProperty("dim", dim);
		o.addProperty("pos", pos.asLong());
		o.addProperty("recipient", recipient);
		if (pile != null) {
			o.addProperty("pile", pile);
		}
		if (site != null) {
			o.addProperty("site", site);
		}
		if (region != null) {
			o.addProperty("region", region);
		}
		o.add("refund", Builder.counts(refund));
		if (crateOwner != null && cell != null) {
			o.addProperty("crateOwner", crateOwner);
			o.addProperty("state", cell.snapshotState());
			if (cell.snapshotNbt() != null) {
				o.addProperty("nbt", cell.snapshotNbt());
			}
			if (sharedGroup != null) {
				o.addProperty("sharedGroup", sharedGroup);
			}
		}
		return o;
	}

	// ------------------------------------------------------------------ (T2b fix round P1-c) the stashes, durable before the undo commits

	/** Site id -> its removal's stash (with the refunds tallied at prepare), saved in stockpiles.json (DurableFile) before the undo commits. */
	private static final Map<String, JsonObject> DURABLE = new TreeMap<>();

	static boolean durableEmpty() {
		return DURABLE.isEmpty();
	}

	static JsonObject durableJson() {
		JsonObject o = new JsonObject();
		DURABLE.forEach((k, v) -> o.add(k, v.deepCopy()));
		return o;
	}

	static void durableRead(com.google.gson.@Nullable JsonElement e) {
		DURABLE.clear();
		if (e != null && e.isJsonObject()) {
			e.getAsJsonObject().entrySet().forEach(x -> DURABLE.put(x.getKey(), x.getValue().getAsJsonObject()));
		}
	}

	/**
	 * Records the stashes of {@code bySite} that carry refunds (in memory; the caller's ledger save publishes them). True when one was
	 * recorded: the removal then saves the ledger, confirmed, before its undo commits, so a crash between the commit and the pending
	 * record still settles the refunds ({@link #durable}). Server thread.
	 */
	static boolean holdDurable(Map<String, JsonObject> bySite) {
		boolean any = false;
		for (var e : bySite.entrySet()) {
			if (e.getValue() != null && (!refundOf(e.getValue()).isEmpty() || isPileStash(e.getValue()))) {
				DURABLE.put(e.getKey(), e.getValue().deepCopy());
				any = true;
			}
		}
		if (any) {
			Stockpiles.owedChanged();
		}
		return any;
	}

	/** (T2b last round P1 3) Records a road removal's stash (in memory; the caller saves the ledger confirmed before its restore can commit). */
	static void holdDurable(String id, JsonObject stash) {
		DURABLE.put(id, stash.deepCopy());
		Stockpiles.owedChanged();
	}

	/**
	 * (T2b last round P1 2, 3) On the first tick after a start (every store loaded, the Sites check's reconcile done): each durable stash
	 * that no queued job carries and no pending site record settles is settled when its site or road is gone (its removal committed and
	 * released: keyed, a replay pays nothing twice), and forgotten when it stands (the removal never committed, or recovery brought it back).
	 */
	static void sweepLater(MinecraftServer srv) {
		if (!DURABLE.isEmpty()) {
			dev.larattalabs.architect.txn.TxnServer.later(() -> sweep(srv));
		}
	}

	private static void sweep(MinecraftServer srv) {
		String why = notReady();
		if (why != null) {
			// (T4b, finding 3b) a store failed to load (an empty registry is no evidence that anything is gone): nothing is paid this session
			Architect.LOGGER.warn("crate.settle sweep: {}: the {} durable stash(es) wait, nothing paid", why, DURABLE.size());
			if (!Sites.loadFailed() && !Stockpiles.loadFailed() && !Placement.loadFailed()) {
				dev.larattalabs.architect.txn.TxnServer.later(() -> sweep(srv)); // only not loaded yet: the next tick
			}
			return;
		}
		boolean held = false;
		for (String id : List.copyOf(DURABLE.keySet())) {
			if (Placement.job(id) != null || Sites.pendingOf(id) != null || Infras.pending(id) != null) {
				continue; // its job or its pending record settles it (through its txn, W restore first)
			}
			JsonObject st = DURABLE.get(id);
			String group = st.has("undoGroup") ? st.get("undoGroup").getAsString() : latestUndone(id);
			boolean committed = group != null && undoneExists(id, group);
			if (!committed && (Sites.get(id) != null || Infras.get(id) != null || standsInJournal(id))) {
				// (T4b, findings 3a/3b) the evidence is the journal, not a record's absence: no committed undo and it stands: never removed
				Architect.LOGGER.info("crate.settle of {}: it stands (its removal did not commit, or it was brought back): its stash is dropped, nothing owed", id);
				forgetDurable(id);
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, st.get("dim").getAsString());
			if (level == null) {
				continue;
			}
			Settled s = settle(level, st);
			if (!s.done()) {
				held = true;
				continue;
			}
			forgetDurable(id);
			Architect.LOGGER.info("crate.settle of removed {} from its durable stash at a start: owed {}, given {}", id, s.owed(), s.given());
		}
		if (held) {
			dev.larattalabs.architect.txn.TxnServer.later(() -> sweep(srv));
		}
	}

	/** The durable stash of {@code siteId}'s removal, or null. */
	static @Nullable JsonObject durable(String siteId) {
		JsonObject o = DURABLE.get(siteId);
		return o == null ? null : o.deepCopy();
	}

	/** Forgets {@code siteId}'s durable stash (its settle done, or its removal never committed). */
	static void forgetDurable(String siteId) {
		if (DURABLE.remove(siteId) != null) {
			Stockpiles.owedChanged();
		}
	}

	/** Whether {@code stash} carries refunds (paid cells). */
	static boolean hasRefunds(@Nullable JsonObject stash) {
		return stash != null && !refundOf(stash).isEmpty();
	}

	/** Whether {@code stash} settles a crate (its stock, its cell, its journal entry), not refunds alone. */
	static boolean hasCrate(@Nullable JsonObject stash) {
		return stash != null && stash.has("crateOwner");
	}

	/** The crate's position in {@code stash}. */
	static BlockPos posOf(JsonObject stash) {
		return BlockPos.of(stash.get("pos").getAsLong());
	}

	static Map<String, Integer> refundOf(JsonObject stash) {
		Map<String, Integer> m = new TreeMap<>();
		if (stash.has("refund")) {
			stash.getAsJsonObject("refund").entrySet().forEach(e -> m.put(e.getKey(), e.getValue().getAsInt()));
		}
		return m;
	}

	/**
	 * The journal entry ids of {@code s} its removal's undo leaves out: its own crate's CRATE entry when {@code stash} settles that crate (the
	 * settle restores the cell after the commit; the undo would destroy the crate's block entity and stock with it).
	 */
	static List<String> excluded(Site s, @Nullable JsonObject stash) {
		return hasCrate(stash) && s.id().equals(stash.get("crateOwner").getAsString()) ? SiteJournal.idsOf(s.id(), WorldJournal.CRATE) : List.of();
	}

	/** Every active journal entry of {@code siteIds} but the {@code excluded} ones: what a removal's undo plans. */
	static List<String> undoIds(java.util.Collection<String> siteIds, java.util.Collection<String> excluded) {
		List<String> out = new java.util.ArrayList<>();
		for (String sid : siteIds) {
			for (dev.larattalabs.architect.journal.JournalStore.Meta m : SiteJournal.active(sid)) {
				if (!excluded.contains(m.id())) {
					out.add(m.id());
				}
			}
		}
		return out;
	}

	/** The result of one settle: owed keys (for {@code RemoveResult.owed()}), what it gave back, whether it is held (retry) or refused. */
	record Settled(List<String> owed, Map<String, Integer> given, @Nullable String held, @Nullable String refused) {
		static final Settled NONE = new Settled(List.of(), Map.of(), null, null);

		boolean done() {
			return held == null;
		}
	}

	/**
	 * Settles {@code stash} in one keyed txn: the crate's stock (read from the crate now; its chunk loaded) owed {@code crate_settle} or credited
	 * to the recipient's pile, the refunds owed {@code group_refund} or credited, the crate's cell restored and its CRATE entry released.
	 * A crate gone or another's at the settle: the refunds alone, under the same key (a re-run after the crate's own settle committed replays).
	 * Held (a txn holds the crate, the journal unavailable, the txn held after its decision): {@link Settled#held}, retry later; the crate
	 * keeps its stock meanwhile. Server thread.
	 */
	static Settled settle(ServerLevel level, JsonObject stash) {
		String key = stash.get("key").getAsString();
		String dim = stash.get("dim").getAsString();
		BlockPos pos = posOf(stash);
		String recipient = stash.get("recipient").getAsString();
		String pile = stash.has("pile") ? stash.get("pile").getAsString() : null;
		if (pile != null && Stockpiles.get(pile) == null && !isPileStash(stash)) {
			pile = null; // dissolved since: owed instead
		}
		String site = stash.has("site") ? stash.get("site").getAsString() : null;
		String region = stash.has("region") ? stash.get("region").getAsString() : null;
		Map<String, Integer> refund = isPileStash(stash) ? Map.of() : refundOf(stash);
		Removal rm = removalOf(level, stash);
		if (rm.held() != null) {
			return new Settled(List.of(), Map.of(), rm.held(), rm.held()); // not begun: retried, nothing of it happened
		}
		if (hasCrate(stash)) {
			String owner = stash.get("crateOwner").getAsString();
			if (level.getBlockEntity(pos) instanceof CrateBlockEntity be && owner.equals(be.siteId())) {
				Map<String, Integer> stock = be.ledger().heldStock();
				if (stash.has("sharedGroup")) {
					SiteGroupRec sg = Sites.group(stash.get("sharedGroup").getAsString());
					if (sg != null) {
						Sites.putGroup(level.getServer(), sg.withDelivered(be.ledger().delivered())); // a shared crate's delivered counts stay on the group
					}
				}
				Settled s = run(new CrateTxn.Settle(key, dim, pos, stock, refund, recipient, pile, site, region, stash.get("state").getAsString(), stash.has("nbt")
					? stash.get("nbt").getAsString() : null, owner, true), rm);
				if (!s.done() || s.refused() == null || !s.refused().startsWith("aborted")) {
					return s; // done, or held (retried: the crate keeps its stock)
				}
				// e0 refused (the crate changed under the begin): the refunds alone below, the crate as it stands (an orphan: no loss)
			} else {
				Architect.LOGGER.warn("crate.settle {}: the crate at {} is gone or another's: its refunds alone", key, pos.toShortString());
				if (!(level.getBlockEntity(pos) instanceof CrateBlockEntity)) {
					releaseJournal(owner); // no crate stands there: its entry goes (idempotent)
				}
			}
		}
		if (refund.isEmpty() && rm.first().isEmpty() && rm.last().isEmpty()) {
			return Settled.NONE;
		}
		return run(new CrateTxn.Settle(key, dim, pos, Map.of(), refund, recipient, pile, site, region, null, null, null, false), rm);
	}

	/**
	 * (slice T4b) What a removal's settle adds to T2b's crate.settle: its kind, the W restore of the removed site first (its committed undo
	 * group, from the stash or the journal), a stockpile site's refund last, and the removal's box held (N3). {@code held}: why it can't begin
	 * now (a store unreadable, the records not loaded, a removal not committed): nothing begins, it is retried. A stash with no undo group
	 * (a group removal's member, T4c's) settles as T2b did.
	 */
	record Removal(String kind, List<dev.larattalabs.architect.txn.Effect.Builder> first, List<dev.larattalabs.architect.txn.Effect.Builder> last,
		List<String> more, @Nullable String held) {
		static final Removal LEGACY = new Removal(CrateTxn.SETTLE, List.of(), List.of(), List.of(), null);
	}

	static Removal removalOf(ServerLevel level, JsonObject stash) {
		String site = stash.has("site") ? stash.get("site").getAsString() : null;
		if (site == null || !stash.has("undoGroup") && !isPileStash(stash) && !stash.has("road")) {
			return Removal.LEGACY;
		}
		String why = notReady();
		if (why != null) {
			return new Removal(CrateTxn.SETTLE, List.of(), List.of(), List.of(), why);
		}
		String kind = stash.has("road") ? dev.larattalabs.architect.txn.RemovalTxn.ROAD : dev.larattalabs.architect.txn.RemovalTxn.SITE;
		String group = stash.has("undoGroup") ? stash.get("undoGroup").getAsString() : latestUndone(site);
		List<dev.larattalabs.architect.txn.Effect.Builder> first = new java.util.ArrayList<>();
		List<String> more = new java.util.ArrayList<>();
		if (group != null && undoneExists(site, group)) {
			try {
				first.add(dev.larattalabs.architect.txn.RemovalTxn.restore(stash.get("dim").getAsString(), site, group, chunksOf(level, site, group)));
				SiteJournal.Restore r = SiteJournal.restore(level, site, group);
				dev.larattalabs.architect.placement.Anchors.Bounds b = r.box();
				if (b != null) {
					more.add(dev.larattalabs.architect.txn.RemovalTxn.box(stash.get("dim").getAsString(), b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()));
				}
			} catch (Sites.SiteException e) {
				return new Removal(kind, List.of(), List.of(), List.of(), "its restore can't be read: " + e.getMessage());
			}
		} else if (standsInJournal(site)) {
			// its undo was never committed: it stands (the removal stopped before its decision), so nothing of it is paid; the caller drops it
			return new Removal(kind, List.of(), List.of(), List.of(), "not committed");
		}
		List<dev.larattalabs.architect.txn.Effect.Builder> last = new java.util.ArrayList<>();
		if (isPileStash(stash)) {
			String owner = stash.get("pile").getAsString();
			String pk = stash.get("pileKey").getAsString();
			Stockpiles.Pile p = Stockpiles.get(owner);
			Map<String, Integer> refund = refundOf(stash);
			if (p != null && !p.ledger.credited(pk) && (!refund.isEmpty() || !p.ledger.custody(pk).isEmpty())) {
				last.add(dev.larattalabs.architect.txn.RemovalTxn.pileRefund(owner, pk, refund, posOf(stash)));
			} else if (p != null && !p.ledger.credited(pk)) {
				Stockpiles.creditOfNothing(p, pk); // nothing to credit: its pending credit and its paid record go (no item moves)
			}
		}
		return new Removal(kind, first, last, more, null);
	}

	static Settled run(CrateTxn.Settle in) {
		return run(in, Removal.LEGACY);
	}

	static Settled run(CrateTxn.Settle in, Removal rm) {
		if (in.stock().isEmpty() && in.refund().isEmpty() && !in.restore() && rm.first().isEmpty() && rm.last().isEmpty()) {
			return Settled.NONE;
		}
		CrateTxn.Answer a = CrateTxn.settle(in, rm.kind(), rm.first(), rm.last(), rm.more());
		// (T2b part 2b) a barrier refused before the decision aborts the attempt (its take compensated: the stock back in the crate); an aborted
		// attempt is never cached under the key, so it is retried as a hold, never taken for "the crate changed" (that orphaned the crate)
		if (a.refused() != null && (a.refused().startsWith("held") || a.refused().startsWith("journal_unavailable") || a.refused().startsWith("aborted: barrier"))) {
			Architect.LOGGER.info("crate.settle {}: {}: retried later, the crate keeps its stock", in.key(), a.refused());
			return new Settled(List.of(), Map.of(), a.refused(), a.refused()); // not begun: nothing of it will happen unless retried
		}
		if (a.refused() != null) {
			Architect.LOGGER.warn("crate.settle {}: refused ({}): the crate stays as it stands, its stock in it", in.key(), a.refused());
		}
		return new Settled(a.owed(), a.given(), a.held(), a.refused());
	}

	// ------------------------------------------------------------------ a single removal's settle at a restart (its pending record)

	/** Settles the pending record of {@code siteId} from its stash on the next tick (a restart between the removal's commit and its settle). */
	static void resumeLater(MinecraftServer srv, String siteId) {
		dev.larattalabs.architect.txn.TxnServer.later(() -> resumeNow(srv, siteId));
	}

	private static void resumeNow(MinecraftServer srv, String siteId) {
		Site.Pending p = Sites.pendingOf(siteId);
		if (p == null) {
			// (T2b last round P1 2) no pending removal (a recovery brought the site back, or it settled): nothing is paid here; a durable stash
			// left alone is the sweep's (it pays only a site that is gone)
			return;
		}
		JsonObject st = durable(siteId); // (T2b fix round P1-c) the stash with its refunds, saved before the undo committed
		if (st == null) {
			st = p.settle();
		}
		if (st == null) {
			return;
		}
		ServerLevel level = Sites.levelOf(srv, p.site());
		if (level == null) {
			return;
		}
		Settled s = settle(level, st);
		if (!s.done()) {
			if ("not committed".equals(s.held())) {
				Architect.LOGGER.warn("crate.settle of {}: its removal was never committed (its entries active): nothing paid, its stash dropped", siteId);
				Sites.settled(srv, siteId);
				return;
			}
			resumeLater(srv, siteId); // held: next tick (the crate keeps its stock)
			return;
		}
		Sites.settled(srv, siteId); // (its durable stash forgotten too, record or not)
		Architect.LOGGER.info("crate.settle of removed {} at a restart: owed {}, given {}", siteId, s.owed(), s.given());
	}

	/**
	 * (slice T4b, finding 3a) A pending road or cell site whose removal committed with a durable stash (its job lost, or ended before its
	 * settle): its removal txn settles it, its restore written again first, on the next tick; then its pending record goes. Never judged by
	 * its majority, never dropped ahead of its restore.
	 */
	static void resumeInfraLater(MinecraftServer srv, String roadId) {
		dev.larattalabs.architect.txn.TxnServer.later(() -> resumeInfraNow(srv, roadId));
	}

	private static void resumeInfraNow(MinecraftServer srv, String roadId) {
		JsonObject st = durable(roadId);
		if (st == null || Infras.pending(roadId) == null) {
			return;
		}
		ServerLevel level = Sites.levelOf(srv, st.get("dim").getAsString());
		if (level == null) {
			return;
		}
		Settled s = settle(level, st);
		if (!s.done()) {
			if (!"not committed".equals(s.held())) {
				resumeInfraLater(srv, roadId);
			}
			return;
		}
		forgetDurable(roadId);
		// its restore is on disk (the txn's barrier came before its retirement): its undone entries go, then its pending record
		List<String> ids = SiteJournal.entries(roadId).stream().filter(m -> m.status() == dev.larattalabs.architect.journal.Journal.Status.UNDONE)
			.map(dev.larattalabs.architect.journal.JournalStore.Meta::id).toList();
		SiteJournal.releaseGroup(ids);
		Infras.drop(srv, roadId);
		Architect.LOGGER.info("removal.road of {} at a restart: owed {}, given {}", roadId, s.owed(), s.given());
	}

	// ------------------------------------------------------------------ the hooks the adapters reach (server thread)

	/** The crate's cell back to what stood there before it (its snapshot): the crate block entity goes, its chunk's receipts stay. */
	public static void restoreCell(ServerLevel level, BlockPos p, String snapshotState, @Nullable String snapshotNbt) {
		Builder.restoreCrateCell(level, new Construction.Crate(p.getX(), p.getY(), p.getZ(), snapshotState, snapshotNbt));
	}

	/** Releases {@code crateOwner}'s CRATE journal entries (idempotent). */
	public static void releaseJournal(String crateOwner) {
		SiteJournal.releaseKind(crateOwner, WorldJournal.CRATE);
	}

	/** Whether {@code crateOwner} still has an active CRATE journal entry. */
	public static boolean journalActive(String crateOwner) {
		return !SiteJournal.idsOf(crateOwner, WorldJournal.CRATE).isEmpty();
	}

	/** Whether {@code owner}'s pile credited {@code key} (the L probe). */
	public static boolean credited(String owner, String key) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		return p != null && p.ledger.credited(key);
	}

	/** Credits {@code items} into {@code owner}'s pile under {@code key}, once, past capacity (OVF): one ledger change. */
	public static void credit(MinecraftServer srv, String owner, String key, Map<String, Integer> items) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		if (p == null) {
			throw new IllegalStateException(owner + " has no stockpile now");
		}
		p.ledger.credit(key, new TreeMap<>(items), Stockpiles.capacity(srv, p), Stockpiles::maxStack);
		Stockpiles.changed(p);
	}

	static JsonObject json(Settled s) {
		JsonObject o = new JsonObject();
		o.add("owed", new com.google.gson.Gson().toJsonTree(s.owed()));
		o.add("given", Builder.counts(s.given()));
		if (s.held() != null) {
			o.addProperty("held", s.held());
		}
		if (s.refused() != null) {
			o.addProperty("refused", s.refused());
		}
		return o;
	}
}
