package dev.larattalabs.architect.delta;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * The decisions of a delta apply to a placed site (docs/CONTRACT.md phase 5b "Delta apply to a placed site"), pure: the delta
 * set {@code Δ = {c : plan_b(c) != plan_a(c)}} (unwritten = the pre-site value), player edits ({@code KEEP} / {@code OVERWRITE}
 * / {@code REFUSE}, tested against the site's own top {@code after}), covered cells ({@code COVERED}), growth into other
 * sites' cells (overlap), and the {@code delta} entry's cells: {@code Δ'} plus the shape guards (face neighbours of
 * {@code Δ'} the site owns) plus the growth guards (the new restore box's cells the site has no cell in yet). Also the
 * history fold. The world layer ({@code site.SiteDeltas}) supplies the stacks and the world; the property tests supply a
 * model. Any thread.
 */
public final class DeltaPlanner {
	private DeltaPlanner() {
	}

	public enum Edits {
		KEEP,
		OVERWRITE,
		REFUSE
	}

	/** Who holds a position now: nobody (terrain), the site itself on top, or another site on top. */
	public enum Holder {
		NONE,
		SITE,
		OTHER
	}

	/** The journal side of the site, as the planner sees it. */
	public interface Stacks {
		/** Who is on top at {@code pos}. */
		Holder holder(long pos);

		/** Whether the site has any active non-guard cell at {@code pos} (on top or covered). */
		boolean siteHas(long pos);

		/** The site's top cell's {@code after} at a position it holds (null: unknown, a migrated entry). */
		@Nullable Value siteAfter(long pos);

		/** The site on top at a position another site holds (for COVERED / overlap reports). */
		@Nullable String topSite(long pos);
	}

	/** The world as it is now. */
	public interface Now {
		Value value(long pos);

		/** Whether the world at {@code pos} still holds {@code after} (StillOurs). */
		boolean holds(long pos, Value after);
	}

	/** A cell the player changed that a KEEP delta leaves as it is. */
	public record Kept(long pos, Value found, Value planned) {
	}

	/** {@code Δ} classified: written by b only (added), by a only (removed), by both (changed); the rest are terrain cells. */
	public record Set3(Map<Long, Value> delta, Map<Long, Value> from, int added, int removed, int changed) {
	}

	/**
	 * {@code Δ}: the positions where the two plans differ, with {@code plan_b}'s value (the pre-site value where b writes
	 * nothing) and {@code plan_a}'s. In a stable order (y, z, x).
	 */
	public static Set3 deltaSet(SitePlanner.Plan a, SitePlanner.Plan b, SitePlanner.World pre) {
		Set<Long> all = new HashSet<>(a.writes().keySet());
		all.addAll(b.writes().keySet());
		List<Long> sorted = new ArrayList<>(all);
		sortYzx(sorted);
		Map<Long, Value> to = new LinkedHashMap<>();
		Map<Long, Value> from = new LinkedHashMap<>();
		int added = 0;
		int removed = 0;
		int changed = 0;
		for (long p : sorted) {
			Value va = a.at(p, pre);
			Value vb = b.at(p, pre);
			if (!va.equals(vb)) {
				to.put(p, vb);
				from.put(p, va);
				boolean wa = a.writes().containsKey(p);
				boolean wb = b.writes().containsKey(p);
				if (wa && wb) {
					changed++;
				} else if (wb) {
					added++;
				} else {
					removed++;
				}
			}
		}
		return new Set3(to, from, added, removed, changed);
	}

	public static void sortYzx(List<Long> ps) {
		ps.sort((p, q) -> {
			int c = Integer.compare(Journal.y(p), Journal.y(q));
			if (c != 0) {
				return c;
			}
			c = Integer.compare(Journal.z(p), Journal.z(q));
			return c != 0 ? c : Integer.compare(Journal.x(p), Journal.x(q));
		});
	}

	/**
	 * What an apply does: {@code write} = {@code Δ'} (position -> value, in y, z, x order), the kept cells, the covered cells
	 * by covering site, the growth cells in other sites' cells by site, the player-edited cells (REFUSE), the entry's cells
	 * {@code Δ' ∪ shape guards ∪ growth guards}, and which of them are shape guards and growth guards.
	 */
	public record Outcome(Map<Long, Value> write, List<Kept> kept, Map<String, Integer> covered, Map<String, Integer> overlaps, List<Kept> edited,
		Set<Long> entryCells, Set<Long> shapeGuards, Set<Long> growth) {
		public boolean refusedForEdits(Edits mode) {
			return mode == Edits.REFUSE && !edited.isEmpty();
		}
	}

	private static final int[][] FACES = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};

	/**
	 * The apply of {@code delta} (from {@link #deltaSet}) to a site whose new restore box is {@code snapB}: player edits under
	 * {@code mode}, covered cells, growth, guards.
	 */
	public static Outcome outcome(Map<Long, Value> delta, Anchors.Bounds snapB, Stacks st, Now now, Edits mode) {
		Map<Long, Value> write = new LinkedHashMap<>();
		List<Kept> kept = new ArrayList<>();
		List<Kept> edited = new ArrayList<>();
		Map<String, Integer> covered = new TreeMap<>();
		Map<String, Integer> overlaps = new TreeMap<>();
		for (var e : delta.entrySet()) {
			long p = e.getKey();
			Holder h = st.holder(p);
			if (h == Holder.OTHER) {
				String top = st.topSite(p);
				if (st.siteHas(p)) {
					covered.merge(top == null ? "?" : top, 1, Integer::sum);
				} else {
					overlaps.merge(top == null ? "?" : top, 1, Integer::sum);
					write.put(p, e.getValue()); // growth onto another site: written only under LAYER (the caller decides)
				}
				continue;
			}
			if (h == Holder.SITE) {
				Value after = st.siteAfter(p);
				if (after != null && !now.holds(p, after)) {
					Kept k = new Kept(p, now.value(p), e.getValue());
					edited.add(k);
					if (mode == Edits.KEEP) {
						kept.add(k);
						continue;
					}
				}
			}
			write.put(p, e.getValue());
		}
		Set<Long> keptPos = new HashSet<>();
		for (Kept k : kept) {
			keptPos.add(k.pos());
		}
		Set<Long> shape = new LinkedHashSet<>();
		for (long p : write.keySet()) {
			int x = Journal.x(p);
			int y = Journal.y(p);
			int z = Journal.z(p);
			for (int[] f : FACES) {
				long q = Journal.pos(x + f[0], y + f[1], z + f[2]);
				// the site's own neighbours that are still its own (a kept cell or another player edit is never captured: the
				// entry's after there would make the player's block "ours" for the next delta)
				if (!write.containsKey(q) && !keptPos.contains(q) && st.siteHas(q) && st.holder(q) == Holder.SITE) {
					Value after = st.siteAfter(q);
					if (after == null || now.holds(q, after)) {
						shape.add(q);
					}
				}
			}
		}
		Set<Long> growth = new LinkedHashSet<>();
		for (int y = snapB.minY(); y <= snapB.maxY(); y++) {
			for (int z = snapB.minZ(); z <= snapB.maxZ(); z++) {
				for (int x = snapB.minX(); x <= snapB.maxX(); x++) {
					long p = Journal.pos(x, y, z);
					if (!st.siteHas(p)) {
						growth.add(p);
						if (!write.containsKey(p) && st.holder(p) == Holder.OTHER) {
							String top = st.topSite(p);
							overlaps.merge(top == null ? "?" : top, 1, Integer::sum);
						}
					}
				}
			}
		}
		// growth outside the new box (removed cells never grow; plan cells outside snapB do not exist) is still the site's
		for (long p : write.keySet()) {
			if (!st.siteHas(p)) {
				growth.add(p);
			}
		}
		Set<Long> cells = new LinkedHashSet<>(write.keySet());
		cells.addAll(shape);
		cells.addAll(growth);
		return new Outcome(write, kept, covered, overlaps, edited, cells, shape, growth);
	}

	// ------------------------------------------------------------------ the history fold

	/**
	 * Folds the oldest {@code delta} entry into the site's {@code base} entry (docs/CONTRACT.md phase 5b "History bound"):
	 * where the base has a cell its {@code before} stays and its {@code after} becomes the delta's; the delta's other cells
	 * (growth) move to the base keeping their layer ({@link Journal#transfer}). Returns the new base; the caller releases the
	 * delta. Pure.
	 */
	public static Entry fold(Entry base, Entry delta) {
		Map<Long, Cell> d = new HashMap<>();
		for (Cell c : delta.cells()) {
			d.put(c.pos(), c);
		}
		List<Cell> out = new ArrayList<>(base.cells().size() + d.size());
		Set<Long> has = new HashSet<>();
		for (Cell c : base.cells()) {
			has.add(c.pos());
			Cell dc = d.get(c.pos());
			out.add(dc == null ? c : new Cell(c.pos(), c.layer(), c.before(), dc.after()));
		}
		Set<Long> growth = new HashSet<>();
		for (Cell c : delta.cells()) {
			if (!has.contains(c.pos())) {
				growth.add(c.pos());
			}
		}
		Entry b2 = base.withCells(out);
		return Journal.transfer(delta, b2, growth).get(b2.id());
	}

	/** A value's block id (reports). */
	public static String name(Value v) {
		return v.name();
	}

	/** The air value (tests, reports). */
	public static Value air() {
		return WorldJournal.value(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState());
	}
}
