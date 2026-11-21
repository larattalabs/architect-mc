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

	/** One area: its dimension, box and whose it is (for the reason). */
	record Area(String dim, Anchors.Bounds box, String who, String site) {
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

	/** Every in-flight removal's area that holds or writes outside this build's admission: the legacy ones, the durable stashes, the begun groups. */
	static List<Area> heldAreas() {
		List<Area> out = legacyAreas();
		for (var e : CrateSettle.durableJson().entrySet()) {
			com.google.gson.JsonObject st = e.getValue().getAsJsonObject();
			if (st.get("box") instanceof com.google.gson.JsonArray b && b.size() == 6 && st.has("dim")) {
				out.add(new Area(st.get("dim").getAsString(), new Anchors.Bounds(b.get(0).getAsInt(), b.get(1).getAsInt(), b.get(2).getAsInt(), b.get(3)
					.getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), "the removal of " + e.getKey(), e.getKey()));
			}
		}
		for (Groups.Removal r : Groups.inFlight()) {
			if (!r.legacy && r.gtx != null) {
				groupAreas(r, "the removal of group " + r.group, out); // every member (paid or not): its writes go there
			}
		}
		return out;
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
		Area a = first(heldAreas(), dim, boxes, self);
		return a == null ? null : a.who() + " is still in progress over " + Anchors.str(a.box());
	}

	/** {@link #overlapWhy} against the pre-T4R removals in flight only (a new group's wait before it plans). Server thread. */
	public static @Nullable String legacyWhy(String dim, Collection<Anchors.Bounds> boxes, Set<String> self) {
		Area a = first(legacyAreas(), dim, boxes, self);
		return a == null ? null : a.who() + " is still in progress over " + Anchors.str(a.box());
	}
}
