package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.ChangeTracker;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalNbt;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.SectionCells;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.LeafGuard;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.function.LongPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.TagValueInput;
import org.jspecify.annotations.Nullable;

/**
 * Architect's sites on the world journal (docs/CONTRACT.md "Phase 4e contract", "Placement and removal on the journal"):
 * the entries a site places (P1-P3: its {@code site} BOX entry over the restore box and its held {@code leaves}; P6-P7: the
 * {@code after} capture), the per-cell overlap test, and a site's undo (R1-R2: one plan and one commit; R4: the writes,
 * through the 4d restore path). The write paths themselves stay in {@link Sites}, {@link PlaceJob}, {@link RestoreJob} and
 * {@link Builder}; this class only decides where the {@code before} comes from and which undo is written. Server thread.
 */
public final class SiteJournal {
	/** A capture up to this many cells is taken in one tick (every kit building). */
	static final int ONE_TICK_CELLS = 50_000;
	/** Active non-guard entries per cell, at most. */
	public static final int MAX_DEPTH = 8;
	/** A single Place outside the queue commits synchronously up to this many cells. */
	static final int SYNC_CELLS = 100_000;

	private SiteJournal() {
	}

	static JournalStore store() throws Sites.SiteException {
		try {
			return WorldJournal.store();
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
		}
	}

	private static JournalStore store0() {
		return java.util.Objects.requireNonNull(WorldJournal.storeOrNull(), "journal");
	}

	/** Why the journal refuses world changes now, or null. */
	static @Nullable String unavailable() {
		return WorldJournal.unavailable();
	}

