package dev.larattalabs.architect.site;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.Pt;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * (DR, docs/CONTRACT.md "Slice DR") The world-agnostic core of diagnose and repair: which cells the journal's committed operations own
 * (XR's one-owner rule: the top writer of the stack, a cell under a standing higher one is never checked), what each should hold, and
 * the per-cell classification. No vote: a cell is {@link Cell#LAGGING} only when it holds the owning operation's exact pre-op value
 * ({@link WorldJournal#holds}, StillOurs' equivalences), {@link Cell#FOREIGN} for anything else or a player's record. Reads the journal
 * through {@link WorldJournal#storeOrNull()} and the world through {@link Reader} (the level, or UMT's world), so the undo model tester
 * runs it too (P7). Never writes; {@link Repairs} writes through the journal's write path.
 */
final class RepairCore {
	private RepairCore() {
	}

	/** The world as diagnose reads it. {@code get} null: the cell's chunk is not read (UNREAD). */
	interface Reader {
		@Nullable BlockState get(long pos);

		@Nullable CompoundTag nbt(long pos);

		/** Whether a player's record (PT) is at the cell. */
		boolean pt(long pos);
	}

	enum Cell {
		OK, LAGGING, FOREIGN
	}

	/**
	 * One cell a committed operation owns: what it should hold ({@code expected}), its pre-op value ({@code pre}), whose it is, and the
	 * order key (commit time, then the layer: placements bottom-up, removals top-down). {@code pt}: a removal's restored player record.
	 */
	record Want(String dim, long pos, Value expected, Value pre, String site, String entry, boolean removal, long at, long layer, @Nullable Pt pt,
		int flags, List<Value> morePre) {
		Want(String dim, long pos, Value expected, Value pre, String site, String entry, boolean removal, long at, long layer, @Nullable Pt pt,
			int flags) {
			this(dim, pos, expected, pre, site, entry, removal, at, layer, pt, flags, List.of());
		}
	}

	/**
	 * The classification of one cell (§1): holding {@code expected} (StillOurs, a player's record winning over CU's equivalences) is OK;
	 * a player's record is FOREIGN; holding {@code pre} is LAGGING; anything else FOREIGN.
	 */
	static Cell classify(BlockState now, java.util.function.Supplier<@Nullable CompoundTag> nbt, boolean pt, Value expected, Value pre) {
		if (WorldJournal.holdsOurs(now, nbt, () -> pt, expected)) {
			return Cell.OK;
		}
		if (pt) {
			return Cell.FOREIGN;
		}
		return WorldJournal.holds(now, nbt, pre) ? Cell.LAGGING : Cell.FOREIGN;
	}

	/** {@link #classify} through a reader; null when the cell is not read. */
	static @Nullable Cell classify(Reader r, Want w) {
		BlockState now = r.get(w.pos());
		if (now == null) {
			return null;
		}
		Cell c = classify(now, () -> r.nbt(w.pos()), r.pt(w.pos()), w.expected(), w.pre());
		if (c == Cell.FOREIGN && !r.pt(w.pos())) {
			for (Value p : w.morePre()) {
				if (WorldJournal.holds(now, () -> r.nbt(w.pos()), p)) {
					return Cell.LAGGING; // (F7) a higher removal's placed block, lost with both removals' writes
				}
			}
		}
		return c;
	}

	/** Guard kinds whose cells are a survival site's (its crate, its scaffold): the builder's while it stands, never DR's placements. */
	static boolean survivalGuard(String kind) {
		return kind.equals(WorldJournal.CRATE) || kind.equals(WorldJournal.SCAFFOLD);
	}

	/**
	 * The cells an ACTIVE entry owns on top (XR), with their committed afters: the top of each stack (highest layer, ties by entry id:
	 * {@link WorldJournal#stack}'s order). A PLACING entry (its job writes it) and cells with no after or an unchanged one are skipped.
	 */
	static List<Want> placementWants(JournalStore js, JournalStore.Meta m) throws IOException {
		List<Want> out = new ArrayList<>();
		if (m.status() != Journal.Status.ACTIVE || survivalGuard(m.kind())) {
			return out;
		}
		int flags = m.policy() == Journal.Policy.BOX ? Sites.FLAGS : Sites.CELL_FLAGS;
		for (long key : m.sections()) {
			SectionCells sc = js.section(m.id(), key);
			if (sc == null) {
				continue;
			}
			Map<Integer, long[]> top = tops(js, m.dimension(), key, m.id());
			for (int k = 0; k < sc.size(); k++) {
				Value after = sc.after(k);
				if (after == null || WorldJournal.same(sc.before(k), after) && WorldJournal.same(after, sc.before(k))) {
					continue;
				}
				long[] t = top.get(sc.index(k));
				if (t != null && (t[0] > sc.layer(k) || t[0] == sc.layer(k) && t[1] > 0)) {
					continue; // a higher writer owns it (XR): never checked
				}
				out.add(new Want(m.dimension(), sc.pos(k), after, sc.before(k), m.site(), m.id(), false, m.createdAt(), sc.layer(k), null, flags));
			}
		}
		return out;
	}

	/**
	 * Per section index, the highest layer any OTHER active entry has there ({@code [layer, 1 if that entry's id sorts after self]}):
	 * self owns a cell when no other is above it.
	 */
	private static Map<Integer, long[]> tops(JournalStore js, String dim, long key, String self) throws IOException {
		Map<Integer, long[]> out = new HashMap<>();
		for (String id : js.inSection(dim, key)) {
			if (id.equals(self)) {
				continue;
			}
			JournalStore.Meta o = js.meta(id);
			if (o == null || !o.active()) {
				continue;
			}
			SectionCells sc = js.section(id, key);
			if (sc == null) {
				continue;
			}
			long after = id.compareTo(self) > 0 ? 1 : 0;
			for (int k = 0; k < sc.size(); k++) {
				long l = sc.layer(k);
				long[] t = out.get(sc.index(k));
				if (t == null || l > t[0] || l == t[0] && after > t[1]) {
					out.put(sc.index(k), new long[] {l, after});
				}
			}
		}
		return out;
	}

	/**
	 * The cells a committed removal (a pending record's undo {@code group}) owns: where no active entry stands on top, what the undo wrote
	 * (the group's lowest writer, F1's later write under it), with the placed after as the pre-op value. One want per cell (the highest
	 * undone cell's after is what the world showed before the undo). Cells with no after (a rolled-back PLACING) are skipped.
	 */
	static List<Want> removalWants(JournalStore js, String siteId, String group) throws IOException {
		// (DR-S) a survival site's scaffold (costs nothing, refunds nothing) and crate cells roll forward with it; a crate (or any container)
		// still holding items is never written over (Repairs: FOREIGN)
		List<JournalStore.Meta> undone = SiteJournal.undone(siteId, group);
		List<JournalStore.Meta> inGroup = new ArrayList<>(js.find(m -> group.equals(m.undoGroup())));
		inGroup.sort(Comparator.comparingLong(JournalStore.Meta::layer));
		Map<Long, Want> byPos = new LinkedHashMap<>();
		for (JournalStore.Meta m : undone) {
			int flags = m.kind().equals(WorldJournal.LEAVES) ? Sites.FLAGS | net.minecraft.world.level.block.Block.UPDATE_KNOWN_SHAPE
				: m.policy() == Journal.Policy.BOX ? Sites.FLAGS : Sites.CELL_FLAGS;
			for (long key : m.sections()) {
				SectionCells sc = js.section(m.id(), key);
				if (sc == null) {
					continue;
				}
				Map<Long, Value> wrote = new HashMap<>();
				for (JournalStore.Meta g : inGroup) {
					SectionCells gs = js.section(g.id(), key);
					if (gs != null) {
						gs.writtenMap().forEach(wrote::putIfAbsent);
					}
				}
				List<SectionCells> below = Sites.laterBelow(js, m, group, key);
				Map<Integer, List<Above>> higher = undoneAbove(js, m, key);
				for (int k = 0; k < sc.size(); k++) {
					long pos = sc.pos(k);
					Value after = sc.after(k);
					Value w = sc.written(k) != null ? sc.written(k) : wrote.get(pos);
					Value lw = Sites.laterWrite(below, sc.index(k), sc.layer(k));
					if (lw != null) {
						w = lw;
					}
					if (after == null || w == null || WorldJournal.same(after, w) && WorldJournal.same(w, after)) {
						continue;
					}
					if (SiteJournal.owned(m.dimension(), pos)) {
						continue; // a standing entry owns it on top: the hand-down's, never checked
					}
					Want prev = byPos.get(pos);
					if (prev != null && prev.layer() >= sc.layer(k)) {
						continue;
					}
					Pt pt = w.equals(sc.before(k)) ? sc.pt(k) : null;
					List<Value> more = new ArrayList<>();
					for (Above h : higher.getOrDefault(sc.index(k), List.of())) {
						if (h.layer() > sc.layer(k) && h.after() != null) {
							more.add(h.after());
						}
					}
					byPos.put(pos, new Want(m.dimension(), pos, w, after, siteId, m.id(), true, m.undoneAt(), sc.layer(k), pt, flags, List.copyOf(more)));
				}
			}
		}
		return new ArrayList<>(byPos.values());
	}

	/** (F7) A higher UNDONE entry's cell: its layer and its after. */
	private record Above(long layer, @Nullable Value after) {
	}

	/**
	 * (F7) Per section index, the cells of other UNDONE entries there. A cell under one of them showed that entry's after until its undo:
	 * when both removals' writes were lost, the world holds it.
	 */
	private static Map<Integer, List<Above>> undoneAbove(JournalStore js, JournalStore.Meta self, long key) throws IOException {
		Map<Integer, List<Above>> out = new HashMap<>();
		for (String id : js.inSection(self.dimension(), key)) {
			JournalStore.Meta o = js.meta(id);
			if (id.equals(self.id()) || o == null || o.status() != Journal.Status.UNDONE) {
				continue;
			}
			SectionCells sc = js.section(id, key);
			if (sc == null) {
				continue;
			}
			for (int k = 0; k < sc.size(); k++) {
				out.computeIfAbsent(sc.index(k), x -> new ArrayList<>()).add(new Above(sc.layer(k), sc.after(k)));
			}
		}
		return out;
	}

	/**
	 * Commit order (§2): by commit time; placements bottom-up (layer, then y), removals top-down (layer descending, then y ascending so a
	 * support is written before what stands on it).
	 */
	static void commitOrder(List<Want> wants) {
		wants.sort(Comparator.comparingLong(Want::at).thenComparingInt((Want w) -> w.removal() ? 1 : 0).thenComparingLong(w -> w.removal() ? -w
			.layer() : w.layer()).thenComparingInt(w -> Journal.y(w.pos())).thenComparingLong(Want::pos));
	}

	/**
	 * (§1, the auto-diagnose's bound) Whether an entry may lag the world's last completed save: committed (created or undone) at or after
	 * {@code savedAt}, or its site had a job running at that save (its writes straddle it: P3 and R2 commit before the job's writes).
	 */
	static boolean afterSave(JournalStore.Meta m, long savedAt, Set<String> jobsAtSave) {
		return m.createdAt() >= savedAt || m.status() == Journal.Status.UNDONE && m.undoneAt() >= savedAt || jobsAtSave.contains(m.site());
	}

	/**
	 * (UMT seam) Rolls {@code wants} forward on a world: each LAGGING cell, in commit order, written to its expected value through
	 * {@link SiteJournal#writeCells} (its flags, FluidRearm). Returns how many were written. The in-game repair adds the record, the
	 * player records and the settle around the same writes ({@link Repairs}).
	 */
	static int rollForward(Reader r, SiteJournal.CellTarget t, List<Want> wants) {
		List<Want> lag = new ArrayList<>();
		for (Want w : wants) {
			if (classify(r, w) == Cell.LAGGING) {
				lag.add(w);
			}
		}
		commitOrder(lag);
		for (Want w : lag) {
			SiteJournal.writeCells(t, List.of(new SiteJournal.CellWrite(w.pos(), w.expected(), w.flags())));
		}
		return lag.size();
	}

	/** A short block-state text ({@code oak_planks[axis=y]}). */
	static String text(@Nullable BlockState s) {
		if (s == null) {
			return "?";
		}
		String t = s.toString();
		int a = t.indexOf('{');
		int b = t.indexOf('}');
		String name = a >= 0 && b > a ? t.substring(a + 1, b) : t;
		String props = b >= 0 && b + 1 < t.length() ? t.substring(b + 1) : "";
		return name.replace("minecraft:", "") + props;
	}

	static String text(Value v) {
		return text(WorldJournal.state(v));
	}

	/**
	 * The plan id (§1): a hash of the scope, the journal's commit state over the read entries (the index counters, each entry's id,
	 * status and undo time) and each finding's cells as found. Any change since refuses the repair (REPAIR_STALE).
	 */
	static String planId(String scope, JournalStore.Index idx, Collection<JournalStore.Meta> read, List<String> findingLines) {
		StringBuilder sb = new StringBuilder(scope).append('\n').append(idx.nextId()).append(':').append(idx.nextLayer()).append('\n');
		read.stream().sorted(Comparator.comparing(JournalStore.Meta::id)).forEach(m -> sb.append(m.id()).append(' ').append(m.status()).append(' ')
			.append(m.undoneAt()).append('\n'));
		findingLines.forEach(l -> sb.append(l).append('\n'));
		try {
			byte[] h = MessageDigest.getInstance("SHA-256").digest(sb.toString().getBytes(StandardCharsets.UTF_8));
			StringBuilder hex = new StringBuilder();
			for (int i = 0; i < 4; i++) {
				hex.append(String.format(java.util.Locale.ROOT, "%02x", h[i]));
			}
			return hex.toString();
		} catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}
}
