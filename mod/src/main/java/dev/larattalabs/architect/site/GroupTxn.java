package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.txn.Effect;
import dev.larattalabs.architect.txn.EffectClass;
import dev.larattalabs.architect.txn.RemovalTxn;
import dev.larattalabs.architect.txn.TxnCore;
import dev.larattalabs.architect.txn.TxnEntry;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R, R1, docs/CONTRACT.md "Phase T4" §3) A group's or stage's removal as one {@code removal.group} txn (N1: one txn per removal call,
 * one decision per group: its committed undo group). Begun once the undo committed, from the stashes the queue's confirmed pre-save holds
 * (fixed at prepare). Per paid member (one with a stash: a construction site's crate or pile refund, a stockpile road's credit, a gate
 * mechanism's charge): its W restore (receipted per chunk; it waits for the group's own write, one member at a time, and only receipts it),
 * a member barrier, its L/O/settle (min(planned, found by its W)), a member barrier. Then the group's shared crate, a barrier, and
 * {@code group.done}, which waits for the removal's end; then EFFECTS_DONE fires the one REMOVAL_FINISHED from its payload (at least once).
 * A member leaves the queue's remaining list only once {@link #memberDone}: its last member barrier passed (its settle durable).
 */
final class GroupTxn {
	private GroupTxn() {
	}

	/** The txn's key: {@code group:<id>[/stage]@<undoGroup>} (one removal call: a re-ask after a restart attaches). */
	static String key(String group, @Nullable String stage, String undo) {
		return "group:" + group + (stage == null ? "" : "/" + stage) + "@" + undo;
	}

	/** The shared crate's pseudo-member in the plan. */
	static String crateMember(String group) {
		return "crate:" + group;
	}