	static void requireAvailable() throws Sites.SiteException {
		String why = unavailable();
		if (why != null) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, why);
		}
	}

	// ------------------------------------------------------------------ reads

	/** Every entry of a site (any status), in creation order. Any thread. */
	public static List<JournalStore.Meta> entries(String siteId) {
		JournalStore s = WorldJournal.storeOrNull();
		return s == null ? List.of() : s.find(m -> m.site().equals(siteId));
	}

	/** The site's entries in its undo group now: active (ACTIVE or PLACING) ones. */
	static List<JournalStore.Meta> active(String siteId) {
		return entries(siteId).stream().filter(JournalStore.Meta::active).toList();
	}

	/** The site's main entry (its {@code site}, road or cell-site entry) that is active, or null. */
	static JournalStore.@Nullable Meta main(String siteId) {
		for (JournalStore.Meta m : active(siteId)) {
			if (!m.kind().equals(WorldJournal.LEAVES) && !m.kind().equals(WorldJournal.CRATE) && !m.kind().equals(WorldJournal.DELTA)) {
				return m;
			}
		}
		return null;
	}

	/** Whether the top non-guard entry at {@code pos} is {@code siteId}'s. */
	static boolean isOwnedBy(String dimension, long pos, String siteId) {
		try {
			List<WorldJournal.Layer> st = WorldJournal.stack(dimension, pos);
			for (int i = st.size() - 1; i >= 0; i--) {
				if (!st.get(i).meta().kind().equals(WorldJournal.LEAVES)) {
					return st.get(i).meta().site().equals(siteId);
				}
			}
		} catch (IOException e) {
			return false;
		}
		return false;
	}

	/** Whether {@code pos} is a cell of an active entry (owned by a standing site); guard kinds count. Server thread. */
	static boolean owned(String dimension, long pos) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return false;
		}
		long key = Sections.key(pos);
		int i = Sections.index(pos);
		for (String id : s.inSection(dimension, key)) {
			JournalStore.Meta m = s.meta(id);
			if (m == null || !m.active()) {
				continue;
			}
			try {
				SectionCells sc = s.section(id, key);
				if (sc != null && sc.has(i)) {
					return true;
				}
			} catch (IOException e) {
				return true;
			}
		}
		return false;
	}

	/** The site that owns {@code pos} (the top active entry's site there), or null. */
	static @Nullable String ownerSite(String dimension, long pos) {
		try {
			List<WorldJournal.Layer> st = WorldJournal.stack(dimension, pos);
			return st.isEmpty() ? null : st.get(st.size() - 1).meta().site();
		} catch (IOException e) {
			return null;
		}
	}

	// ------------------------------------------------------------------ overlap (per cell)

	/** An entry a box overlaps: its site and kind, the cells in the box, and the deepest stack among them. */
	public record Hit(String site, String entry, String kind, Policy policy, Status status, int cells, int depth) {
	}

	/**
	 * The active non-guard entries with cells in {@code box} (the predicted restore box), per entry, through the section map.
	 * Guard data (held leaves; the ring is no entry) never counts. {@code skipSite}: a site to leave out (the one moving).
	 */
	static List<Hit> overlaps(String dimension, Anchors.Bounds box, @Nullable String skipSite) throws Sites.SiteException {
		JournalStore s = store();
		Map<String, int[]> count = new LinkedHashMap<>();
		Map<Long, Integer> depth = new HashMap<>();
		for (long key : WorldJournal.sectionsOf(box)) {
			List<String> ids = s.inSection(dimension, key);
			if (ids.isEmpty()) {
				continue;
			}
			long[] boxMask = boxMask(box, key);
			for (String id : ids) {
				JournalStore.Meta m = s.meta(id);
				if (m == null || !m.active() || m.kind().equals(WorldJournal.LEAVES) || m.site().equals(skipSite)) {
					continue;
				}
				SectionCells sc;
				try {
					sc = s.section(id, key);
				} catch (IOException e) {
					throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "journal entry " + id + " can't be read: " + e.getMessage());
				}
				if (sc == null || !sc.intersects(boxMask)) {
					continue;
				}
				long[] mm = sc.mask();
				int n = 0;
				for (int w = 0; w < 64; w++) {
					long b = mm[w] & boxMask[w];
					n += Long.bitCount(b);
					while (b != 0) {
						int bit = Long.numberOfTrailingZeros(b);
						b &= b - 1;
						long p = Sections.pos(key, w * 64 + bit);
						depth.merge(p, 1, Integer::sum);
					}
				}
				count.computeIfAbsent(id, k -> new int[1])[0] += n;
			}
		}
		int deepest = 0;
		for (int d : depth.values()) {
			deepest = Math.max(deepest, d);
		}
		List<Hit> out = new ArrayList<>();
		for (var e : count.entrySet()) {
			JournalStore.Meta m = s.meta(e.getKey());
			out.add(new Hit(m.site(), m.id(), m.kind(), m.policy(), m.status(), e.getValue()[0], deepest));
		}
		return out;
	}

	/** The 4096-bit mask of {@code box} within section {@code key}. */
	static long[] boxMask(Anchors.Bounds box, long key) {
		long[] m = new long[64];
		int bx = Sections.sx(key) << 4;
		int by = Sections.sy(key) << 4;
		int bz = Sections.sz(key) << 4;
		int x0 = Math.max(box.minX(), bx) - bx;
		int x1 = Math.min(box.maxX(), bx + 15) - bx;
		int y0 = Math.max(box.minY(), by) - by;
		int y1 = Math.min(box.maxY(), by + 15) - by;
		int z0 = Math.max(box.minZ(), bz) - bz;
		int z1 = Math.min(box.maxZ(), bz + 15) - bz;
		for (int y = y0; y <= y1; y++) {
			for (int z = z0; z <= z1; z++) {
				for (int x = x0; x <= x1; x++) {
					int i = y << 8 | z << 4 | x;
					m[i >> 6] |= 1L << (i & 63);
				}
			}
		}
		return m;
	}

	// ------------------------------------------------------------------ placement: P1-P3, P6-P7

	/**
	 * A placement's journal side: its entries, the {@code before} capture, the PLACING commit (P3) and the change tracker
	 * that keeps the capture true until the first block is written.
	 */
	public static final class Placing {
		final String site;
		final String siteEntry;
		final @Nullable String leavesEntry;
		final Anchors.Bounds box;
		final WorldJournal.Captured before;
		final List<Integer> held;
		CompletableFuture<Void> commit;
		@Nullable ChangeTracker tracker;

		Placing(String site, String siteEntry, @Nullable String leavesEntry, Anchors.Bounds box, WorldJournal.Captured before, List<Integer> held,
			CompletableFuture<Void> commit, @Nullable ChangeTracker tracker) {
			this.site = site;
			this.siteEntry = siteEntry;
			this.leavesEntry = leavesEntry;
			this.box = box;
			this.before = before;
			this.held = held;
			this.commit = commit;
			this.tracker = tracker;
		}

		/** The entries this placement made (its site entry, its held leaves). */
		List<String> entries() {
			return leavesEntry == null ? List.of(siteEntry) : List.of(siteEntry, leavesEntry);
		}

		void stopTracking() {
			if (tracker != null) {
				tracker.stop();
				tracker = null;
			}
		}
	}

	/** The leaves a placement over {@code box} holds: natural leaves near it that may hang on it, not owned by a standing entry. */
	static List<Integer> holdable(ServerLevel level, Anchors.Bounds box) {
		String dim = Sites.dimensionId(level);
		return LeafGuard.holdable(level, box, p -> owned(dim, p.asLong()));
	}

	/**
	 * P1-P3 of a placement: captures {@code box} (one tick), records the held leaves as a {@code leaves} CELL entry, and submits
	 * the PLACING commit. {@code meta}: the site record (crash repair rebuilds a lost record from it); {@code ring}: the leaf ring.
	 * The caller waits for {@link Placing#commit} before writing any block.
	 */
	static Placing begin(ServerLevel level, String siteId, String kind, @Nullable String group, Anchors.Bounds box, List<Integer> held, JsonObject meta,
		int[] ring, WorldJournal.@Nullable Captured captured) throws Sites.SiteException {
		return begin(level, siteId, kind, group, box, held, new long[0], meta, ring, captured);
	}

	/**
	 * {@link #begin} with the outside halves of the tall plants the box cuts ({@code cut}): the placement writes air there, so
	 * they are guard cells of the {@code leaves} entry (written back before the box on removal, so the plant is whole again).
	 */
	static Placing begin(ServerLevel level, String siteId, String kind, @Nullable String group, Anchors.Bounds box, List<Integer> held, long[] cut,
		JsonObject meta, int[] ring, WorldJournal.@Nullable Captured captured) throws Sites.SiteException {
		requireAvailable();
		JournalStore s = store();
		WorldJournal.Captured before = captured != null ? captured : WorldJournal.capture(level, box);
		String dim = Sites.dimensionId(level);
		long layer = s.newLayer();
		String id = s.newId();
		long now = System.currentTimeMillis();
		JournalStore.Txn t = s.begin().label("P3:" + siteId);
		t.create(JournalStore.Meta.header(id, kind, siteId, group, dim, Policy.BOX, layer, Status.PLACING, now), WorldJournal.sections(before, null,
			layer, null), new JournalNbt.Head(meta, ring));
		String leaves = null;
		if (!held.isEmpty() || cut.length > 0) {
			leaves = s.newId();
			long ll = s.newLayer();
			List<Cell> guard = leafCells(level, held, ll);
			BlockPos.MutableBlockPos cp = new BlockPos.MutableBlockPos();
			for (long c : cut) {
				if (!box.contains(BlockPos.getX(c), BlockPos.getY(c), BlockPos.getZ(c))) {
					guard.add(new Cell(c, ll, WorldJournal.valueAt(level, cp.set(c)), Journal.AIR));
				}
			}
			t.create(JournalStore.Meta.header(leaves, WorldJournal.LEAVES, siteId, group, dim, Policy.CELL, ll, Status.PLACING, now),
				JournalStore.bySection(guard), JournalNbt.Head.EMPTY);
		}
		// the capture is the world at P1 (one tick, as 4d's snapshot); a sliced capture tracked its changes until here (PlaceJob)
		CompletableFuture<Void> f = s.submit(t);
		return new Placing(siteId, id, leaves, box, before, held, f, null);
	}

	/** The held leaves as journal cells: {@code before} the natural leaf (its distance as read), {@code after} the same leaf persistent. */
	static List<Cell> leafCells(ServerLevel level, List<Integer> held, long layer) {
		List<Cell> out = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int i = 0; i + 3 < held.size(); i += 4) {
			BlockState st = level.getBlockState(p.set(held.get(i), held.get(i + 1), held.get(i + 2)));
			if (!(st.getBlock() instanceof LeavesBlock)) {
				continue;
			}
			BlockState natural = st.setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, held.get(i + 3));
			out.add(new Cell(p.asLong(), layer, WorldJournal.value(natural), WorldJournal.value(natural.setValue(LeavesBlock.PERSISTENT, true))));
		}
		return out;
	}

	/** Waits for a commit (a synchronous placement or removal). */
	static void await(CompletableFuture<Void> f, String what) throws Sites.SiteException {
		try {
			f.get();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new Sites.SiteException(Reason.OTHER, "interrupted while saving " + what);
		} catch (ExecutionException e) {
			Throwable c = e.getCause() == null ? e : e.getCause();
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "Could not save " + what + " to the world journal (" + c.getMessage() + "); nothing "
				+ "was changed");
		}
	}

	/**
	 * Before the first block of a placement is written: positions that changed since the capture (change tracking) are
	 * captured again and committed. Returns the commit to wait for, or null when the capture is still true (tracking stops).
	 */
	static @Nullable CompletableFuture<Void> retake(ServerLevel level, Placing p) throws Sites.SiteException {
		ChangeTracker t = p.tracker;
		if (t == null || !t.dirty()) {
			p.stopTracking();
			return null;
		}
		long[] changed = t.drain();
		WorldJournal.recapture(level, p.before, changed);
		JournalStore s = store();
		JournalStore.Meta m = s.meta(p.siteEntry);
		if (m == null) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "the journal entry of " + p.site + " is gone");
		}
		Set<Long> keys = new TreeSet<>();
		for (long c : changed) {
			if (p.box.contains(Journal.x(c), Journal.y(c), Journal.z(c))) {
				keys.add(Sections.key(c));
			}
		}
		List<SectionCells> secs = new ArrayList<>();
		for (SectionCells sc : WorldJournal.sections(p.before, null, m.layer(), null)) {
			if (keys.contains(sc.key)) {
				secs.add(sc);
			}
		}
		if (secs.isEmpty()) {
			return null;
		}
		Architect.LOGGER.info("Placement of {}: {} cell(s) changed while its capture was saved; captured again", p.site, changed.length);
		CompletableFuture<Void> f = s.submit(s.begin().label("P3:" + p.site + "+retake").sections(p.siteEntry, secs));
		p.commit = f;
		return f;
	}

	/**
	 * P6-P7: the site entry gets its {@code after} from {@code after} (the box as the placement left it) and every PLACING entry
	 * of the site becomes ACTIVE, in one commit. {@code extra}: more to commit with it (a construction crate's entry).
	 */
	static CompletableFuture<Void> complete(String siteId, WorldJournal.Captured after, java.util.function.@Nullable Consumer<JournalStore.Txn> extra)
		throws Sites.SiteException {
		JournalStore s = store();
		JournalStore.Txn t = s.begin().label("P7:" + siteId);
		for (JournalStore.Meta m : active(siteId)) {
			if (m.status() != Status.PLACING) {
				continue;
			}
			if (m.kind().equals(WorldJournal.SITE)) {
				List<SectionCells> secs = new ArrayList<>();
				try {
					for (long k : m.sections()) {
						SectionCells sc = s.section(m.id(), k);
						if (sc != null) {
							secs.add(sc);
						}
					}
				} catch (IOException e) {
					throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, e.getMessage());
				}
				t.sections(m.id(), WorldJournal.withAfter(secs, after));
			}
			t.status(m.id(), Status.ACTIVE, null, 0L);
		}
		if (extra != null) {
			extra.accept(t);
		}
		return s.submit(t);
	}

	/** Replaces the head (site record) of a site's main entry: its meta follows record changes that matter for crash repair. */
	static void updateMeta(String siteId, JsonObject meta) {
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta m = main(siteId);
		if (s == null || m == null) {
			return;
		}
		try {
			JournalNbt.Head h = s.head(m.id());
			s.submit(s.begin().label("meta:" + siteId).head(m.id(), new JournalNbt.Head(meta, h.ring())));
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not update the journal record of {}", siteId, e);
		}
	}

	/** A new {@code crate} BOX entry for one cell (a construction crate), in the site's undo group, added to {@code t}. */
	static void crateEntry(JournalStore.Txn t, ServerLevel level, String siteId, @Nullable String group, BlockPos at, Value crate) throws Sites.SiteException {
		JournalStore s = store();
		String id = s.newId();
		long layer = s.newLayer();
		Value before = WorldJournal.valueAt(level, at);
		t.create(JournalStore.Meta.header(id, WorldJournal.CRATE, siteId, group, Sites.dimensionId(level), Policy.BOX, layer, Status.ACTIVE,
			System.currentTimeMillis()), JournalStore.bySection(List.of(new Cell(at.asLong(), layer, before, crate))), JournalNbt.Head.EMPTY);
	}

	/** Releases a site's entries of {@code kind} (a construction crate that went: its cell is the ground again). */
	static void releaseKind(String siteId, String kind) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return;
		}
		JournalStore.Txn t = s.begin().label("release:" + siteId + ":" + kind);
		for (JournalStore.Meta m : active(siteId)) {
			if (m.kind().equals(kind)) {
				t.release(m.id());
			}
		}
		if (!t.isEmpty()) {
			s.submit(t);
		}
	}

	/** Moves a site's active entries of {@code kind} to another site id (a shared crate that the group now owns). */
	static List<String> idsOf(String siteId, String kind) {
		return active(siteId).stream().filter(m -> m.kind().equals(kind)).map(JournalStore.Meta::id).toList();
	}

	/** Forgets a site: its entries are released (the blocks stay for good). */
	static CompletableFuture<Void> release(String siteId) throws Sites.SiteException {
		JournalStore s = store();
		JournalStore.Txn t = s.begin().label("forget:" + siteId);
		for (JournalStore.Meta m : entries(siteId)) {
			t.release(m.id());
		}
		return t.isEmpty() ? CompletableFuture.completedFuture(null) : s.submit(t);
	}

	/** Whether any active entry lies under a cell of this site (forget is refused then: the lower site's undo would wipe it). */
	static @Nullable String below(String siteId) {
		return relation(siteId, true);
	}

	/** A site with an active entry above any of its cells (it is covered), or null. */
	static @Nullable String above(String siteId) {
		return relation(siteId, false);
	}

	private static @Nullable String relation(String siteId, boolean below) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return null;
		}
		for (JournalStore.Meta m : active(siteId)) {
			for (long k : m.sections()) {
				try {
					List<String> others = s.inSection(m.dimension(), k);
					if (others.size() < 2) {
						continue;
					}
					SectionCells mine = s.section(m.id(), k);
					for (String o : others) {
						JournalStore.Meta om = s.meta(o);
						if (om == null || !om.active() || om.site().equals(siteId) || om.kind().equals(WorldJournal.LEAVES)) {
							continue;
						}
						SectionCells their = s.section(o, k);
						if (mine == null || their == null || !mine.intersects(their.mask())) {
							continue;
						}
						for (int a = 0; a < mine.size(); a++) {
							int j = their.find(mine.index(a));
							if (j >= 0 && (below ? their.layer(j) < mine.layer(a) : their.layer(j) > mine.layer(a))) {
								return om.site();
							}
						}
					}
				} catch (IOException e) {
					return null;
				}
			}
		}
		return null;
	}

	/** The sites covering any cell of this site (active entries above its cells). */
	public static List<String> coveringSites(String siteId) {
		return related(siteId, true);
	}

	/** The sites this site lies on top of (active entries below its cells). */
	public static List<String> coveredSites(String siteId) {
		return related(siteId, false);
	}

	/** The sites above ({@code above}) or below any cell of this site. Any thread (reads the journal's view). */
	public static List<String> related(String siteId, boolean above) {
		Set<String> out = new LinkedHashSet<>();
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return List.of();
		}
		for (JournalStore.Meta m : active(siteId)) {
			if (m.kind().equals(WorldJournal.LEAVES)) {
				continue;
			}
			for (long k : m.sections()) {
				try {
					SectionCells mine = s.section(m.id(), k);
					for (String o : s.inSection(m.dimension(), k)) {
						JournalStore.Meta om = s.meta(o);
						if (om == null || !om.active() || om.site().equals(siteId) || om.kind().equals(WorldJournal.LEAVES)) {
							continue;
						}
						SectionCells their = s.section(o, k);
						if (mine == null || their == null || !mine.intersects(their.mask())) {
							continue;
						}
						for (int a = 0; a < mine.size(); a++) {
							int j = their.find(mine.index(a));
							if (j >= 0 && (above ? their.layer(j) > mine.layer(a) : their.layer(j) < mine.layer(a))) {
								out.add(om.site());
								break;
							}
						}
					}
				} catch (IOException e) {
					// unreadable: not listed
				}
			}
		}
		return List.copyOf(out);
	}

	// ------------------------------------------------------------------ undo: R1-R2, R4

	/** An undo committed (or committing): its plan and the commit. */
	record Undone(WorldJournal.UndoWork work, CompletableFuture<Void> commit) {
	}

	/** A new undo group name. */
	static String group(String what) {
		return "u:" + what + ":" + System.currentTimeMillis();
	}

	/**
	 * R1-R2: plans undoing every active entry of {@code siteIds} together (one undo group) and submits the commit (the entries
	 * UNDONE with what the undo writes, the hand-downs). {@code level}: their dimension.
	 */
	static Undone undo(ServerLevel level, Collection<String> siteIds, String group) throws Sites.SiteException {
		List<String> ids = new ArrayList<>();
		for (String sid : siteIds) {
			for (JournalStore.Meta m : active(sid)) {
				ids.add(m.id());
			}
		}
		if (ids.isEmpty()) {
			throw new Sites.SiteException(Reason.OTHER, "No journal entry for " + String.join(", ", siteIds) + ": it can't be restored; forget drops the "
				+ "record and leaves the blocks");
		}
		return undoEntries(level, ids, group);
	}

	/** {@link #undo} of these entries (active ones; a move's new entries share the site id with the old ones). */
	/**
	 * Reads into memory, off the server thread, the region files of the active entries that reach into {@code box} (a check
	 * there would otherwise decode them on the server thread: a 256x256 pad's region is tens of milliseconds after a restart).
	 * True when they are all in memory already; else it starts the read (once) and returns false.
	 */
	static boolean warm(String dim, Anchors.Bounds box) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return true;
		}
		List<String[]> todo = new ArrayList<>();
		for (int rx = box.minX() >> 9; rx <= box.maxX() >> 9; rx++) {
			for (int rz = box.minZ() >> 9; rz <= box.maxZ() >> 9; rz++) {
				long r = Sections.region(rx, rz);
				for (JournalStore.Meta m : s.find(m -> m.active() && m.dimension().equals(dim) && m.intersects(dim, new int[] {box.minX(), box.minY(), box.minZ(),
					box.maxX(), box.maxY(), box.maxZ()}))) {
					if (!s.inMemory(m.id(), r)) {
						todo.add(new String[] {m.id(), Long.toString(r)});
					}
				}
			}
		}
		if (todo.isEmpty()) {
			return true;
		}
		String key = dim + "|" + box.minX() + "," + box.minZ() + "," + box.maxX() + "," + box.maxZ();
		CompletableFuture<Void> f = WARMING.get(key);
		if (f != null && f.isDone()) {
			// read once: go on even if the cache could not keep them all (a big journal: the check reads what it needs)
			WARMING.remove(key);
			return true;
		}
		if (f == null) {
			WARMING.put(key, CompletableFuture.runAsync(() -> {
				for (String[] t : todo) {
					try {
						s.region(t[0], Long.parseLong(t[1]));
					} catch (IOException e) {
						// the check reads it again and reports
					}
				}
			}));
		}
		return false;
	}

	private static final Map<String, CompletableFuture<Void>> WARMING = new java.util.concurrent.ConcurrentHashMap<>();

	/** R1 over ticks: the planner of undoing {@code siteIds}' active entries as {@code group} ({@link #submitUndo} when it is done). */
	static WorldJournal.UndoPlanner undoPlanner(ServerLevel level, Collection<String> siteIds, String group) throws Sites.SiteException {
		requireAvailable();
		List<String> ids = new ArrayList<>();
		for (String sid : siteIds) {
			for (JournalStore.Meta m : active(sid)) {
				ids.add(m.id());
			}
		}
		if (ids.isEmpty()) {
			throw new Sites.SiteException(Reason.OTHER, "No journal entry for " + String.join(", ", siteIds) + ": it can't be restored");
		}
		try {
			return new WorldJournal.UndoPlanner(level, ids, group);
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal of " + String.join(", ", siteIds) + " can't be read (" + e.getMessage() + ")");
		}
	}

	/** R2's commit built (pure reads of the store: any thread). */
	static JournalStore.Txn undoTxn(WorldJournal.UndoWork w) throws Sites.SiteException {
		try {
			return WorldJournal.undoTxn(w);
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal can't be read (" + e.getMessage() + ")");
		}
	}

	/** R2: a built commit submitted (server thread). */
	static Undone submitUndo(WorldJournal.UndoWork w, JournalStore.Txn t) throws Sites.SiteException {
		return new Undone(w, store().submit(t));
	}

	/** R2 of a planned undo: its one commit, submitted. */
	static Undone submitUndo(WorldJournal.UndoWork w) throws Sites.SiteException {
		try {
			return new Undone(w, store().submit(WorldJournal.undoTxn(w)));
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal can't be read (" + e.getMessage() + ")");
		}
	}

	static Undone undoEntries(ServerLevel level, Collection<String> entryIds, String group) throws Sites.SiteException {
		requireAvailable();
		List<String> ids = new ArrayList<>();
		for (String id : entryIds) {
			JournalStore.Meta m = store().meta(id);
			if (m != null && m.active()) {
				ids.add(id);
			}
		}
		List<String> siteIds = ids.stream().map(id -> store0().meta(id).site()).distinct().toList();
		if (ids.isEmpty()) {
			throw new Sites.SiteException(Reason.OTHER, "No active journal entry among " + entryIds);
		}
		try {
			WorldJournal.UndoWork w = WorldJournal.planUndo(level, ids, group);
			JournalStore.Txn t = WorldJournal.undoTxn(w);
			return new Undone(w, store().submit(t));
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal of " + String.join(", ", siteIds) + " can't be read (" + e.getMessage()
				+ ")");
		}
	}

	/** What an undo does to one site (R4): its BOX template and mask, its other cells, its ring. */
	record Restore(String site, Anchors.@Nullable Bounds box, @Nullable CompoundTag template, @Nullable LongPredicate mask, List<CellWrite> cells, List<CellWrite> pre,
		List<CellWrite> halves, int[] ring,
		int holes) {
	}

	/** One cell an undo writes outside the BOX template: lowest first, with its kind's flags. */
	record CellWrite(long pos, Value value, int flags) {
	}

	/** The undone entries of {@code siteId} in undo group {@code group}. */
	static List<JournalStore.Meta> undone(String siteId, String group) {
		return entries(siteId).stream().filter(m -> m.status() == Status.UNDONE && group.equals(m.undoGroup())).toList();
	}

	/** The undo group of a site's latest undone entries, or null. */
	static @Nullable String lastGroup(String siteId) {
		String g = null;
		long at = Long.MIN_VALUE;
		for (JournalStore.Meta m : entries(siteId)) {
			if (m.status() == Status.UNDONE && m.undoneAt() >= at) {
				at = m.undoneAt();
				g = m.undoGroup();
			}
		}
		return g;
	}

	/**
	 * The writes of a site's undo (R4), from its committed UNDONE entries: the {@code site} entry's {@code written} values as a
	 * structure template over its box (cells covered by a site that stays are holes: absent, and masked against updates), crate
	 * cells and CELL entries (held leaves quietly) cell by cell, lowest first.
	 */
	static Restore restore(ServerLevel level, String siteId, String group) throws Sites.SiteException {
		JournalStore s = store();
		Anchors.Bounds box = null;
		CompoundTag tpl = null;
		LongPredicate mask = null;
		int holes = 0;
		int[] ring = new int[0];
		List<CellWrite> cells = new ArrayList<>();
		List<CellWrite> pre = new ArrayList<>();
		List<CellWrite> halves = new ArrayList<>();
		Map<Long, Value> boxWritten = new LinkedHashMap<>();
		Set<Long> boxUnwritten = new LinkedHashSet<>();
		try {
			for (JournalStore.Meta m : undone(siteId, group)) {
				Map<Long, Value> written = new LinkedHashMap<>();
				List<Long> unwritten = new ArrayList<>();
				for (long k : m.sections()) {
					SectionCells sc = s.section(m.id(), k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						Value v = sc.written(i);
						if (v != null) {
							written.put(sc.pos(i), v);
						} else {
							unwritten.add(sc.pos(i));
						}
					}
				}
				if ((m.kind().equals(WorldJournal.SITE) || m.kind().equals(WorldJournal.DELTA)) && m.policy() == Policy.BOX && m.box() != null) {
					// the site's restore box and its deltas (phase 5b): one template over their union, written as the 4d restore
					int[] b = m.box();
					Anchors.Bounds mb = new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]);
					box = box == null ? mb : Sites.union(box, mb);
					boxWritten.putAll(written);
					boxUnwritten.addAll(unwritten);
					// the rings of the site and of its growth deltas (phase 5b), all restored after the box
					int[] mr = s.head(m.id()).ring();
					if (mr.length > 0) {
						int[] merged = java.util.Arrays.copyOf(ring, ring.length + mr.length);
						System.arraycopy(mr, 0, merged, ring.length, mr.length);
						ring = merged;
					}
				} else {
					int flags = m.kind().equals(WorldJournal.LEAVES) ? Sites.FLAGS | Block.UPDATE_KNOWN_SHAPE : m.policy() == Policy.BOX ? Sites.FLAGS
						: Sites.CELL_FLAGS;
					boolean guard = m.kind().equals(WorldJournal.LEAVES);
					written.forEach((p, v) -> {
						// a cut plant's outside half goes back before the box, so its inside half stays when the box is written
						if (guard && !v.name().endsWith("_leaves")) {
							pre.add(new CellWrite(p, v, Sites.FLAGS | Block.UPDATE_KNOWN_SHAPE));
						} else {
							cells.add(new CellWrite(p, v, flags));
						}
					});
				}
			}
			if (box != null) {
				// positions some entry wrote win over another's unwritten (a delta's hole is not the base's)
				boxUnwritten.removeIf(boxWritten::containsKey);
				tpl = JournalNbt.toTemplate(boxWritten, box.minX(), box.minY(), box.minZ(), box.maxX() - box.minX() + 1, box.maxY() - box.minY() + 1,
					box.maxZ() - box.minZ() + 1, 0);
				// two-block plants and doors: a box write can lose them (each half is written next to the other half's old
				// neighbour); put back quietly afterwards where the world does not hold them
				boxWritten.forEach((p, v) -> {
					if (v.state().get("properties") instanceof CompoundTag pr && pr.contains("half") && WorldJournal.state(v).hasProperty(
						net.minecraft.world.level.block.state.properties.BlockStateProperties.DOUBLE_BLOCK_HALF)) {
						halves.add(new CellWrite(p, v, Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE));
					}
				});
				holes = boxUnwritten.size();
				if (!boxUnwritten.isEmpty()) {
					mask = coverMask(dimOf(siteId), new ArrayList<>(boxUnwritten));
				}
			}
		} catch (IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal of " + siteId + " can't be read (" + e.getMessage() + ")");
		}
		cells.sort(Comparator.comparingInt(c -> Journal.y(c.pos())));
		return new Restore(siteId, box, tpl, mask, cells, pre, halves, ring, holes);
	}

	/** The dimension of a site's entries (its first entry's). */
	static String dimOf(String siteId) {
		for (JournalStore.Meta m : entries(siteId)) {
			return m.dimension();
		}
		return "minecraft:overworld";
	}

	/** The cells of the entries that stay on top of {@code holes} (positions not written because they are covered). */
	static @Nullable LongPredicate coverMask(String dimension, List<Long> holes) throws IOException {
		JournalStore s = WorldJournal.store();
		Set<String> covering = new LinkedHashSet<>();
		for (long p : holes) {
			List<WorldJournal.Layer> st = WorldJournal.stack(dimension, p);
			if (!st.isEmpty()) {
				covering.add(st.get(st.size() - 1).meta().id());
			}
		}
		if (covering.isEmpty()) {
			return null;
		}
		Map<Long, long[]> bits = new HashMap<>();
		for (String id : covering) {
			JournalStore.Meta m = s.meta(id);
			if (m == null) {
				continue;
			}
			for (long k : m.sections()) {
				SectionCells sc = s.section(id, k);
				if (sc == null) {
					continue;
				}
				long[] b = bits.computeIfAbsent(k, x -> new long[64]);
				long[] sm = sc.mask();
				for (int i = 0; i < 64; i++) {
					b[i] |= sm[i];
				}
			}
		}
		return pos -> {
			long[] b = bits.get(Sections.key(pos));
			int i = Sections.index(pos);
			return b != null && (b[i >> 6] & 1L << (i & 63)) != 0;
		};
	}

	/**
	 * Writes a site's undo at once (R4, atomic): the template through the 4d restore ({@code Sites.restoreQuietly}, under the
	 * mask when it has holes), then its other cells, then the leaf ring. Returns the restore.
	 */
	static Restore writeNow(ServerLevel level, String siteId, String group) throws Sites.SiteException {
		Restore r = restore(level, siteId, group);
		writeCells(level, r.pre());
		if (r.template() != null && r.box() != null) {
			if (r.mask() != null) {
				UpdateMask.begin(r.mask());
			}
			try {
				Sites.restoreQuietly(level, r.box(), r.template());
			} finally {
				UpdateMask.end();
			}
		}
		writeCells(level, r.cells());
		fixHalves(level, r.halves());
		return r;
	}

	/** Puts back the two-block halves a restore wrote that the world does not hold any more (quietly). */
	static void fixHalves(ServerLevel level, List<CellWrite> halves) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (CellWrite c : halves) {
			m.set(Journal.x(c.pos()), Journal.y(c.pos()), Journal.z(c.pos()));
			BlockState want = WorldJournal.state(c.value());
			if (level.getBlockState(m) != want) {
				level.setBlock(m, want, c.flags());
			}
		}
	}

	/** Writes CELL undo cells (lowest first): the state with its kind's flags, then the block entity data. */
	static void writeCells(ServerLevel level, List<CellWrite> cells) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (CellWrite c : cells) {
			m.set(Journal.x(c.pos()), Journal.y(c.pos()), Journal.z(c.pos()));
			level.setBlock(m, WorldJournal.state(c.value()), c.flags());
			if (c.value().nbt() != null) {
				BlockEntity be = level.getBlockEntity(m);
				if (be != null) {
					be.loadWithComponents(TagValueInput.create(ProblemReporter.DISCARDING, level.registryAccess(), c.value().nbt()));
					be.setChanged();
				}
			}
		}
	}

	/** Restores a site's leaf ring (4d), skipping cells a standing entry owns. */
	static void restoreRing(ServerLevel level, int[] ring) {
		if (ring.length == 0) {
			return;
		}
		String dim = Sites.dimensionId(level);
		LeafGuard.restoreRing(level, ring, p -> owned(dim, p.asLong()), Sites.FLAGS);
	}

	/** The commit settling an undo group at world start: the entries are released (the restore reached the disk). */
	static void releaseGroup(Collection<String> entryIds) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null || entryIds.isEmpty()) {
			return;
		}
		JournalStore.Txn t = s.begin().label("settle:release");
		entryIds.forEach(t::release);
		s.submit(t);
	}

	/**
	 * The commit settling an undo group at world start when the site still stands (the undo never reached the disk): its
	 * entries are ACTIVE again (their undo records dropped) and their hand-downs reversed where the receiver still holds what
	 * was handed ({@link Sections#reactivate}).
	 */
	static void reactivate(String group) throws IOException {
		JournalStore s = WorldJournal.store();
		List<JournalStore.Meta> members = s.find(m -> m.status() == Status.UNDONE && group.equals(m.undoGroup()));
		if (members.isEmpty()) {
			return;
		}
		String dim = members.get(0).dimension();
		TreeSet<Long> sections = new TreeSet<>();
		for (JournalStore.Meta m : members) {
			for (long k : m.sections()) {
				sections.add(k);
			}
		}
		Map<Long, List<Journal.Entry>> slices = new HashMap<>();
		for (long k : sections) {
			List<Journal.Entry> l = new ArrayList<>();
			for (String id : s.inSection(dim, k)) {
				JournalStore.Meta m = s.meta(id);
				if (m != null && (m.active() || group.equals(m.undoGroup()))) {
					Journal.Entry e = s.slice(id, k);
					if (e != null) {
						l.add(e);
					}
				}
			}
			slices.put(k, l);
		}
		Map<String, Map<Long, List<Cell>>> back = Sections.reactivate(sections, slices::get, group);
		JournalStore.Txn t = s.begin().label("settle:reactivate:" + group);
		for (var e : back.entrySet()) {
			List<SectionCells> secs = new ArrayList<>();
			e.getValue().forEach((k, cells) -> secs.add(SectionCells.of(k, cells, null)));
			t.sections(e.getKey(), secs);
		}
		for (JournalStore.Meta m : members) {
			List<SectionCells> secs = new ArrayList<>();
			for (long k : m.sections()) {
				SectionCells sc = s.section(m.id(), k);
				if (sc != null) {
					secs.add(sc.withWritten(null));
				}
			}
			t.sections(m.id(), secs);
			Set<Long> regions = new TreeSet<>();
			for (long k : m.sections()) {
				regions.add(Sections.region(k));
			}
			regions.forEach(r -> t.handed(m.id(), r, List.of()));
			t.status(m.id(), Status.ACTIVE, null, 0L);
		}
		s.submit(t);
	}

	// ------------------------------------------------------------------ construction targets

	/** A construction site's target (what its instant placement left over the box): its site entry's {@code after} values. */
	static @Nullable Cells target(String siteId, Anchors.Bounds box) {
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta m = main(siteId);
		if (s == null || m == null) {
			return null;
		}
		Map<Long, Value> after = new HashMap<>();
		try {
			for (long k : m.sections()) {
				SectionCells sc = s.section(m.id(), k);
				if (sc == null) {
					continue;
				}
				for (int i = 0; i < sc.size(); i++) {
					Value a = sc.after(i);
					if (a == null) {
						return null; // a migrated entry without its target
					}
					after.put(sc.pos(i), a);
				}
			}
			// phase 5b: the site's deltas lie on top (oldest first): the target is the site's top after
			List<JournalStore.Meta> deltas = active(siteId).stream().filter(x -> x.kind().equals(WorldJournal.DELTA)).sorted(Comparator.comparingLong(
				JournalStore.Meta::layer)).toList();
			for (JournalStore.Meta d : deltas) {
				for (long k : d.sections()) {
					SectionCells sc = s.section(d.id(), k);
					if (sc == null) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						Value a = sc.after(i);
						if (a != null) {
							after.put(sc.pos(i), a);
						}
					}
				}
			}
		} catch (IOException e) {
			return null;
		}
		return Cells.fromValues(box, after);
	}

	/** An entry's {@code before} values over {@code box} (a construction delta's old blocks), or null. */
	static @Nullable Cells beforeOf(String entryId, Anchors.Bounds box) {
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta m = s == null ? null : s.meta(entryId);
		if (m == null) {
			return null;
		}
		Map<Long, Value> v = new HashMap<>();
		try {
			for (long k : m.sections()) {
				SectionCells sc = s.section(m.id(), k);
				if (sc != null) {
					for (int i = 0; i < sc.size(); i++) {
						v.put(sc.pos(i), sc.before(i));
					}
				}
			}
		} catch (IOException e) {
			return null;
		}
		return Cells.fromValues(box, v);
	}

	/** The site entry's {@code before} values as a dense box (a deconstruct's "was" per cell). */
	static @Nullable Cells before(String siteId, Anchors.Bounds box, boolean undone) {
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return null;
		}
		JournalStore.Meta m = null;
		for (JournalStore.Meta x : entries(siteId)) {
			if (x.kind().equals(WorldJournal.SITE) && (undone ? x.status() == Status.UNDONE : x.active())) {
				m = x;
			}
		}
		if (m == null) {
			return null;
		}
		Map<Long, Value> v = new HashMap<>();
		try {
			for (long k : m.sections()) {
				SectionCells sc = s.section(m.id(), k);
				if (sc != null) {
					for (int i = 0; i < sc.size(); i++) {
						v.put(sc.pos(i), sc.before(i));
					}
				}
			}
			// phase 5b: cells a delta first touched (growth) have their pre-site value in that delta's before (the oldest wins)
			for (JournalStore.Meta x : entries(siteId)) {
				if (!x.kind().equals(WorldJournal.DELTA) || !(undone ? x.status() == Status.UNDONE : x.active())) {
					continue;
				}
				for (long k : x.sections()) {
					SectionCells sc = s.section(x.id(), k);
					if (sc != null) {
						for (int i = 0; i < sc.size(); i++) {
							v.putIfAbsent(sc.pos(i), sc.before(i));
						}
					}
				}
			}
		} catch (IOException e) {
			return null;
		}
		return Cells.fromValues(box, v);
	}

	/** The {@code before} and {@code after} at one cell of a site's site entry (null when it has none there). */
	static Cell cellAt(String siteId, long pos) {
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta m = main(siteId);
		if (s == null || m == null) {
			return null;
		}
		try {
			SectionCells sc = s.section(m.id(), Sections.key(pos));
			int k = sc == null ? -1 : sc.find(Sections.index(pos));
			return k < 0 ? null : sc.cell(k);
		} catch (IOException e) {
			return null;
		}
	}

	/** Sites whose entries have cells near {@code box} (grown by {@code d}) in {@code dimension}: for reholdNear. */
	static Set<String> sitesNear(String dimension, Anchors.Bounds box, int d) {
		Set<String> out = new HashSet<>();
		JournalStore s = WorldJournal.storeOrNull();
		if (s == null) {
			return out;
		}
		for (long k : WorldJournal.sectionsOf(box.grow(d))) {
			for (String id : s.inSection(dimension, k)) {
				JournalStore.Meta m = s.meta(id);
				if (m != null && m.active()) {
					out.add(m.site());
				}
			}
		}
		return out;
	}

	/** Positions, as sections, a list of cell triples touches (helper). */
	static TreeMap<Long, List<Long>> bySection(List<Long> positions) {
		TreeMap<Long, List<Long>> out = new TreeMap<>();
		for (long p : positions) {
			out.computeIfAbsent(Sections.key(p), k -> new ArrayList<>()).add(p);
		}
		return out;
	}

	/**
	 * Survival layering (docs/CONTRACT.md phase 4e "Survival layering"): for every cell of this site that another site covers,
	 * the {@code before} of the covering cell directly above it (the lowest layer above this site's). Empty when nothing covers
	 * it.
	 */
	static Map<Long, Value> coverBefores(String siteId) {
		Map<Long, Value> out = new HashMap<>();
		Map<Long, Long> layerAt = new HashMap<>();
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta main = main(siteId);
		if (s == null || main == null) {
			return out;
		}
		try {
			for (long k : main.sections()) {
				SectionCells mine = s.section(main.id(), k);
				List<String> ids = s.inSection(main.dimension(), k);
				if (mine == null || ids.size() < 2) {
					continue;
				}
				for (String o : ids) {
					JournalStore.Meta om = s.meta(o);
					if (om == null || !om.active() || om.site().equals(siteId) || om.kind().equals(WorldJournal.LEAVES)) {
						continue;
					}
					SectionCells their = s.section(o, k);
					if (their == null || !mine.intersects(their.mask())) {
						continue;
					}
					for (int a = 0; a < mine.size(); a++) {
						int j = their.find(mine.index(a));
						if (j < 0 || their.layer(j) <= mine.layer(a)) {
							continue;
						}
						long p = mine.pos(a);
						Long l = layerAt.get(p);
						if (l == null || their.layer(j) < l) {
							layerAt.put(p, their.layer(j));
							out.put(p, their.before(j));
						}
					}
				}
			}
		} catch (IOException e) {
			// unreadable: no cover known
		}
		return out;
	}

	// ------------------------------------------------------------------ DevBridge

	/**
	 * A site's journal view ({@code dev.site.state}): its entries (id, kind, policy, status, layer, cells), the cells of its main
	 * entry another site covers ({@code covered}), the sites it lies on ({@code covers}) and under ({@code coveredBy}).
	 */
	public static JsonObject siteJson(String siteId) {
		JsonObject o = new JsonObject();
		com.google.gson.JsonArray es = new com.google.gson.JsonArray();
		for (JournalStore.Meta m : entries(siteId)) {
			JsonObject j = new JsonObject();
			j.addProperty("entry", m.id());
			j.addProperty("kind", m.kind());
			j.addProperty("policy", m.policy().name());
			j.addProperty("status", m.status().name());
			j.addProperty("layer", m.layer());
			j.addProperty("cells", m.cells());
			es.add(j);
		}
		o.add("entries", es);
		int covered = 0;
		JournalStore s = WorldJournal.storeOrNull();
		JournalStore.Meta main = main(siteId);
		if (s != null && main != null) {
			try {
				for (long k : main.sections()) {
					SectionCells sc = s.section(main.id(), k);
					if (sc == null) {
						continue;
					}
					List<String> ids = s.inSection(main.dimension(), k);
					if (ids.size() < 2) {
						continue;
					}
					for (int i = 0; i < sc.size(); i++) {
						for (String other : ids) {
							JournalStore.Meta om = s.meta(other);
							if (om == null || !om.active() || om.site().equals(siteId) || om.kind().equals(WorldJournal.LEAVES)) {
								continue;
							}
							SectionCells oc = s.section(other, k);
							int j = oc == null ? -1 : oc.find(sc.index(i));
							if (j >= 0 && oc.layer(j) > sc.layer(i)) {
								covered++;
								break;
							}
						}
					}
				}
			} catch (IOException e) {
				// unreadable: not counted
			}
		}
		o.addProperty("covered", covered);
		com.google.gson.JsonArray layers = new com.google.gson.JsonArray();
		coveredSites(siteId).forEach(layers::add);
		o.add("covers", layers);
		com.google.gson.JsonArray by = new com.google.gson.JsonArray();
		coveringSites(siteId).forEach(by::add);
		o.add("coveredBy", by);
		return o;
	}
}
