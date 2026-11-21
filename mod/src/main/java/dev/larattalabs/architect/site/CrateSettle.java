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
		return withCells(o, d.tally().cells(), s.restoreBox());
	}

	/**
	 * (T4b fix round, N3) {@code stash} told its refunded cells (pos, block id, items: the restore pays min(planned, what it finds standing))
	 * and its box (the removal's hold from the tally on: no block in it changes but by the removal, while the stash is durable).
	 */
	static JsonObject withCells(JsonObject stash, java.util.@Nullable Collection<dev.larattalabs.architect.survival.Refunds.Cell> cells,
		dev.larattalabs.architect.placement.Anchors.Bounds box) {
		if (cells != null) { // null: a refund booked without its cell (no min: the planned amounts stand)
			com.google.gson.JsonArray a = new com.google.gson.JsonArray();
			for (dev.larattalabs.architect.survival.Refunds.Cell c : cells) {
				JsonObject x = new JsonObject();
				x.addProperty("pos", c.pos());
				x.addProperty("block", c.block());
				x.add("items", Builder.counts(c.items()));
				a.add(x);
			}
			stash.add("cells", a);
		}
		com.google.gson.JsonArray b = new com.google.gson.JsonArray();
		for (int v : new int[] {box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ()}) {
			b.add(v);
		}
		stash.add("box", b);
		boxesChanged();
		return stash;
	}

	/** (T4 final round, P1 3) {@code stash} told its road's footprint: the hold covers those cells, not the road's bounding rectangle. */
	static JsonObject withFootprint(JsonObject stash, java.util.Collection<net.minecraft.core.BlockPos> cells) {
		if (cells.isEmpty()) {
			return stash; // no footprint read: the whole box stays held
		}
		com.google.gson.JsonArray h = new com.google.gson.JsonArray();
		for (net.minecraft.core.BlockPos p : cells) {
			h.add(p.asLong());
		}
		stash.add("hold", h);
		boxesChanged();
		return stash;
	}

	/** (T4b fix round) {@code stash} with its removal's box (the hold), unless it names one: a converted pre-T4 stash has none. */
	static JsonObject withBox(JsonObject stash, dev.larattalabs.architect.placement.Anchors.Bounds box) {
		if (!stash.has("box")) {
			com.google.gson.JsonArray b = new com.google.gson.JsonArray();
			for (int v : new int[] {box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ()}) {
				b.add(v);
			}
			stash.add("box", b);
		}
		return stash;
	}

	/** (T4b fix round, finding 5) A stockpile's road's removal: its refund credited by its removal.road txn after its restore. */
	static JsonObject pileRoadStash(Infra road, String owner, String key, Map<String, Integer> refund,
		java.util.@Nullable Collection<dev.larattalabs.architect.survival.Refunds.Cell> cells, BlockPos at) {
		JsonObject o = new JsonObject();
		o.addProperty("key", "pile-refund:" + key);
		o.addProperty("dim", road.dimension());
		o.addProperty("pos", at.asLong());
		o.addProperty("recipient", owner);
		o.addProperty("pile", owner);
		o.addProperty("site", road.id());
		o.addProperty("pileKey", key);
		o.addProperty("road", true);
		o.add("refund", Builder.counts(refund));
		return withCells(o, cells, road.box());
	}

	/**
	 * (slice T4R, R1) A group member's stockpile credit (a gate mechanism's charge, a pre-T4R queue's {@code decCredit}) as a pile stash:
	 * credited by the group's txn after the member's W. {@code cells} null: no per-cell min (the planned amounts stand).
	 */
	static JsonObject pileCreditStash(String site, String dim, String owner, String key, Map<String, Integer> refund, BlockPos at,
		java.util.@Nullable Collection<dev.larattalabs.architect.survival.Refunds.Cell> cells, dev.larattalabs.architect.placement.Anchors.@Nullable Bounds box) {
		JsonObject o = new JsonObject();
		o.addProperty("key", "pile-refund:" + key);
		o.addProperty("dim", dim);
		o.addProperty("pos", at.asLong());
		o.addProperty("recipient", owner);
		o.addProperty("pile", owner);
		o.addProperty("site", site);
		o.addProperty("pileKey", key);
		o.add("refund", Builder.counts(refund));
		if (box == null) {
			if (cells != null) {
				withCells(o, cells, new dev.larattalabs.architect.placement.Anchors.Bounds(0, 0, 0, 0, 0, 0));
				o.remove("box");
			}
			return o;
		}
		return withCells(o, cells, box);
	}

	/**
	 * (slice T4R, R1) Plans one group member's settle into its {@code removal.group} txn, after that member's W effect {@code w} (-1: none,
	 * its restore already settled): the same effects {@link #settle} runs alone (its crate's stock read now, under the txn's hold from its
	 * begin; its refunds paying min(planned, found by w); its crate cell restored and its entry released; or a stockpile's refund), each
	 * tagged with {@code member}. {@code res}: the crates and piles it holds. Server thread.
	 */
	static List<dev.larattalabs.architect.txn.Effect.Builder> planInto(ServerLevel level, JsonObject stash, int w, String member, java.util.Set<String> res) {
		List<dev.larattalabs.architect.txn.Effect.Builder> out = new java.util.ArrayList<>();
		String key = stash.get("key").getAsString();
		String dim = stash.get("dim").getAsString();
		BlockPos pos = posOf(stash);
		String recipient = stash.get("recipient").getAsString();
		String site = stash.has("site") ? stash.get("site").getAsString() : null;
		String region = stash.has("region") ? stash.get("region").getAsString() : null;
		if (isPileStash(stash)) {
			String owner = stash.get("pile").getAsString();
			String pk = stash.get("pileKey").getAsString();
			Stockpiles.Pile p = Stockpiles.get(owner);
			Map<String, Integer> refund = refundOf(stash);
			if (p == null) {
				if (!refund.isEmpty()) { // its pile gone: owed to its owner, never dropped
					dev.larattalabs.architect.txn.Effect.Builder ow = dev.larattalabs.architect.txn.Effect.of(CrateTxn.OWE, dev.larattalabs.architect.txn.EffectClass.O)
						.items(refund).move("world", "owed").data("key", key).data("recipient", owner).data("dim", dim).data("pos", posJsonOf(pos)).data("reason",
							OwedLedger.GROUP_REFUND);
					if (site != null) {
						ow.data("site", site);
					}
					out.add(w >= 0 ? ow.data("minOf", w) : ow);
				}
			} else {
				res.add("pile:" + owner);
				if (!p.ledger.credited(pk)) {
					dev.larattalabs.architect.txn.Effect.Builder pr = dev.larattalabs.architect.txn.RemovalTxn.pileRefund(owner, pk, refund, pos);
					out.add(w >= 0 ? pr.data("minOf", w) : pr);
				}
			}
			out.forEach(b -> b.member(member));
			return out;
		}
		String pile = stash.has("pile") ? stash.get("pile").getAsString() : null;
		if (pile != null && Stockpiles.get(pile) == null) {
			pile = null; // dissolved since: owed instead
		}
		Map<String, Integer> refund = refundOf(stash);
		boolean crate = false;
		if (hasCrate(stash)) {
			String owner = stash.get("crateOwner").getAsString();
			if (level.getBlockEntity(pos) instanceof CrateBlockEntity be && owner.equals(be.siteId())) {
				Map<String, Integer> stock = be.ledger().heldStock();
				if (stash.has("sharedGroup")) {
					SiteGroupRec sg = Sites.group(stash.get("sharedGroup").getAsString());
					if (sg != null) {
						Sites.putGroup(level.getServer(), sg.withDelivered(be.ledger().delivered()));
					}
				}
				out.addAll(CrateTxn.planOf(new CrateTxn.Settle(key, dim, pos, stock, refund, recipient, pile, site, region, stash.get("state").getAsString(), stash.has(
					"nbt") ? stash.get("nbt").getAsString() : null, owner, true), Math.max(w, 0), w >= 0));
				res.add(CrateTxn.resource(dim, pos));
				crate = true;
			} else if (!(level.getBlockEntity(pos) instanceof CrateBlockEntity)) {
				releaseJournal(owner); // no crate stands there: its entry goes (idempotent)
			}
		}
		if (!crate && !refund.isEmpty()) {
			out.addAll(CrateTxn.planOf(new CrateTxn.Settle(key, dim, pos, Map.of(), refund, recipient, pile, site, region, null, null, null, false), Math.max(w,
				0), w >= 0));
		}
		if (pile != null && !out.isEmpty()) {
			res.add("pile:" + pile);
		}
		out.forEach(b -> b.member(member));
		return out;
	}

	/**
	 * (slice T4R fix round, P1-3 and P1-4; pure) Whether a pre-T4 credit's journal cell counts as found: what its placement wrote ({@code after},
	 * over {@code before}) still stands, or its old job already restored it ({@code before} stands: that refund is owed too); a cell a player
	 * changed since (neither) does not.
	 */
	static boolean legacyFound(String after, String before, String now) {
		return !after.equals(before) && (now.equals(after) || now.equals(before));
	}

	/**
	 * (slice T4R-L seam) What one journal cell of a pre-T4R credit counts as found, given the block standing ({@code now}) and what its
	 * placement wrote over what ({@code after} over {@code before}): as the T4R fix round counted it, one item of {@code after}'s block when
	 * {@link #legacyFound}. Pure (registries only).
	 */
	static Map<String, Integer> legacyItems(net.minecraft.world.level.block.state.BlockState now, String after, String before) {
		if (!legacyFound(after, before, Builder.blockId(now)) || after.equals("minecraft:air")) {
			return Map.of();
		}
		net.minecraft.world.level.block.Block b = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getValue(net.minecraft.resources.Identifier.parse(
			after));
		String item = net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(b.asItem()).toString();
		return item.equals("minecraft:air") ? Map.of() : Map.of(item, 1);
	}

	/**
	 * (slice T4R fix round, P1-3 and P1-4) A pre-T4 credit's found evidence: every cell its entries wrote ({@code group}'s undone entries, or
	 * the site's active ones while its undo is not committed) that {@link #legacyFound} counts, as a refunded cell (its block as it stands, the
	 * item its placement put there, one). Recorded in its chunks before its W's first write (the hold covers it since the queue loaded), so
	 * its refund pays min(the credit, what was found): the restored cells included, a cell changed by a player not. Null: unreadable.
	 */
	static java.util.@Nullable List<dev.larattalabs.architect.survival.Refunds.Cell> legacyCells(ServerLevel level, String siteId, @Nullable String group) {
		dev.larattalabs.architect.journal.JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return null;
		}
		List<dev.larattalabs.architect.journal.JournalStore.Meta> metas = group != null && !SiteJournal.undone(siteId, group).isEmpty() ? SiteJournal.undone(
			siteId, group) : SiteJournal.active(siteId);
		List<dev.larattalabs.architect.survival.Refunds.Cell> out = new java.util.ArrayList<>();
		try {
			for (dev.larattalabs.architect.journal.JournalStore.Meta m : metas) {
				if (m.kind().equals(WorldJournal.CRATE) || m.kind().equals(WorldJournal.LEAVES) || m.kind().equals(WorldJournal.SCAFFOLD)) {
					continue;
				}
				for (long k : m.sections()) {
					dev.larattalabs.architect.journal.SectionCells sc = js.section(m.id(), k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						dev.larattalabs.architect.journal.Journal.Value a = sc.after(i);
						if (a == null) {
							continue;
						}
						String after = a.name();
						String before = sc.before(i).name();
						BlockPos p = BlockPos.of(sc.pos(i));
						net.minecraft.world.level.block.state.BlockState st = level.getBlockState(p);
						Map<String, Integer> items = legacyItems(st, after, before);
						if (items.isEmpty()) {
							continue;
						}
						out.add(new dev.larattalabs.architect.survival.Refunds.Cell(sc.pos(i), Builder.blockId(st), items));
					}
				}
			}
		} catch (java.io.IOException e) {
			return null;
		}
		return out;
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

	/** (slice T4R, R1) Whether a group's removal still has to write {@code site}'s restore in undo group {@code group} itself (its W waits). */
	public static boolean writeWaits(String site, String group) {
		return Groups.writes(site, group);
	}

	/** (T4b fix round, finding 2) Whether the world journal can't be read now: its entries' absence then proves nothing (hold). */
	public static boolean journalUnreadable() {
		return WorldJournal.storeOrNull() == null || WorldJournal.unavailable() != null;
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

	/**
	 * Restores this session wrote already, {@code site|group}, with what of their refunded cells stood just before (per chunk): the W effect
	 * then only receipts them (the cells are in memory), its found amounts the ones read before the write.
	 */
	private static final java.util.Set<String> RESTORED_NOW = java.util.concurrent.ConcurrentHashMap.newKeySet();

	/**
	 * {@code site}'s committed restore in {@code group} was just written (R4, a restore job): its W receipts it. What of its refunded cells
	 * stood was recorded in each chunk before that write ({@link #recordFound}).
	 */
	static void markRestored(String site, String group) {
		RESTORED_NOW.add(site + "|" + group);
	}

	/**
	 * (T4b fix round, N3) Before the first write of a removal's restore: in each chunk of its refunded cells, what of them stands now, recorded
	 * in that chunk's receipts (the same tick as the writes after it, so a saved chunk that holds a restored cell holds this too). Never
	 * recorded twice: a later replay reads it, not the world (which then shows the restore).
	 */
	static void recordFound(ServerLevel level, String site, String group, @Nullable JsonObject stash) {
		if (stash != null && stash.get("cells") instanceof com.google.gson.JsonArray a) {
			dev.larattalabs.architect.txn.RemovalTxn.recordFound(level, site, group, a);
		}
	}

	/** (T4b fix round, N3) What of {@code stash}'s refunded cells stands in {@code level} now, per chunk (packed cx, cz). Empty: no cells. */
	static Map<Long, Map<String, Integer>> foundNow(ServerLevel level, @Nullable JsonObject stash) {
		return stash == null || !(stash.get("cells") instanceof com.google.gson.JsonArray a) ? Map.of() : foundIn(level, a);
	}

	/** {@link #foundNow} over a {@code cells} array ([{pos, block, items}]). */
	public static Map<Long, Map<String, Integer>> foundIn(ServerLevel level, com.google.gson.JsonArray cells) {
		Map<Long, Map<String, Integer>> out = new TreeMap<>();
		for (var el : cells) {
			JsonObject c = el.getAsJsonObject();
			BlockPos p = BlockPos.of(c.get("pos").getAsLong());
			long ch = pack(p.getX() >> 4, p.getZ() >> 4);
			Map<String, Integer> m = out.computeIfAbsent(ch, k -> new TreeMap<>());
			if (c.get("block").getAsString().equals(Builder.blockId(level.getBlockState(p)))) {
				c.getAsJsonObject("items").entrySet().forEach(e -> m.merge(e.getKey(), e.getValue().getAsInt(), Integer::sum));
			}
		}
		return out;
	}

	/** (pure, T4b fix round, N3) The restore's min: per item, the planned amount capped by what was found standing (null found: planned). */
	public static Map<String, Integer> minOf(Map<String, Integer> planned, @Nullable Map<String, Integer> found) {
		if (found == null) {
			return planned;
		}
		Map<String, Integer> out = new TreeMap<>();
		planned.forEach((k, v) -> {
			int n = Math.min(v, found.getOrDefault(k, 0));
			if (n > 0) {
				out.put(k, n);
			}
		});
		return out;
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
			return; // written this session (its found amounts recorded in its chunks before that write)
		}
		if (DevStart.failWriteNow()) {
			throw new IllegalStateException("TEST dev-start.json failWriteNow"); // (T4b fix round) the W apply fails: the txn holds, nothing paid
		}
		java.util.Set<String> was = WRITING;
		WRITING = java.util.Set.of(site);
		try {
			SiteJournal.writeNow(level, site, group);
		} catch (Sites.SiteException e) {
			throw new IllegalStateException("the restore of " + site + " could not be written: " + e.getMessage());
		} finally {
			WRITING = was;
		}
	}

	/** Why a removal's txn may not act now: a store that failed to load (never read as "empty"), or the Sites check not run yet. */
	public static @Nullable String notReady() {
		if (journalUnreadable() || Sites.loadFailed() || Stockpiles.loadFailed() || Placement.loadFailed() || dev.larattalabs.architect.txn.TxnServer.core()
			.loadFailed() != null) {
			return "records unreadable"; // (T4b, finding 3b; Steward: "Architect's records didn't load; it waits")
		}
		return Sites.ready() ? null : "records not loaded yet";
	}

	/** The chunks {@code site}'s restore in {@code group} writes ([cx, cz]), read from its journal entries. */
	static List<long[]> chunksOf(ServerLevel level, String site, String group) throws Sites.SiteException {
		return chunksOf(level, site, group, null);
	}

	/** {@link #chunksOf}, with the chunks of {@code cells} (the refunded cells: their found amounts are receipted there). */
	static List<long[]> chunksOf(ServerLevel level, String site, String group, com.google.gson.@Nullable JsonArray cells) throws Sites.SiteException {
		SiteJournal.Restore r = SiteJournal.restore(level, site, group);
		java.util.TreeSet<Long> set = new java.util.TreeSet<>();
		if (cells != null) {
			for (var el : cells) {
				BlockPos p = BlockPos.of(el.getAsJsonObject().get("pos").getAsLong());
				set.add(pack(p.getX() >> 4, p.getZ() >> 4));
			}
		}
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

	static com.google.gson.JsonArray posJsonOf(BlockPos p) {
		com.google.gson.JsonArray a = new com.google.gson.JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	static long pack(int cx, int cz) {
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
		if (!p.ledger.custody(key).isEmpty() && !p.ledger.credited(key)) {
			dev.larattalabs.architect.journal.WorldJournal.kill("FKC2"); // (TEST, Steward's alias) the member's W done, its custody's credit not yet
		}
		if (items.isEmpty() && p.ledger.custody(key).isEmpty()) {
			Stockpiles.creditOfNothing(p, key);
			p.ledger.credit(key, new TreeMap<>(), Stockpiles.capacity(srv, p), Stockpiles::maxStack); // the probe's key: booked once
			Stockpiles.changed(p);
			return;
		}
		Stockpiles.credit(srv, p, key, new TreeMap<>(items), at);
		Stockpiles.changed(p);
		Stockpiles.creditSaves++; // (T4b) J1's credit save is this txn's barrier (players, chunks, then the ledger), counted as one
		REFUND_PUBLISHING = true;
	}

	/** (TEST alias CS1) A removal txn booked a stockpile refund that its barrier has not published yet. */
	private static volatile boolean REFUND_PUBLISHING;

	static boolean refundPublishing() {
		return REFUND_PUBLISHING;
	}

	static void refundPublished() {
		REFUND_PUBLISHING = false;
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

	// ------------------------------------------------------------------ (T4b fix round, N3) the removal's hold, from the tally on

	/**
	 * A durable stash's box: no block in it changes but by its removal (and the txns' own adapters) while the stash is durable. {@code site}:
	 * the removal's site or road; {@code cells}: (T4 final round) a CELL road's footprint (null: the whole box).
	 */
	record HeldBox(String dim, int x0, int y0, int z0, int x1, int y1, int z1, String site, it.unimi.dsi.fastutil.longs.@Nullable LongSet cells) {
	}

	private static volatile List<HeldBox> HELD = List.of();
	/**
	 * The sites whose removal is writing now (its restore, its after-restore steps, a road's restore job): the holds exempt those removals'
	 * own boxes only. (slice T4R fix round, P2) scoped: every other removal's box and stash stays held while one restore runs.
	 */
	public static volatile java.util.Set<String> WRITING = java.util.Set.of();

	static void boxesChanged() {
		List<JsonObject> all = new java.util.ArrayList<>(DURABLE.values());
		all.addAll(HOLD_ONLY.values());
		HELD = heldOf(all);
	}

	/**
	 * (slice T4R, R2) Holds kept in memory only, from the queue's load on: a pre-T4 queued road removal's footprint before (and while) its
	 * conversion's stash is saved, so no player mines a paid block of it inside the start grace or while that save is refused.
	 */
	private static final Map<String, JsonObject> HOLD_ONLY = new TreeMap<>();

	static void holdOnly(String id, JsonObject stash) {
		HOLD_ONLY.put(id, stash.deepCopy());
		boxesChanged();
	}

	static void forgetHoldOnly(String id) {
		if (HOLD_ONLY.remove(id) != null) {
			boxesChanged();
		}
	}

	static void clearHoldOnly() {
		HOLD_ONLY.clear();
		boxesChanged();
	}

	/** (T4 final round's seam) The holds of {@code stashes}: each one's box, its site, its footprint ("hold": cell longs) when it names one. Pure. */
	static List<HeldBox> heldOf(java.util.Collection<JsonObject> stashes) {
		List<HeldBox> out = new java.util.ArrayList<>();
		for (JsonObject st : stashes) {
			if (st.get("box") instanceof com.google.gson.JsonArray b && b.size() == 6 && st.has("dim")) {
				it.unimi.dsi.fastutil.longs.LongSet cells = null;
				if (st.get("hold") instanceof com.google.gson.JsonArray h) {
					cells = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
					for (com.google.gson.JsonElement e : h) {
						cells.add(e.getAsLong());
					}
				}
				out.add(new HeldBox(st.get("dim").getAsString(), b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4)
					.getAsInt(), b.get(5).getAsInt(), st.has("site") ? st.get("site").getAsString() : "", cells));
			}
		}
		return List.copyOf(out);
	}

	/**
	 * (T4 final round's seam) Whether {@code (x, y, z)} of {@code dim} is held by one of {@code held} for a writer: {@code writerSite}, the
	 * removal the writing txn adapter belongs to ({@code ""}: a txn that is no removal's; null: no txn writes now). Pure.
	 */
	static boolean heldFor(List<HeldBox> held, String dim, int x, int y, int z, @Nullable String writerSite) {
		for (HeldBox b : held) {
			if (!b.dim().equals(dim) || x < b.x0() || y < b.y0() || z < b.z0() || x > b.x1() || y > b.y1() || z > b.z1()) {
				continue;
			}
			if (b.cells() != null && !b.cells().contains(net.minecraft.core.BlockPos.asLong(x, y, z))) {
				continue; // (T4 final round, P1 3) a CELL road holds its footprint, never the rest of its bounding rectangle
			}
			if (writerSite != null && writerSite.equals(b.site())) {
				continue; // (P1 3) the adapter of the txn that owns this removal; any other txn's adapter is refused
			}
			if (WRITING.contains(b.site())) {
				continue; // (slice T4R fix round) that removal's own writes (its restore, its road job): no other removal's
			}
			return true;
		}
		return false;
	}

	/**
	 * (T4b fix round, finding 6) Why {@code owner}'s pile may not be dissolved now: an open txn holds it, or a durable removal stash credits
	 * into it; null when free.
	 */
	public static @Nullable String pileHeld(String owner) {
		String s = stashCrediting(owner);
		return s != null ? s : dev.larattalabs.architect.txn.TxnServer.heldWhy("pile:" + owner);
	}

	/** The durable removal stash that credits into {@code owner}'s pile, as "the removal of <id>", or null. */
	static @Nullable String stashCrediting(String owner) {
		for (var e : DURABLE.entrySet()) {
			// (T4 final round, P1 1) a stockpile site's or road's refund, or a crate-fed settle whose stock or refund credits the pile
			if (e.getValue().has("pile") && owner.equals(e.getValue().get("pile").getAsString())) {
				return "the removal of " + e.getKey();
			}
		}
		return null;
	}

	/** Whether any removal box is held (the guards' O(1) pre-check). */
	public static boolean anyHeldBox() {
		return !HELD.isEmpty();
	}

	/**
	 * (slice T4R-L seam) {@link #heldFor} for a writing txn that settles the removals of {@code writerSites} (null: no txn writes; empty: a
	 * txn that is no removal's): their holds accept its writes, every other one refuses them. Pure.
	 */
	static boolean heldForAny(List<HeldBox> held, String dim, int x, int y, int z, java.util.@Nullable Collection<String> writerSites) {
		for (HeldBox b : held) {
			if (!b.dim().equals(dim) || x < b.x0() || y < b.y0() || z < b.z0() || x > b.x1() || y > b.y1() || z > b.z1()) {
				continue;
			}
			if (b.cells() != null && !b.cells().contains(net.minecraft.core.BlockPos.asLong(x, y, z))) {
				continue;
			}
			if (writerSites != null && writerSites.contains(b.site())) {
				continue;
			}
			if (WRITING.contains(b.site())) {
				continue;
			}
			return true;
		}
		return false;
	}

	/** {@link #stashBoxHeld} for a txn adapter writing that settles the removals of {@code writerSites} ({@link #heldForAny}). */
	public static boolean stashBoxHeldBy(String dim, int x, int y, int z, java.util.@Nullable Collection<String> writerSites) {
		return heldForAny(HELD, dim, x, y, z, writerSites);
	}

	/**
	 * (TEST, slice T4R-L hooks: dev.removal.holdBox) A hold kept in memory over {@code cells} of {@code dim} for no removal ({@code dev:hold}):
	 * every writer is refused there, as by an unrelated removal's held box. Empty: dropped.
	 */
	public static void devHold(String dim, List<BlockPos> cells) {
		if (cells.isEmpty()) {
			forgetHoldOnly("dev:hold");
			return;
		}
		int x0 = Integer.MAX_VALUE, y0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, y1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
		for (BlockPos p : cells) {
			x0 = Math.min(x0, p.getX());
			y0 = Math.min(y0, p.getY());
			z0 = Math.min(z0, p.getZ());
			x1 = Math.max(x1, p.getX());
			y1 = Math.max(y1, p.getY());
			z1 = Math.max(z1, p.getZ());
		}
		JsonObject st = new JsonObject();
		st.addProperty("dim", dim);
		st.addProperty("site", "dev:hold");
		com.google.gson.JsonArray b = new com.google.gson.JsonArray();
		for (int v : new int[] {x0, y0, z0, x1, y1, z1}) {
			b.add(v);
		}
		st.add("box", b);
		withFootprint(st, cells);
		holdOnly("dev:hold", st);
	}

	/** Whether {@code (x, y, z)} of {@code dim} lies in a durable removal stash's box, outside the removal's own writes. */
	public static boolean stashBoxHeld(String dim, int x, int y, int z) {
		return stashBoxHeld(dim, x, y, z, null);
	}

	/** {@link #stashBoxHeld} for a txn adapter writing: {@code writerSite}, its removal's site ({@code ""}: no removal's txn; null: no txn). */
	public static boolean stashBoxHeld(String dim, int x, int y, int z, @Nullable String writerSite) {
		return heldFor(HELD, dim, x, y, z, writerSite);
	}

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
		boxesChanged();
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
			boxesChanged();
		}
		return any;
	}

	/** (T2b last round P1 3) Records a road removal's stash (in memory; the caller saves the ledger confirmed before its restore can commit). */
	static void holdDurable(String id, JsonObject stash) {
		DURABLE.put(id, stash.deepCopy());
		Stockpiles.owedChanged();
		boxesChanged();
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
		if (!SaveHold.admits(srv)) {
			dev.larattalabs.architect.txn.TxnServer.later(() -> sweep(srv)); // (SOFF) parked while saving is off, never refused mid-way
			return;
		}
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

	/**
	 * (T4b) The durable stashes as the Sites check sees them, which runs before the stockpiles load: read from {@code stockpiles.json} itself
	 * (read only; the stockpiles load it again after). Null when the file can't be read: then no committed construction removal may be
	 * judged at this start (its stash is unknown), and its entries are kept.
	 */
	static java.util.@Nullable Map<String, JsonObject> durableAtStart(MinecraftServer srv) {
		java.nio.file.Path f = srv.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT).resolve("architect").resolve(Stockpiles.FILE);
		Map<String, JsonObject> out = new TreeMap<>();
		if (!java.nio.file.Files.isRegularFile(f)) {
			return out;
		}
		try {
			JsonObject root = com.google.gson.JsonParser.parseString(java.nio.file.Files.readString(f, java.nio.charset.StandardCharsets.UTF_8))
				.getAsJsonObject();
			if (root.get("crateSettles") instanceof JsonObject cs) {
				cs.entrySet().forEach(e -> out.put(e.getKey(), e.getValue().getAsJsonObject()));
			}
			// (T4b fix round, finding 4, N8) a pre-T4 stockpile removal's held pending credit (J2's, or C29's for a road) enters the same protocol:
			// a pile stash, its restore (W) first, then its credit under its own key; never the threshold release with the absence-based book
			if (root.get("stockpiles") instanceof com.google.gson.JsonArray piles) {
				for (var pe : piles) {
					JsonObject po = pe.getAsJsonObject();
					if (!(po.get("ledger") instanceof JsonObject lg) || !(lg.get("pendingCredit") instanceof JsonObject pc)) {
						continue;
					}
					for (var e : pc.entrySet()) {
						JsonObject st = legacyStash(po.get("owner").getAsString(), po.get("dimension").getAsString(), e.getKey(), e.getValue().getAsJsonObject());
						if (st != null && !out.containsKey(st.get("site").getAsString())) {
							out.put(st.get("site").getAsString(), st);
						}
					}
				}
			}
			return out;
		} catch (java.io.IOException | RuntimeException e) {
			Architect.LOGGER.warn("Sites check: {} could not be read ({}): committed construction removals wait for the next start", f, e.toString());
			return null;
		}
	}

	/**
	 * (pure, T4b fix round, finding 4) A pre-T4 held pending credit as a pile stash: {@code site:<id>@<placedAt>} (a site) or
	 * {@code road:<id>@<placedAt>} (a road); null for any other key (a gate mechanism's, a delta's: legacy).
	 */
	static @Nullable JsonObject legacyStash(String owner, String dim, String key, JsonObject pending) {
		boolean road = key.startsWith("road:");
		if (!key.startsWith("site:") && !road || key.indexOf('@') < 0) {
			return null;
		}
		String id = key.substring(key.indexOf(':') + 1, key.lastIndexOf('@'));
		JsonObject o = new JsonObject();
		o.addProperty("key", "pile-refund:" + key);
		o.addProperty("dim", dim);
		o.addProperty("pos", pending.has("at") ? pending.get("at").getAsLong() : 0L);
		o.addProperty("recipient", owner);
		o.addProperty("pile", owner);
		o.addProperty("site", id);
		o.addProperty("pileKey", key);
		o.addProperty("legacy", true);
		if (road) {
			o.addProperty("road", true);
		}
		o.add("refund", pending.get("items") instanceof JsonObject it ? it.deepCopy() : new JsonObject());
		return o;
	}

	/**
	 * (T4b fix round) Whether a stash read at the check enters the new protocol: every real stash does; a converted pre-T4 pending credit only
	 * when its removal was a single removal (not a group's or a stage's undo, whose decCredit stays legacy until T4c).
	 */
	static boolean convertible(JsonObject stash, @Nullable String group) {
		// (slice T4R, R1) a group's or stage's credit converts like a single removal's. One its group's removal still owns (queued, or its
		// removal.group txn open) is that removal's (converted from its decCredit, credited by its txn after its W) and never reaches here
		// (Sites.reconcile skips owned members first); one no removal owns any more is a single removal.site txn's: W from its undo, then paid
		return true;
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
			boxesChanged();
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
	record Settled(List<String> owed, Map<String, Integer> given, @Nullable String held, @Nullable String refused, @Nullable JsonObject result) {
		static final Settled NONE = new Settled(List.of(), Map.of(), null, null, null);

		Settled(List<String> owed, Map<String, Integer> given, @Nullable String held, @Nullable String refused) {
			this(owed, given, held, refused, null);
		}

		/** (slice T4R) The credited part (L) of what it paid: {@code refund} of its txn's result, else what it gave when nothing is owed. */
		Map<String, Integer> credited() {
			return result != null && result.has("refund") ? CrateTxn.itemsOf(result, "refund") : owed.isEmpty() ? given : Map.of();
		}

		int restored() {
			return result != null && result.has("restored") ? result.get("restored").getAsInt() : 0;
		}

		int kept() {
			return result != null && result.has("kept") ? result.get("kept").getAsInt() : 0;
		}

		Map<String, Integer> handed() {
			return CrateTxn.itemsOf(result, "handed");
		}

		List<String> cascaded() {
			List<String> out = new java.util.ArrayList<>();
			if (result != null && result.get("cascaded") instanceof com.google.gson.JsonArray a) {
				a.forEach(x -> out.add(x.getAsString()));
			}
			return out;
		}

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
		List<String> more, @Nullable String held, @Nullable JsonObject fin) {
		static final Removal LEGACY = new Removal(CrateTxn.SETTLE, List.of(), List.of(), List.of(), null, null);

		Removal(String kind, List<dev.larattalabs.architect.txn.Effect.Builder> first, List<dev.larattalabs.architect.txn.Effect.Builder> last,
			List<String> more, @Nullable String held) {
			this(kind, first, last, more, held, null);
		}
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
		String dim = stash.get("dim").getAsString();
		if (stash.get("box") instanceof com.google.gson.JsonArray bx && bx.size() == 6 && !stash.has("hold")) {
			// (T4b fix round, N3) the removal's box, held while its txn is open as from its tally on. (T4 final round, P1 3) a CELL road's
			// footprint ("hold") is held by its durable stash alone, through its txn too: never its bounding rectangle
			more.add(dev.larattalabs.architect.txn.RemovalTxn.box(dim, bx.get(0).getAsInt(), bx.get(1).getAsInt(), bx.get(2).getAsInt(), bx.get(3).getAsInt(), bx
				.get(4).getAsInt(), bx.get(5).getAsInt()));
		}
		com.google.gson.JsonArray cells = stash.get("cells") instanceof com.google.gson.JsonArray ca ? ca : null;
		JsonObject fin = null;
		if (group != null && undoneExists(site, group)) {
			try {
				first.add(dev.larattalabs.architect.txn.RemovalTxn.restore(dim, site, group, chunksOf(level, site, group, cells), cells));
				SiteJournal.Restore r0 = SiteJournal.restore(level, site, group);
				if (stash.get("fin") instanceof JsonObject f0) {
					fin = f0.deepCopy(); // (fix round, P1-6) the result parts its removal recorded after its commit: restored, kept, hand-down, cascade
				} else {
					fin = new JsonObject(); // (slice T4R, P1-4) its restore's count, kept with the txn: a replayed or recovered result reports it
					int written = 0;
					for (dev.larattalabs.architect.journal.JournalStore.Meta m : SiteJournal.undone(site, group)) {
						written += m.cells(); // the cells its entries wrote: what its restore puts back (a BOX site's template included)
					}
					fin.addProperty("restored", Math.max(written, r0.cells().size()));
					fin.addProperty("kept", 0);
				}
				if (more.isEmpty()) {
					SiteJournal.Restore r = r0;
					dev.larattalabs.architect.placement.Anchors.Bounds b = r.box();
					if (b != null) {
						more.add(dev.larattalabs.architect.txn.RemovalTxn.box(dim, b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()));
					}
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
			if (p == null) {
				// (T4b fix round, finding 6) its stockpile is gone (dissolved before T4b's hold): the refund is owed to its owner, never dropped
				if (!refund.isEmpty()) {
					dev.larattalabs.architect.txn.Effect.Builder ow = dev.larattalabs.architect.txn.Effect.of(CrateTxn.OWE, dev.larattalabs.architect.txn.EffectClass.O)
						.items(refund).move("world", "owed").data("key", stash.get("key").getAsString()).data("recipient", owner).data("dim", dim).data("pos",
							posJsonOf(posOf(stash))).data("reason", OwedLedger.GROUP_REFUND).data("site", site);
					last.add(first.isEmpty() ? ow : ow.data("minOf", 0));
				}
			} else {
				more.add("pile:" + owner); // (finding 6) its pile held: no dissolve meanwhile
				if (!p.ledger.credited(pk) && (!refund.isEmpty() || !p.ledger.custody(pk).isEmpty())) {
					dev.larattalabs.architect.txn.Effect.Builder pr = dev.larattalabs.architect.txn.RemovalTxn.pileRefund(owner, pk, refund, posOf(stash));
					last.add(first.isEmpty() ? pr : pr.data("minOf", 0));
				} else if (!p.ledger.credited(pk)) {
					Stockpiles.creditOfNothing(p, pk); // nothing to credit: its pending credit and its paid record go (no item moves)
				}
			}
		}
		return new Removal(kind, first, last, more, null, fin);
	}

	static Settled run(CrateTxn.Settle in) {
		return run(in, Removal.LEGACY);
	}

	static Settled run(CrateTxn.Settle in, Removal rm) {
		if (in.stock().isEmpty() && in.refund().isEmpty() && !in.restore() && rm.first().isEmpty() && rm.last().isEmpty()) {
			return Settled.NONE;
		}
		CrateTxn.Answer a;
		try {
			a = CrateTxn.settle(in, rm.kind(), rm.first(), rm.last(), rm.more(), rm.fin());
		} finally {
			refundPublished();
		}
		// (T2b part 2b) a barrier refused before the decision aborts the attempt (its take compensated: the stock back in the crate); an aborted
		// attempt is never cached under the key, so it is retried as a hold, never taken for "the crate changed" (that orphaned the crate)
		if (a.refused() != null && (a.refused().startsWith("held") || a.refused().startsWith("journal_unavailable") || a.refused().startsWith("aborted: barrier"))) {
			Architect.LOGGER.info("crate.settle {}: {}: retried later, the crate keeps its stock", in.key(), a.refused());
			return new Settled(List.of(), Map.of(), a.refused(), a.refused()); // not begun: nothing of it will happen unless retried
		}
		if (a.refused() != null) {
			Architect.LOGGER.warn("crate.settle {}: refused ({}): the crate stays as it stands, its stock in it", in.key(), a.refused());
		}
		return new Settled(a.owed(), a.given(), a.held(), a.refused(), a.result());
	}

	// ------------------------------------------------------------------ a single removal's settle at a restart (its pending record)

	/** Settles the pending record of {@code siteId} from its stash on the next tick (a restart between the removal's commit and its settle). */
	static void resumeLater(MinecraftServer srv, String siteId) {
		dev.larattalabs.architect.txn.TxnServer.later(() -> resumeNow(srv, siteId));
	}

	private static void resumeNow(MinecraftServer srv, String siteId) {
		if (!SaveHold.admits(srv)) {
			resumeLater(srv, siteId); // (SOFF) parked while saving is off
			return;
		}
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
		Architect.LOGGER.info("crate.settle of removed {} at a restart: owed {}, given {}", siteId, s.owed(), s.given());
		if (!st.has("removalGroup")) {
			// (slice T4c) the held, decided removal finished by itself (this session or after a restart): REMOVAL_FINISHED with its result.
			// (slice T4R, P1-4) the full result from its txn (the credited refund, the restore's count; a replay's from its cached result),
			// fired before its stash is forgotten: a crash before the event leaves the stash, and the replay fires it again (at least once)
			dev.larattalabs.architect.apiimpl.ApiEvents.removalFinished(siteId, new Sites.Removed(p.site(), Map.copyOf(s.credited()), s.restored(), s.kept(),
				s.handed(), s.cascaded(), List.of(), List.copyOf(s.owed())));
		}
		Sites.settled(srv, siteId); // (its durable stash forgotten too, record or not)
	}

	/**
	 * (slice T4b, finding 3a) A pending road or cell site whose removal committed with a durable stash (its job lost, or ended before its
	 * settle): its removal txn settles it, its restore written again first, on the next tick; then its pending record goes. Never judged by
	 * its majority, never dropped ahead of its restore.
	 */
	static void resumeInfraLater(MinecraftServer srv, String roadId, @Nullable JsonObject read) {
		dev.larattalabs.architect.txn.TxnServer.later(() -> resumeInfraNow(srv, roadId, read));
	}

	private static void resumeInfraNow(MinecraftServer srv, String roadId, @Nullable JsonObject read) {
		if (!SaveHold.admits(srv)) {
			resumeInfraLater(srv, roadId, read); // (SOFF) parked while saving is off
			return;
		}
		JsonObject st = durable(roadId);
		if (st == null && read != null) {
			st = read; // (T4b fix round, finding 4) a pre-T4 road's pending credit, read at the check
			Infra pi = Infras.pending(roadId);
			if (pi != null) {
				withBox(st, pi.box());
			}
		}
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
				resumeInfraLater(srv, roadId, read);
			}
			return;
		}
		Infra gone = Infras.pending(roadId);
		Architect.LOGGER.info("removal.road of {} at a restart: owed {}, given {}", roadId, s.owed(), s.given());
		// (slice T4R, P1-4) a recovered road's removal finished: REMOVAL_FINISHED with its refund, before its stash and record go (a crash
		// before it replays the settle, which fires it again)
		dev.larattalabs.architect.apiimpl.ApiEvents.removalFinished(roadId, new Sites.Removed(null, Map.copyOf(s.credited()), s.restored(), s.kept(),
			s.handed(), s.cascaded(), List.of(), List.copyOf(s.owed())));
		forgetDurable(roadId);
		// its restore is on disk (the txn's barrier came before its retirement): its undone entries go, then its pending record
		List<String> ids = SiteJournal.entries(roadId).stream().filter(m -> m.status() == dev.larattalabs.architect.journal.Journal.Status.UNDONE)
			.map(dev.larattalabs.architect.journal.JournalStore.Meta::id).toList();
		SiteJournal.releaseGroup(ids);
		Infras.drop(srv, roadId);
		if (gone == null) {
			Architect.LOGGER.warn("removal.road of {}: no pending record at its end", roadId);
		}
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