	/**
	 * Begins (or attaches to, or finds retired) {@code r}'s txn. Null once {@code r.gtx} (or {@code r.gtxDone}) is set; else why it waits
	 * (the txn file refused, a resource held by another txn, the records not ready). Server thread.
	 */
	static @Nullable String ensure(MinecraftServer server, Groups.Removal r) {
		if (r.gtx != null || r.gtxDone || r.undo == null) {
			return null;
		}
		String why = CrateSettle.notReady();
		if (why != null) {
			return why;
		}
		TxnCore c = TxnServer.core();
		String key = key(r.group, r.stage, r.undo);
		List<String> order = new ArrayList<>();
		for (String id : r.sites) {
			if (r.decSettle.containsKey(id) && r.undoSites.contains(id)) {
				order.add(id);
			}
		}
		for (String id : r.decSettle.keySet()) {
			if (!order.contains(id) && r.undoSites.contains(id)) {
				order.add(id); // a member out of the list already: planned too, last
			}
		}
		Set<String> res = new LinkedHashSet<>();
		res.add("site:group:" + r.group + (r.stage == null ? "" : "/" + r.stage));
		for (String id : order) {
			JsonObject st = r.decSettle.get(id);
			if (st.get("box") instanceof JsonArray b && b.size() == 6) {
				res.add(RemovalTxn.box(st.get("dim").getAsString(), b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4)
					.getAsInt(), b.get(5).getAsInt()));
			} else {
				// (N3) the member's box held while the txn is open: no player breaks a paid block in it before its W
				Site m = Sites.pendingRecord(id) != null ? Sites.pendingRecord(id) : Sites.get(id);
				Infra inf = m == null ? (Infras.pending(id) != null ? Infras.pending(id) : Infras.get(id)) : null;
				dev.larattalabs.architect.placement.Anchors.Bounds bx = m != null ? m.restoreBox() : inf != null ? inf.box() : null;
				if (bx != null) {
					res.add(RemovalTxn.box(st.get("dim").getAsString(), bx.minX(), bx.minY(), bx.minZ(), bx.maxX(), bx.maxY(), bx.maxZ()));
				}
			}
			resourcesOf(st, res);
		}
		if (r.crateSettle != null) {
			resourcesOf(r.crateSettle, res);
		}
		if (c.open().stream().noneMatch(t -> key.equals(t.key)) && c.cache().committed(key) == null) {
			// (slice T4R-M, the final check's P1-2) its holds are born here: never over another in-flight removal's area (a pre-T4R one's, a
			// stash's, a begun group's). It waits, holding nothing; that one never waits on it. A reattach or a replay takes no new hold
			String busy = overlapWhy(r);
			if (busy != null) {
				return "waits for another removal: " + busy;
			}
		}
		SiteGroupRec g = Sites.group(r.group);
		TxnCore.Started s = c.begin(RemovalTxn.GROUP, key, List.copyOf(res), g == null ? null : g.owner());
		switch (s.status()) {
			case UNAVAILABLE:
				return "records unreadable (" + s.detail() + ")";
			case HELD:
				return "held: " + s.detail();
			case REPLAYED:
				r.gtxDone = true; // retired already (a stop after its end, before the queue dropped the removal): every member settled
				return null;
			case ATTACHED:
				r.gtx = s.entry(); // a restart reattached it: its own box holds (and its writer's exemption over every member) as at its begin
				return null;
			default:
				break;
		}
		TxnEntry t = s.entry();
		// (fix round, P1-1) its decision is the committed journal undo: the txn adopts it and never aborts (a refused barrier holds it)
		c.plan(t, RemovalTxn.undoDecision(r.undo));
		for (String id : order) {
			JsonObject st = r.decSettle.get(id);
			ServerLevel level = Sites.levelOf(server, st.get("dim").getAsString());
			if (level == null) {
				return st.get("dim").getAsString() + " is not loaded";
			}
			JsonArray cells = st.get("cells") instanceof JsonArray ca ? ca : null;
			int w = -1;
			if (CrateSettle.undoneExists(id, r.undo)) {
				try {
					JsonArray player = st.get("player") instanceof JsonArray pa ? pa : new JsonArray();
					Effect.Builder wb = RemovalTxn.restore(st.get("dim").getAsString(), id, r.undo, CrateSettle.chunksOf(level, id, r.undo, OwnerRemovals.chunkCells(
						cells, player)), cells).member(id);
					if (!player.isEmpty()) {
						JsonArray pc = new JsonArray();
						player.forEach(p -> {
							JsonObject q = new JsonObject();
							q.add("pos", p.getAsJsonObject().get("pos"));
							q.add("block", p.getAsJsonObject().get("block"));
							pc.add(q);
						});
						wb.data("pkey", key + "/" + id).data("pcells", pc); // (slice T4R-D, I2)
					}
					w = c.plan(t, wb).i();
				} catch (Sites.SiteException e) {
					return "the restore of " + id + " can't be read: " + e.getMessage();
				}
			}
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(id));
			for (Effect.Builder b : CrateSettle.planInto(level, st, w, id, new LinkedHashSet<>())) {
				c.plan(t, b);
			}
			if (w >= 0 && st.get("player") instanceof JsonArray pl && !pl.isEmpty()) {
				for (Effect.Builder b : OwnerRemovals.playerOwes(key, id, st.get("dim").getAsString(), w, pl)) {
					c.plan(t, b); // (slice T4R-D, D1b) its player blocks owed, once, from its W's receipts
				}
			}
			c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(id));
		}
		if (r.crateSettle != null) {
			ServerLevel cl = Sites.levelOf(server, r.crateSettle.get("dim").getAsString());
			if (cl != null) {
				String cm = crateMember(r.group);
				for (Effect.Builder b : CrateSettle.planInto(cl, r.crateSettle, -1, cm, new LinkedHashSet<>())) {
					c.plan(t, b);
				}
				c.plan(t, Effect.of(TxnCore.BARRIER, EffectClass.R).member(cm));
			}
		}
		c.plan(t, Effect.of(RemovalTxn.SNAPSHOT, EffectClass.R).data("owner", key)); // (slice T4R-D, D5) one aggregate snapshot
		c.plan(t, Effect.of(RemovalTxn.GROUP_DONE, EffectClass.R).data("group", r.group));
		c.payload(t, "removal_finished", payload(r));
		dev.larattalabs.architect.site.DurableFile.Outcome o = c.persist(t);
		if (o == dev.larattalabs.architect.site.DurableFile.Outcome.REFUSED) {
			return "txn.json refused its intent";
		}
		r.gtx = t;
		r.crateSettle = null; // planned in the txn now (its key there): never settled apart
		Architect.LOGGER.info("Removal of group {}{}: removal.group {} begun over {} paid member(s) (undo {})", r.group, r.stage == null ? "" : " stage "
			+ r.stage, t.id, order.size(), r.undo);
		return null;
	}

	/** (slice T4R-M) {@link RemovalAreas#overlapWhy} over every member of {@code r} (its writes go to each one's box). */
	static @Nullable String overlapWhy(Groups.Removal r) {
		java.util.Set<String> self = java.util.Set.of("group:" + r.group + (r.stage == null ? "" : "/" + r.stage));
		java.util.Set<String> ids = new java.util.LinkedHashSet<>(r.undoSites);
		ids.addAll(r.sites);
		for (String id : ids) {
			dev.larattalabs.architect.placement.Anchors.Bounds b = Groups.boxOf(id);
			String dim = Groups.dimensionOfMember(id);
			if (b != null && dim != null) {
				String why = RemovalAreas.overlapWhy(dim, List.of(b), self);
				if (why != null) {
					return id + ": " + why;
				}
			}
		}
		return null;
	}

	private static void resourcesOf(JsonObject st, Set<String> res) {
		if (CrateSettle.hasCrate(st)) {
			res.add(dev.larattalabs.architect.txn.CrateTxn.resource(st.get("dim").getAsString(), CrateSettle.posOf(st)));
		}
		if (st.has("pile") && Stockpiles.get(st.get("pile").getAsString()) != null) {
			res.add("pile:" + st.get("pile").getAsString());
		}
	}

	/** The event's immutable source, captured at planning: who, and the removal's counts (its credits come from the result at the end). */
	static JsonObject payload(Groups.Removal r) {
		JsonObject o = new JsonObject();
		String region = r.stage == null ? dev.larattalabs.architect.apiimpl.Views.regionOfGroupPublic(r.group) : null;
		o.addProperty("kind", region != null ? "region" : "group");
		o.addProperty("group", r.group);
		if (r.stage != null) {
			o.addProperty("stage", r.stage);
		}
		if (region != null) {
			o.addProperty("region", region);
		}
		if (r.revisionId != null) {
			o.addProperty("revisionId", r.revisionId);
			String rg = dev.larattalabs.architect.apiimpl.Views.regionOfGroupPublic(r.group);
			if (rg != null) {
				o.addProperty("revRegion", rg); // (slice T4R-D, Q8a) the revision undo's removalResult alias revision:<region>#<rid>
			}
		}
		o.addProperty("restored", r.restoredCells);
		o.addProperty("kept", r.keptCells);
		JsonObject h = new JsonObject();
		r.handedAll.forEach(h::addProperty);
		o.add("handed", h);
		JsonArray c = new JsonArray();
		r.cascaded.forEach(c::add);
		o.add("cascaded", c);
		Map<String, Integer> drops = new TreeMap<>();
		r.decItems.values().forEach(m -> m.forEach((k, v) -> drops.merge(k, v, Integer::sum)));
		o.add("drops", Builder.counts(drops));
		JsonArray ow = new JsonArray(); // (fix round, P1-6) its data cargo's owed keys (a separate removal.cargo txn's)
		Groups.cargoOwed(r).forEach(ow::add); // (slice T4R-L) an aborted cargo txn's keys left out
		o.add("owed", ow);
		return o;
	}

	/** Whether {@code member}'s effects in {@code r}'s txn are durable (its last member barrier passed), or it has none, or the txn retired. */
	static boolean memberDone(Groups.Removal r, String member) {
		if (r.gtxDone) {
			return true;
		}
		TxnEntry t = r.gtx;
		if (t == null) {
			return false;
		}
		if (TxnServer.core().get(t.id) == null) {
			// retired: done only when it committed (fix round, P1-1: never read a missing entry as settled)
			return TxnServer.core().cache().committed(t.key) != null;
		}
		int last = -1;
		for (Effect e : t.effects()) {
			if (member.equals(e.member())) {
				last = e.i();
			}
		}
		return last < 0 || t.durableThrough(last);
	}

	/** Whether {@code member} is planned in {@code r}'s txn (a paid member). */
	static boolean planned(Groups.Removal r, String member) {
		TxnEntry t = r.gtx;
		if (t == null) {
			return r.decSettle.containsKey(member);
		}
		for (Effect e : t.effects()) {
			if (member.equals(e.member())) {
				return true;
			}
		}
		return false;
	}

	/** Drives {@code r}'s txn as far as it can go now; why it is held for anything but waiting on the group's own writes, or null. */
	static @Nullable String drive(Groups.Removal r) {
		TxnEntry t = r.gtx;
		if (t == null) {
			return null;
		}
		if (TxnServer.core().get(t.id) == null) {
			if (TxnServer.core().cache().committed(t.key) == null) {
				// (fix round, P1-1) retired without a commit (it can't since its journal decision; kept as a guard): begun again
				r.gtx = null;
				return "its removal.group txn ended without its commit: begun again";
			}
			return null;
		}
		TxnServer.core().drive(t);
		String h = t.held();
		if (h == null || h.contains("waits for its group's") || h.contains("waits for its group")) {
			return null;
		}
		return h;
	}

	/** What the txn paid so far: its credited (L) amounts and its owed keys, from its effects. */
	static Map<String, Integer> credited(Groups.Removal r) {
		TxnEntry t = r.gtx;
		if (t == null) {
			return Map.of();
		}
		JsonObject res = TxnServer.core().get(t.id) == null && t.result() != null && t.result().has("refund") ? t.result() : dev.larattalabs.architect.txn
			.CrateTxn.resultNow(t);
		return dev.larattalabs.architect.txn.CrateTxn.itemsOf(res, "refund");
	}

	static List<String> owed(Groups.Removal r) {
		TxnEntry t = r.gtx;
		if (t == null) {
			return List.of();
		}
		List<String> out = new ArrayList<>();
		if (dev.larattalabs.architect.txn.CrateTxn.resultNow(t).get("owed") instanceof JsonArray a) {
			a.forEach(x -> out.add(x.getAsString()));
		}
		return out;
	}
}
