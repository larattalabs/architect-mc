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
		if (pile != null && Stockpiles.get(pile) == null) {
			pile = null; // dissolved since: owed instead
		}
		String site = stash.has("site") ? stash.get("site").getAsString() : null;
		String region = stash.has("region") ? stash.get("region").getAsString() : null;
		Map<String, Integer> refund = refundOf(stash);
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
					? stash.get("nbt").getAsString() : null, owner, true));
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
		if (refund.isEmpty()) {
			return Settled.NONE;
		}
		return run(new CrateTxn.Settle(key, dim, pos, Map.of(), refund, recipient, pile, site, region, null, null, null, false));
	}

	static Settled run(CrateTxn.Settle in) {
		if (in.stock().isEmpty() && in.refund().isEmpty() && !in.restore()) {
			return Settled.NONE;
		}
		CrateTxn.Answer a = CrateTxn.settle(in);
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
		if (p == null || p.settle() == null) {
			return;
		}
		ServerLevel level = Sites.levelOf(srv, p.site());
		if (level == null) {
			return;
		}
		Settled s = settle(level, p.settle());
		if (!s.done()) {
			resumeLater(srv, siteId); // held: next tick (the crate keeps its stock)
			return;
		}
		Sites.settled(srv, siteId);
		Architect.LOGGER.info("crate.settle of removed {} at a restart: owed {}, given {}", siteId, s.owed(), s.given());
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
