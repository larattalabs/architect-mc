package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (XR, docs/CONTRACT.md "Slice XR") A survival region's writers and the cells one writes over another's paid cell. A survival region has
 * three kinds of writer, each fed from the owner's stockpile: its tiles' targets ({@link RegionTargets}), its 4e roads (construction roads,
 * {@link RoadBuilder}) and its lots (construction sites, {@link Builder}). Dev and gate only: {@link #json} lists every cell queued paid by
 * one writer that another writer's journal entry changed (what that writer found there at its put-down, what it planned), so a gate can
 * see which overwrite rows a fixture reaches. Server thread.
 */
public final class RegionOverwrites {
	private RegionOverwrites() {
	}

	// ------------------------------------------------------------------ the owner of a cell (the pure seam)

	/**
	 * (XR) One writer's claim on a cell: its put-down order ({@code placedAt}, then its id), whether its cell there was paid (a held target
	 * cell, a road's free path and a lot's free finish were not), whether its run matches the block standing (or the block a write takes
	 * up), and whether it writes the cell (a road's and a lot's queued cells always do; a target's when what it found at its put-down was
	 * another block: a target that found its own block there, in another state, is built by matching and writes nothing).
	 */
	record Claim(String id, long order, boolean paid, boolean matches, boolean writes) {
	}

	/**
	 * (XR) The claim that owns what stands at a cell: the latest put down that matches it and writes the cell; when none writes, the latest
	 * that matches; -1 when none matches. An earlier writer whose block a later one rewrote with the same block (an A-B-A chain, a lot that
	 * clears and rebuilds a target's block) matches too but owns nothing: its block was given back when it was taken up. A later target
	 * that matches without writing (the same block in another state) owns nothing either: the block is its writer's. Exactly one writer
	 * counts the block as paid standing, refunds it at the removal, or is given it back when it is taken up.
	 */
	static int owner(List<Claim> cs) {
		int best = -1;
		for (int pass = 0; pass < 2 && best < 0; pass++) {
			for (int i = 0; i < cs.size(); i++) {
				Claim c = cs.get(i);
				if (c.matches() && (pass == 1 || c.writes()) && (best < 0 || later(c, cs.get(best)))) {
					best = i;
				}
			}
		}
		return best;
	}

	static boolean later(Claim a, Claim b) {
		return a.order() != b.order() ? a.order() > b.order() : a.id().compareTo(b.id()) > 0;
	}

	/** (XR) The claim a write over the cell takes up and gives back: the owner of the block there when its cell was paid, else -1. */
	static int taken(List<Claim> cs) {
		int o = owner(cs);
		return o >= 0 && cs.get(o).paid() ? o : -1;
	}

	/** (XR) Whether {@code self} is shadowed at a cell: another claim there owns what stands (self neither counts nor refunds it). */
	static boolean shadowed(Claim self, List<Claim> others) {
		List<Claim> all = new ArrayList<>(others);
		all.add(self);
		int o = owner(all);
		return o >= 0 && o != all.size() - 1;
	}

	// ------------------------------------------------------------------ the region's writers, live

	/** (XR) A region writer this tick: its id, put-down order, run, a lot's free cells, and a target's before (what it found). */
	record Live(String id, long order, Builder.Run run, @Nullable BitSet free, @Nullable Cells found) {
		Live(String id, long order, Builder.Run run, @Nullable BitSet free) {
			this(id, order, run, free, null);
		}

		boolean paid(int q) {
			return !run.cost.get(q).isEmpty() && (free == null || !free.get(q));
		}

		boolean writes(int q) {
			int k = run.queue[q];
			return found == null || k < 0 || k >= found.size() || !found.states[k].is(run.target[q].getBlock());
		}

		Claim claim(int q, BlockState st) {
			return new Claim(id, order, paid(q), run.matches(st, q), writes(q));
		}
	}

	/** (XR) Whether a group is a region's (its record carries the region): only a region's writers give back or shadow each other. */
	static boolean regionGroup(@Nullable String groupId) {
		SiteGroupRec g = groupId == null ? null : Sites.group(groupId);
		return g != null && g.ext().has(RegionItems.EXT_REGION);
	}

	/** (XR) A region group's writers with a run (targets, construction roads, lots), less {@code self}. Empty outside a region's group. */
	static List<Live> lives(MinecraftServer srv, @Nullable String groupId, @Nullable String self) {
		List<Live> out = new ArrayList<>();
		if (!regionGroup(groupId)) {
			return out;
		}
		for (Infra i : Infras.all()) {
			if (!groupId.equals(i.group()) || i.id().equals(self) || i.construction() == null || i.placing() || !(RegionTargets.is(i) || i.road())) {
				continue;
			}
			Builder.Run r = RoadBuilder.run(srv, i);
			RegionTargets.Plan pl = r == null || !RegionTargets.is(i) ? null : RegionTargets.planOf(srv, i);
			if (r != null) {
				out.add(new Live(i.id(), i.placedAt(), r, null, pl == null ? null : RegionTargets.beforeOf(i, pl)));
			}
		}
		for (Site s : Sites.all()) {
			if (!groupId.equals(s.group()) || s.id().equals(self) || s.construction() == null || s.placing()) {
				continue;
			}
			Builder.Run r = Builder.run(srv, s);
			if (r != null) {
				out.add(new Live(s.id(), s.placedAt(), r, s.construction().free()));
			}
		}
		return out;
	}

	/** (XR) The writers among {@code ls} whose run queues {@code p}, and their claims on {@code st} (parallel lists). */
	static List<Claim> claims(List<Live> ls, BlockPos p, BlockState st, @Nullable List<Live> who, @Nullable List<Integer> qs) {
		List<Claim> out = new ArrayList<>();
		for (Live l : ls) {
			int q = l.run().queuePos(p);
			if (q < 0) {
				continue;
			}
			out.add(l.claim(q, st));
			if (who != null) {
				who.add(l);
			}
			if (qs != null) {
				qs.add(q);
			}
		}
		return out;
	}

	/**
	 * (XL, XR) A region writer takes up {@code was} at {@code p} (writes over it, cuts it, or clears it to rebuild it): when another writer
	 * of its region owns that block and paid for it, its items go back to the stockpile as a swap's old block does ({@code giveBack}:
	 * credited, any overflow dropped at {@code dropAt}), at the moment it is taken up. Returns the items given back (empty when none).
	 */
	static Map<String, Integer> retake(List<Live> ls, BlockPos p, BlockState was, java.util.function.BiConsumer<Map<String, Integer>, BlockPos> giveBack,
		BlockPos dropAt, String by) {
		if (was.isAir() || ls.isEmpty()) {
			return Map.of();
		}
		List<Live> who = new ArrayList<>();
		List<Integer> qs = new ArrayList<>();
		List<Claim> cs = claims(ls, p, was, who, qs);
		int t = taken(cs);
		if (t < 0) {
			return Map.of();
		}
		Live o = who.get(t);
		Map<String, Integer> items = new TreeMap<>();
		o.run().refundCost(was, qs.get(t)).forEach(c -> items.merge(c.item(), c.count(), Integer::sum));
		if (items.isEmpty()) {
			return items;
		}
		if (Builder.TRACE_REFUNDS) {
			dev.larattalabs.architect.Architect.LOGGER.info("refund-trace retake {} over {} {} {}", by, o.id(), p.toShortString(), was);
		}
		giveBack.accept(items, dropAt);
		items.forEach((k, v) -> RegionTargets.RETAKEN.computeIfAbsent(o.id(), x -> new java.util.concurrent.ConcurrentHashMap<>()).merge(k, v, Integer::sum));
		return items;
	}

	/** (XR) {@link #retake} into the owner's stockpile ({@code owner}'s, in its dimension): a put-down's take-up (a road's cut, a lot's clear). */
	static Map<String, Integer> retakeToPile(MinecraftServer srv, List<Live> ls, @Nullable String owner, String dimension, BlockPos p, BlockState was,
		BlockPos dropAt, String by) {
		Stockpiles.Pile pile = Stockpiles.get(owner);
		if (pile == null || !pile.dimension.equals(dimension)) {
			return Map.of();
		}
		return retake(ls, p, was, (items, at) -> Stockpiles.giveBack(srv, pile, items, at), dropAt, by);
	}

	/**
	 * (XR) The cells of writer {@code id}'s queue that another writer of its region owns ({@link #owner}): {@code id} neither
	 * counts them as paid standing nor refunds them at its removal. Empty outside a region's group. Reads loaded chunks only unless
	 * {@code load}.
	 */
	static it.unimi.dsi.fastutil.longs.LongOpenHashSet shadowedCells(MinecraftServer srv, ServerLevel level, @Nullable String groupId, String id, long order,
		Builder.Run r, boolean load) {
		it.unimi.dsi.fastutil.longs.LongOpenHashSet out = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		List<Live> ls = lives(srv, groupId, id);
		if (ls.isEmpty()) {
			return out;
		}
		Live self = null;
		for (Infra i : Infras.all()) {
			if (i.id().equals(id)) {
				RegionTargets.Plan pl = RegionTargets.is(i) ? RegionTargets.planOf(srv, i) : null;
				self = new Live(id, order, r, null, pl == null ? null : RegionTargets.beforeOf(i, pl));
			}
		}
		if (self == null) {
			Site s = Sites.get(id);
			self = new Live(id, order, r, s == null || s.construction() == null ? null : s.construction().free());
		}
		for (int q = 0; q < r.size(); q++) {
			BlockPos p = r.pos(q);
			boolean any = false;
			for (Live l : ls) {
				if (l.run().box.contains(p.getX(), p.getY(), p.getZ()) && l.run().queuePos(p) >= 0) {
					any = true;
					break;
				}
			}
			if (!any) {
				continue;
			}
			BlockState now = load ? level.getBlockState(p) : Builder.stateIfLoaded(level, p);
			if (now != null && shadowed(self.claim(q, now), claims(ls, p, now, null, null))) {
				out.add(p.asLong());
			}
		}
		return out;
	}

	/**
	 * (XR) A survival region's lot just placed (its instant placement written and committed, its queued cells about to be cleared to air
	 * and rebuilt from the stockpile): every block it takes up, a queued cell's before (cleared, even when the lot rebuilds the same block)
	 * or a cell its placement changed (written over, or cleared for good), that another writer of the region owns and paid for goes back
	 * to the owner's stockpile now. Nothing outside a region's group.
	 */
	static void lotTakeUp(MinecraftServer srv, ServerLevel level, String siteId, @Nullable String group, @Nullable String owner, String dimension,
		Construction c, dev.larattalabs.architect.placement.Anchors.Bounds box) {
		List<Live> ls = lives(srv, group, siteId);
		JournalStore.Meta m = ls.isEmpty() ? null : SiteJournal.main(siteId);
		if (m == null) {
			return;
		}
		int dx = box.maxX() - box.minX() + 1;
		int dz = box.maxZ() - box.minZ() + 1;
		it.unimi.dsi.fastutil.longs.LongOpenHashSet queued = new it.unimi.dsi.fastutil.longs.LongOpenHashSet();
		for (int k : c.queue()) {
			int[] o = Construction.offsets(k, dx, dz);
			queued.add(BlockPos.asLong(box.minX() + o[0], box.minY() + o[1], box.minZ() + o[2]));
		}
		BlockPos at = new BlockPos((box.minX() + box.maxX()) / 2, box.maxY() + 1, (box.minZ() + box.maxZ()) / 2);
		for (var e : entry(m).entrySet()) {
			BlockState was = e.getValue()[0], after = e.getValue()[1];
			if (was.isAir() || !queued.contains(e.getKey()) && after != null && was.is(after.getBlock())) {
				continue;
			}
			retakeToPile(srv, ls, owner, dimension, BlockPos.of(e.getKey()), was, at, siteId);
		}
	}

	/** A writer's kind. */
	enum Kind {
		TARGET, ROAD, LOT, FREE
	}

	/** One writer of a region: its run, its free cells (a lot's finishes placed free), its main entry's cells and layer. */
	record Writer(String id, Kind kind, long layer, Builder.@Nullable Run run, @Nullable BitSet free, Map<Long, BlockState[]> entry) {
		/** Whether queue cell {@code q} was paid for (a held target cell, a free road path or a lot's free finish cost nothing). */
		boolean paid(int q) {
			return run != null && !run.cost.get(q).isEmpty() && (free == null || !free.get(q));
		}

		int queuePos(BlockPos p) {
			return run == null ? -1 : run.queuePos(p);
		}

		int size() {
			return run == null ? 0 : run.size();
		}
	}

	/** Every writer of a region's group with a run, in put-down order (its main journal entry's layer). */
	static List<Writer> writers(MinecraftServer srv, String groupId) {
		List<Writer> out = new ArrayList<>();
		for (Infra i : Infras.all()) {
			if (!groupId.equals(i.group()) || i.construction() == null || i.placing()) {
				continue;
			}
			Kind k = RegionTargets.is(i) ? Kind.TARGET : i.road() ? Kind.ROAD : null;
			Builder.Run r = k == null ? null : RoadBuilder.run(srv, i);
			JournalStore.Meta m = SiteJournal.main(i.id());
			if (r != null && m != null) {
				out.add(new Writer(i.id(), k, m.layer(), r, null, entry(m)));
			}
		}
		// a tile's free pass: a cell site of the group written at its put-down (no construction, nothing paid)
		for (Infra i : Infras.all()) {
			if (!groupId.equals(i.group()) || i.construction() != null || i.placing() || i.road()) {
				continue;
			}
			JournalStore.Meta m = SiteJournal.main(i.id());
			if (m != null) {
				out.add(new Writer(i.id(), Kind.FREE, m.layer(), null, null, entry(m)));
			}
		}
		for (Site s : Sites.all()) {
			if (!groupId.equals(s.group()) || s.construction() == null || s.placing()) {
				continue;
			}
			Builder.Run r = Builder.run(srv, s);
			JournalStore.Meta m = SiteJournal.main(s.id());
			if (r != null && m != null) {
				out.add(new Writer(s.id(), Kind.LOT, m.layer(), r, s.construction().free(), entry(m)));
			}
		}
		out.sort(java.util.Comparator.comparingLong(Writer::layer));
		return out;
	}

	/** An entry's recorded cells: position to {before, after} (after null when the entry has none). */
	static Map<Long, BlockState[]> entry(JournalStore.Meta m) {
		Map<Long, BlockState[]> out = new HashMap<>();
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return out;
		}
		try {
			for (long k : m.sections()) {
				SectionCells sc = s.section(m.id(), k);
				if (sc == null) {
					continue;
				}
				for (int i = 0; i < sc.size(); i++) {
					var a = sc.after(i);
					out.put(sc.pos(i), new BlockState[] {WorldJournal.state(sc.before(i)), a == null ? null : WorldJournal.state(a)});
				}
			}
		} catch (IOException e) {
			return out;
		}
		return out;
	}

	/**
	 * Dev ({@code dev.rs.overwrites}): every paid queue cell of a region writer that a later writer's entry changed (its before is not its
	 * after by block), as {victim, writer, kinds, the victim's block, what the writer found and planned, whether it queues the cell, the
	 * world now}, and the counts per writer kind over victim kind, plus the cells three or more writers changed.
	 */
	public static JsonObject json(MinecraftServer srv, String groupId, @Nullable ServerLevel level) {
		List<Writer> ws = writers(srv, groupId);
		JsonObject o = new JsonObject();
		JsonArray rows = new JsonArray();
		Map<String, Integer> counts = new TreeMap<>();
		Map<Long, Integer> changedBy = new HashMap<>();
		for (Writer w : ws) {
			for (var e : w.entry().entrySet()) {
				BlockState[] ba = e.getValue();
				if (ba[1] != null && !ba[0].is(ba[1].getBlock())) {
					changedBy.merge(e.getKey(), 1, Integer::sum);
				}
			}
		}
		for (int vi = 0; vi < ws.size(); vi++) {
			Writer v = ws.get(vi);
			for (int q = 0; q < v.size(); q++) {
				if (!v.paid(q)) {
					continue;
				}
				BlockPos p = v.run().pos(q);
				long pk = p.asLong();
				for (int wi = vi + 1; wi < ws.size(); wi++) {
					Writer w = ws.get(wi);
					BlockState[] ba = w.entry().get(pk);
					int wq = w.queuePos(p);
					// a lot clears and rebuilds every queued cell, its own block or not
					if (ba == null || ba[1] == null || ba[0].is(ba[1].getBlock()) && !(w.kind() == Kind.LOT && wq >= 0)) {
						continue;
					}
					JsonObject r = new JsonObject();
					r.add("pos", pos(p));
					r.addProperty("victim", v.id());
					r.addProperty("victimKind", v.kind().name());
					r.addProperty("victimBlock", v.run().target[q].toString());
					Map<String, Integer> vi2 = new TreeMap<>();
					v.run().cost.get(q).forEach(x -> vi2.merge(x.item(), x.count(), Integer::sum));
					r.add("victimItems", Builder.counts(vi2));
					r.addProperty("writer", w.id());
					r.addProperty("writerKind", w.kind().name());
					r.addProperty("found", ba[0].toString());
					r.addProperty("planned", ba[1].toString());
					r.addProperty("foundVictims", ba[0].is(v.run().target[q].getBlock()));
					r.addProperty("queued", wq >= 0);
					r.addProperty("writerPaid", wq >= 0 && w.paid(wq));
					if (level != null) {
						BlockState now = Builder.stateIfLoaded(level, p);
						r.addProperty("now", now == null ? "unloaded" : now.toString());
					}
					rows.add(r);
					counts.merge(w.kind().name() + " over " + v.kind().name() + (ba[0].is(v.run().target[q].getBlock()) ? "" : " (found another block)"), 1, Integer::sum);
				}
			}
		}
		int multi = 0;
		for (int n : changedBy.values()) {
			if (n >= 3) {
				multi++;
			}
		}
		o.add("rows", rows);
		o.add("counts", Builder.counts(counts));
		o.addProperty("cellsChangedBy3OrMore", multi);
		JsonArray wj = new JsonArray();
		for (Writer w : ws) {
			JsonObject x = new JsonObject();
			x.addProperty("id", w.id());
			x.addProperty("kind", w.kind().name());
			x.addProperty("layer", w.layer());
			x.addProperty("cells", w.size());
			wj.add(x);
		}
		o.add("writers", wj);
		return o;
	}

	private static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}
}
