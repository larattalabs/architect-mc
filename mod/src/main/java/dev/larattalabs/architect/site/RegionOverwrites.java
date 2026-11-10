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

	/** A writer's kind. */
	enum Kind {
		TARGET, ROAD, LOT
	}

	/** One writer of a region: its run, its free cells (a lot's finishes placed free), its main entry's cells and layer. */
	record Writer(String id, Kind kind, long layer, Builder.Run run, @Nullable BitSet free, Map<Long, BlockState[]> entry) {
		/** Whether queue cell {@code q} was paid for (a held target cell, a free road path or a lot's free finish cost nothing). */
		boolean paid(int q) {
			return !run.cost.get(q).isEmpty() && (free == null || !free.get(q));
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
			for (int q = 0; q < v.run().size(); q++) {
				if (!v.paid(q)) {
					continue;
				}
				BlockPos p = v.run().pos(q);
				long pk = p.asLong();
				for (int wi = vi + 1; wi < ws.size(); wi++) {
					Writer w = ws.get(wi);
					BlockState[] ba = w.entry().get(pk);
					if (ba == null || ba[1] == null || ba[0].is(ba[1].getBlock())) {
						continue;
					}
					int wq = w.run().queuePos(p);
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
			x.addProperty("cells", w.run().size());
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
