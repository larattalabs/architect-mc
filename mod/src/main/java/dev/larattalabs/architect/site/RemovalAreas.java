package dev.larattalabs.architect.site;

import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * (slice T4R-M, the final check of eca131b6's P1-2 and Noah's coexistence rule) Where removals in flight stand, and the one admission rule
 * over them: <b>a removal never takes a hold over another in-flight removal's area</b>. A removal's holds (its durable stash's box, its
 * removal txn's {@code rbox} resources) are born in two places only: a single removal's or a standalone road's stash, saved before its
 * undo commits ({@code Sites.removeDetailed}, {@code InfraPlace.remove0}: refused, nothing changed, retryable), and a group's or stage's
 * {@code removal.group} txn ({@code GroupTxn.ensure}: it waits, holding nothing, retried). Both ask {@link #overlapWhy} first, on the server
 * thread in the same tick as the hold is made. So at any time the holds of different removals are disjoint and a held removal waits on
 * no other removal's hold: two removals can never hold each other (P1-2 by construction).
 * <p>
 * A removal a pre-T4R build left in flight ({@link #legacyWhy}: a legacy group removal's members, a pre-T4R road job with C29's credit, a
 * single removal's pending record whose J2 credit is still held) holds nothing and writes on main's path; a new removal touching its area
 * waits (a group, before it plans) or is refused (a single site or road) until it finishes, so the two paths never interleave there.
 */
public final class RemovalAreas {
	private RemovalAreas() {
	}

	/**
	 * One area: its dimension, box and whose it is (for the reason). (slice T4R-D, A7a) {@code busy}: what kind of answer it gives a NEW
	 * attempt it blocks (its blocking id, kind and owner), null for a generic one.
	 */
	record Area(String dim, Anchors.Bounds box, String who, String site, dev.larattalabs.architect.api.@Nullable Busy busy) {
		Area(String dim, Anchors.Bounds box, String who, String site) {
			this(dim, box, who, site, null);
		}

		/** The typed busy answer of this area (REMOVAL_IN_PROGRESS of its removal, unless it says otherwise). */
		dev.larattalabs.architect.api.Busy busyOrDefault() {
			if (busy != null) {
				return busy;
			}
			String id = site.startsWith("group:") ? site.substring(6) : site;
			String kind = site.startsWith("group:") ? id.contains("/") ? "stage" : "group" : Infras.get(id) != null || Infras.pending(id) != null ? "road" : "site";
			String owner = null;
			if (kind.equals("group") || kind.equals("stage")) {
				SiteGroupRec g = Sites.group(id.contains("/") ? id.substring(0, id.indexOf('/')) : id);
				owner = g == null ? null : g.owner();
			} else {
				Site x = Sites.get(id) != null ? Sites.get(id) : Sites.pendingRecord(id);
				owner = x == null ? null : x.owner();
			}
			return new dev.larattalabs.architect.api.Busy(dev.larattalabs.architect.api.Busy.Kind.REMOVAL_IN_PROGRESS, id, kind, owner);
		}
	}

	/** Pure: the first of {@code areas} in {@code dim} whose box meets one of {@code boxes} and whose site is not one of {@code self}, or null. */
	static @Nullable Area first(List<Area> areas, String dim, Collection<Anchors.Bounds> boxes, Set<String> self) {
		for (Area a : areas) {
			if (!a.dim().equals(dim) || self.contains(a.site())) {
				continue;
			}
			for (Anchors.Bounds b : boxes) {
				if (Anchors.intersects(a.box(), b)) {
					return a;
				}
			}
		}
		return null;
	}

	/** Whether any removal a pre-T4R build left in flight is still in flight (O(removals + jobs + piles)). Server thread. */
	static boolean anyLegacy() {
		return !legacyAreas().isEmpty();
	}

	/** The areas of the removals a pre-T4R build left in flight (they finish on main's path). Server thread. */
	static List<Area> legacyAreas() {
		List<Area> out = new ArrayList<>();
		for (Groups.Removal r : Groups.inFlight()) {
			if (r.legacy) {
				groupAreas(r, "the removal of group " + r.group + " (from before the update)", out);
			}
		}
		for (Placement.Job j : Placement.jobs()) {
			if (j instanceof RestoreJob rj && rj.legacy()) {
				Infra inf = Infras.get(rj.siteId) != null ? Infras.get(rj.siteId) : Infras.pending(rj.siteId);
				if (inf != null) {
					out.add(new Area(inf.dimension(), inf.box(), "the removal of " + rj.siteId + " (from before the update)", rj.siteId));
				}
			}
		}
		java.util.Set<String> held = new java.util.HashSet<>();
		for (Stockpiles.Pile p : Stockpiles.all()) {
			held.addAll(p.ledger().pendingKeys());
		}
		if (!held.isEmpty()) {
			for (Site s : Sites.pendingSites()) {
				Site.Pending pe = Sites.pendingOf(s.id());
				if (pe != null && pe.settle() == null && s.construction() != null && held.contains(Builder.creditKey(s))) {
					out.add(new Area(s.dimension(), s.restoreBox(), "the removal of " + s.id() + " (from before the update)", s.id()));
				}
			}
		}
		return out;
	}

	/**
	 * Every in-flight removal's area that holds or writes outside this build's admission: the legacy ones, the durable stashes, the begun groups
	 * (begun this session, or open in the txn core as loaded from disk: slice T4R-N).
	 */
	static List<Area> heldAreas() {
		return heldAreas(dev.larattalabs.architect.txn.TxnServer.core());
	}

	/** (TEST seam, slice T4R-N) {@link #heldAreas()} against {@code core} (the txn core whose loaded holds count). */
	static List<Area> heldAreas(dev.larattalabs.architect.txn.@Nullable TxnCore core) {
		return heldAreas(core, null);
	}

	/**
	 * {@link #heldAreas(dev.larattalabs.architect.txn.TxnCore)} with the FIFO tickets (slice T4R-D, §4.2 (f)): every waiting group's area that
	 * holds a ticket, or (for {@code behind}, a waiting group itself) only those ahead of it in the queue.
	 */
	static List<Area> heldAreas(dev.larattalabs.architect.txn.@Nullable TxnCore core, Groups.@Nullable Removal behind) {
		List<Area> out = legacyAreas();
		for (Groups.Removal t : Groups.tickets()) {
			if (t == behind) {
				break; // only the tickets ahead of it
			}
			String g = t.group + (t.stage == null ? "" : "/" + t.stage);
			SiteGroupRec rec = Sites.group(t.group);
			List<Area> mine = new ArrayList<>();
			groupAreas(t, "the removal of group " + g + " (waiting first)", mine);
			for (Area a : mine) {
				out.add(new Area(a.dim(), a.box(), a.who(), a.site(), new dev.larattalabs.architect.api.Busy(dev.larattalabs.architect.api.Busy.Kind.WAITING_BEHIND, g,
					t.stage == null ? "group" : "stage", rec == null ? null : rec.owner())));
			}
		}
		for (var e : CrateSettle.durableJson().entrySet()) {
			com.google.gson.JsonObject st = e.getValue().getAsJsonObject();
			if (st.get("box") instanceof com.google.gson.JsonArray b && b.size() == 6 && st.has("dim")) {
				out.add(new Area(st.get("dim").getAsString(), new Anchors.Bounds(b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3)
					.getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), "the removal of " + e.getKey(), e.getKey()));
			}
		}
		for (Groups.Removal r : Groups.inFlight()) {
			if (!r.legacy && (r.gtx != null || begun(r, core))) {
				groupAreas(r, "the removal of group " + r.group, out); // every member (paid or not): its writes go there
			}
		}
		coreHolds(core, out);
		OwnerRemovals.areas(out); // (slice T4R-D, §4.2 (a)) every owner record's footprint
		return out;
	}

	/**
	 * (slice T4R-N, the final check of f7607b13's P1-1) Whether {@code r}'s {@code removal.group} txn is open in {@code core}: begun before a
	 * restart and loaded with its holds, while {@code r.gtx} (transient) is still null until its entry reattaches.
	 */
	static boolean begun(Groups.Removal r, dev.larattalabs.architect.txn.@Nullable TxnCore core) {
		if (core == null || r.undo == null) {
			return false;
		}
		String key = GroupTxn.key(r.group, r.stage, r.undo);
		for (dev.larattalabs.architect.txn.TxnEntry t : core.open()) {
			if (key.equals(t.key)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * (slice T4R-N, P1-1) The removal boxes ({@code rbox:} resources) every open {@code removal.group} txn of {@code core} holds, as loaded from
	 * disk: admission sees them whatever order the queue's entries reattach in (a waiting removal saved ahead of a stalled holder never begins
	 * over the holder's box after a restart). Its own: the txn key's {@code group:<id>[/stage]}.
	 */
	static void coreHolds(dev.larattalabs.architect.txn.@Nullable TxnCore core, List<Area> out) {
		if (core == null) {
			return;
		}
		for (dev.larattalabs.architect.txn.TxnEntry t : core.open()) {
			if (!dev.larattalabs.architect.txn.RemovalTxn.GROUP.equals(t.kind) || t.key == null) {
				continue;
			}
			int at = t.key.lastIndexOf('@');
			String self = at < 0 ? t.key : t.key.substring(0, at);
			for (String res : t.resources) {
				Area a = rboxArea(res, "the removal of " + self.replace("group:", "group ").replace("/", " stage ") + " (txn " + t.id + ")", self);
				if (a != null) {
					out.add(a);
				}
			}
		}
	}

	/** {@code rbox:<dim>@x0,y0,z0:x1,y1,z1} as an area, or null (another resource, or malformed). Pure. */
	static @Nullable Area rboxArea(String res, String who, String site) {
		if (!res.startsWith("rbox:")) {
			return null;
		}
		int at = res.lastIndexOf('@');
		if (at < 5) {
			return null;
		}
		String[] ab = res.substring(at + 1).split(":");
		if (ab.length != 2) {
			return null;
		}
		String[] a = ab[0].split(","), b = ab[1].split(",");
		if (a.length != 3 || b.length != 3) {
			return null;
		}
		try {
			return new Area(res.substring(5, at), new Anchors.Bounds(Integer.parseInt(a[0]), Integer.parseInt(a[1]), Integer.parseInt(a[2]), Integer.parseInt(b[0]),
				Integer.parseInt(b[1]), Integer.parseInt(b[2])), who, site);
		} catch (NumberFormatException e) {
			return null;
		}
	}

	private static void groupAreas(Groups.Removal r, String who, List<Area> out) {
		java.util.Set<String> ids = new java.util.LinkedHashSet<>(r.undoSites);
		ids.addAll(r.sites);
		for (String id : ids) {
			Anchors.Bounds b = Groups.boxOf(id);
			String dim = Groups.dimensionOfMember(id);
			if (b != null && dim != null) {
				out.add(new Area(dim, b, who, "group:" + r.group + (r.stage == null ? "" : "/" + r.stage)));
			}
		}
	}

	/**
	 * Why a removal of {@code self} over {@code boxes} of {@code dim} may not take its hold now (another removal in flight holds or writes
	 * there), or null. Server thread.
	 */
	public static @Nullable String overlapWhy(String dim, Collection<Anchors.Bounds> boxes, Set<String> self) {
		return overlapWhy(dim, boxes, self, dev.larattalabs.architect.txn.TxnServer.core());
	}

	/** (TEST seam, slice T4R-N) {@link #overlapWhy(String, Collection, Set)} against {@code core}. */
	static @Nullable String overlapWhy(String dim, Collection<Anchors.Bounds> boxes, Set<String> self, dev.larattalabs.architect.txn.TxnCore core) {
		Area a = first(heldAreas(core), dim, boxes, self);
		return a == null ? null : a.who() + " is still in progress over " + Anchors.str(a.box());
	}

	/** (slice T4R-D, A7a) The first in-flight removal's area (tickets included) meeting {@code boxes}, or null. Server thread. */
	public static @Nullable Area overlapArea(String dim, Collection<Anchors.Bounds> boxes, Set<String> self) {
		return first(heldAreas(dev.larattalabs.architect.txn.TxnServer.core(), null), dim, boxes, self);
	}

	/** (slice T4R-D, A7a) {@link #overlapArea} as a typed SITE_BUSY refusal ("Not yet: ..."), or null when free. */
	public static Sites.@Nullable SiteException busyRefusal(String dim, Collection<Anchors.Bounds> boxes, Set<String> self, String what) {
		Area a = overlapArea(dim, boxes, self);
		return a == null ? null : new Sites.SiteException(dev.larattalabs.architect.api.Reason.SITE_BUSY, "Not yet: " + a.who() + " is still in progress over "
			+ Anchors.str(a.box()) + "; " + what + " again once it is done", a.busyOrDefault());
	}

	/** (slice T4R-D, §4.2 FIFO) A waiting group's admission: the first area ahead of it (tickets ahead included) meeting its members, or null. */
	static @Nullable Area admissionOf(Groups.Removal r) {
		Set<String> self = Set.of("group:" + r.group + (r.stage == null ? "" : "/" + r.stage));
		List<Area> held = heldAreas(dev.larattalabs.architect.txn.TxnServer.core(), r);
		java.util.Set<String> ids = new java.util.LinkedHashSet<>(r.undoSites);
		ids.addAll(r.sites);
		for (String id : ids) {
			Anchors.Bounds b = Groups.boxOf(id);
			String dim = Groups.dimensionOfMember(id);
			if (b != null && dim != null) {
				Area a = first(held, dim, List.of(b), self);
				if (a != null) {
					return a;
				}
			}
		}
		return null;
	}

	/**
	 * (slice T4R-D, §4.2 begin guard) Why a NEW txn of {@code kind} over {@code resources} may not begin: one of its cells ({@code crate:},
	 * {@code cell:}, {@code rbox:} resources) meets an owner record's footprint or a waiting ticket's area. Removal txns (their own admission)
	 * and a removal's cargo (a ticket holder's prerequisite) are exempt; ATTACHED, REPLAYED and recovery never reach it. Server thread.
	 */
	public static @Nullable String beginGuard(String kind, @Nullable String key, List<String> resources) {
		if (kind.startsWith("removal.") || kind.startsWith("owed.")) {
			return null;
		}
		List<Area> areas = new ArrayList<>();
		OwnerRemovals.areas(areas);
		for (Groups.Removal t : Groups.tickets()) {
			groupAreas(t, "the removal of group " + t.group + " (waiting first)", areas);
		}
		if (areas.isEmpty()) {
			return null;
		}
		for (String res : resources) {
			Area cell = resourceArea(res);
			if (cell == null) {
				continue;
			}
			Area a = first(areas, cell.dim(), List.of(cell.box()), Set.of());
			if (a != null) {
				return "SITE_BUSY " + a.busyOrDefault().token() + ": " + a.who() + " is in progress over " + Anchors.str(a.box());
			}
		}
		return null;
	}

	/** A cell resource ({@code crate:<dim>@x,y,z}, {@code cell:<dim>@x,y,z}) or a removal box as an area; null for any other. Pure. */
	static @Nullable Area resourceArea(String res) {
		if (res.startsWith("rbox:")) {
			return rboxArea(res, res, "");
		}
		int c = res.indexOf(':');
		int at = res.lastIndexOf('@');
		if (c < 0 || at < c || !(res.startsWith("crate:") || res.startsWith("cell:"))) {
			return null;
		}
		String[] p = res.substring(at + 1).split(",");
		if (p.length != 3) {
			return null;
		}
		try {
			int x = Integer.parseInt(p[0]), y = Integer.parseInt(p[1]), z = Integer.parseInt(p[2]);
			return new Area(res.substring(c + 1, at), new Anchors.Bounds(x, y, z, x, y, z), res, "");
		} catch (NumberFormatException e) {
			return null;
		}
	}

	/** {@link #overlapWhy} against the pre-T4R removals in flight only (a new group's wait before it plans). Server thread. */
	public static @Nullable String legacyWhy(String dim, Collection<Anchors.Bounds> boxes, Set<String> self) {
		Area a = first(legacyAreas(), dim, boxes, self);
		return a == null ? null : a.who() + " is still in progress over " + Anchors.str(a.box());
	}
}
