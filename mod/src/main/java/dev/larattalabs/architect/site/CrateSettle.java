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
		String recipient = s.owner() != null ? s.owner() : c.owner() != null ? c.owner() : "architect:unowned";
		Stockpiles.Pile p = Stockpiles.get(recipient);
		String pile = p != null && p.dimension.equals(s.dimension()) ? recipient : null;
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		String region = g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
		return new Ref(s.dimension(), new BlockPos(cc.x(), cc.y(), cc.z()), Builder.crateOwner(s), Builder.creditKey(s), Builder.sharedGroup(s) != null, cc,
			recipient, pile, s.id(), region);
	}

	/** The journal entry ids of {@code siteIds} the removal's undo plans: every active one but a crate the settle restores itself. */
	static List<String> excluded(Site s) {
		Ref r = refOf(s);
		return r == null || r.shared() ? List.of() : SiteJournal.idsOf(s.id(), WorldJournal.CRATE);
	}

	/** The result of one settle: owed keys (for {@code RemoveResult.owed()}), what it gave back, whether it is held or refused. */
	record Settled(List<String> owed, Map<String, Integer> given, @Nullable String held, @Nullable String refused) {
		static final Settled NONE = new Settled(List.of(), Map.of(), null, null);
	}

	/**
	 * Settles {@code s}'s crate (its stock) and its refunds {@code refund} (a crate-fed site's: owed {@code group_refund}, or credited to a
	 * pile) in one keyed txn. Nothing begins when the crate is unloaded, gone or another's (its stock stays in it: an orphan, no loss).
	 */
	static Settled settle(ServerLevel level, Site s, Map<String, Integer> refund) {
		Ref r = refOf(s);
		if (r == null) {
			return refund.isEmpty() ? Settled.NONE : settleRefundOnly(level, s, refund);
		}
		Map<String, Integer> stock = Map.of();
		if (!level.isLoaded(r.pos()) || !(level.getBlockEntity(r.pos()) instanceof CrateBlockEntity be) || !r.crateOwner().equals(be.siteId())) {
			Architect.LOGGER.warn("Crate of {} at {}: unloaded, gone or another's at the settle: it stays as it stands (its stock in it)", s.id(), r.pos()
				.toShortString());
			return refund.isEmpty() ? Settled.NONE : settleRefundOnly(level, s, refund);
		} else {
			stock = be.ledger().heldStock();
			SiteGroupRec sg = Builder.sharedGroup(s);
			if (sg != null) {
				Sites.putGroup(level.getServer(), sg.withDelivered(be.ledger().delivered())); // a shared crate's delivered counts stay on the group
			}
		}
		CrateTxn.Settle in = new CrateTxn.Settle(CrateTxn.settleKey(r.crateOwner(), r.pos(), r.siteKey()), r.dim(), r.pos(), stock, refund, r.recipient(),
			r.pile(), r.site(), r.region(), r.cell().snapshotState(), r.cell().snapshotNbt(), r.crateOwner(), true);
		return run(in);
	}

	/** A crate-fed site whose crate stays (shared, still building others, or unreadable): its refunds alone, owed or credited, keyed. */
	static Settled settleRefundOnly(ServerLevel level, Site s, Map<String, Integer> refund) {
		Construction c = s.construction();
		String recipient = s.owner() != null ? s.owner() : c != null && c.owner() != null ? c.owner() : "architect:unowned";
		Stockpiles.Pile p = Stockpiles.get(recipient);
		BlockPos at = c != null && c.crate() != null ? new BlockPos(c.crate().x(), c.crate().y(), c.crate().z()) : Builder.dropPos(s);
		SiteGroupRec g = s.group() == null ? null : Sites.group(s.group());
		String region = g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
		CrateTxn.Settle in = new CrateTxn.Settle("refund:" + Builder.creditKey(s), s.dimension(), at, Map.of(), refund, recipient, p != null && p.dimension
			.equals(s.dimension()) ? recipient : null, s.id(), region, null, null, null, false);
		return run(in);
	}

	static Settled run(CrateTxn.Settle in) {
		if (in.stock().isEmpty() && in.refund().isEmpty() && !in.restore()) {
			return Settled.NONE;
		}
		CrateTxn.Answer a = CrateTxn.settle(in);
		if (a.refused() != null) {
			Architect.LOGGER.warn("crate.settle {}: refused ({}): the crate stays as it stands, its stock in it", in.key(), a.refused());
		}
		return new Settled(a.owed(), a.given(), a.held(), a.refused());
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
