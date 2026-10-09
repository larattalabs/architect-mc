package dev.larattalabs.architect.journal;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.placement.Anchors;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProblemReporter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.level.storage.TagValueOutput;
import org.jspecify.annotations.Nullable;

/**
 * The running world's journal (docs/CONTRACT.md "Phase 4e contract"), server side. Adapted from AgentCraft
 * {@code dev.agentcraft.journal.WorldJournal} at {@code ab08a02}: open and close, {@link #unavailable}, {@link #valueAt},
 * the state and stack views for the DevBridge are kept; AgentCraft's {@code activeTouching} (whole entries by bounding box)
 * is replaced by the section index, and its {@code apply} is replaced: undo writes go through Architect's 4d writers
 * ({@code site.SiteJournal}). This class captures cells, plans undos against a level one section at a time, and holds the
 * crash-test kill points. Server thread, except the read-only views.
 */
public final class WorldJournal {
	/** A building's restore box (BOX). */
	public static final String SITE = "site";
	/** A road (CELL). */
	public static final String ROAD = "road";
	/** A construction crate's cell (BOX). */
	public static final String CRATE = "crate";
	/** Held leaves (CELL, written quietly). */
	public static final String LEAVES = "leaves";
	/** A delta of a placed site to another version of its entry (BOX, phase 5b), in the site's undo group. */
	public static final String DELTA = "delta";

	private static volatile @Nullable JournalStore store;
	private static volatile @Nullable String unavailable;
	private static volatile @Nullable Path world;
	private static volatile @Nullable MinecraftServer server;
	/** {@code dev.journal.killAt}: the next matching step halts the JVM. */
	private static volatile @Nullable String killAt;
	/** {@code dev.journal.failNextCommit}: the next commit fails at its first file write (a full disk). */
	private static volatile boolean failNext;
	/** The label of the commit the I/O thread writes now (kill points K1 and K8 halt inside it). */
	static volatile String writing = "";
	/** Hooks run when the journal opened (migration, records from the journal), before the sites load. */
	private static final List<java.util.function.BiConsumer<MinecraftServer, JournalStore>> ON_OPEN = new ArrayList<>();

	private WorldJournal() {
	}

	/** Registers before the sites: the journal opens (and imports) before they load their records. */
	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(WorldJournal::open);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			JournalStore st = store;
			if (st != null) {
				st.close();
			}
			store = null;
			unavailable = null;
			world = null;
			server = null;
			ChangeTracker.reset();
		});
		JournalStore.faultHook = WorldJournal::ioStep;
	}

	/** Runs {@code hook} each time a world's journal opened (before the sites load). */
	public static void onOpen(java.util.function.BiConsumer<MinecraftServer, JournalStore> hook) {
		ON_OPEN.add(hook);
	}

	static void open(MinecraftServer srv) {
		Path w = srv.getWorldPath(LevelResource.ROOT);
		world = w;
		server = srv;
		try {
			JournalStore s = JournalStore.open(w, (long) cacheMb() << 20);
			if (!s.unreferenced().isEmpty()) {
				Architect.LOGGER.warn("World journal: entry files no index entry names (a change that never committed; kept): {}", s.unreferenced());
			}
			store = s;
			unavailable = null;
			for (var h : ON_OPEN) {
				h.accept(srv, s);
			}
		} catch (IOException | RuntimeException e) {
			store = null;
			unavailable = "The world journal (" + JournalStore.DIR + ") could not be read (" + e.getMessage()
				+ "): Architect changes no blocks until it is fixed (see the log)";
			Architect.LOGGER.error("World journal: could not open {}", JournalStore.dirOf(w), e);
		}
	}

	/** Marks the journal unusable (a failed import): world changes are refused. */
	public static void disable(String why) {
		store = null;
		unavailable = why;
	}

	/** Why world changes are refused (the journal could not be read), or null. Any thread. */
	public static @Nullable String unavailable() {
		return world == null ? "no world" : unavailable;
	}

	public static JournalStore store() throws IOException {
		JournalStore s = store;
		if (s == null) {
			String why = unavailable();
			throw new IOException(why == null ? "no world journal" : why);
		}
		return s;
	}

	public static @Nullable JournalStore storeOrNull() {
		return store;
	}

	/** {@code journalCacheMb} from the world settings (default 64). */
	static int cacheMb() {
		return dev.larattalabs.architect.survival.SurvivalWorld.journalCacheMb();
	}

	// ------------------------------------------------------------------ values

	private static final Map<BlockState, Value> BY_STATE = new IdentityHashMap<>();
	private static final Map<CompoundTag, BlockState> BY_TAG = new IdentityHashMap<>();
	private static final Map<CompoundTag, BlockState> BY_EQUAL = new ConcurrentHashMap<>();

	/** A block state as a journal value (no block entity data), cached. */
	public static Value value(BlockState s) {
		synchronized (BY_STATE) {
			Value v = BY_STATE.get(s);
			if (v == null) {
				v = Value.of(NbtUtils.writeBlockState(s), null);
				BY_STATE.put(s, v);
			}
			return v;
		}
	}

	/** The block at {@code p} as the journal keeps it: its state and its block entity's data as a structure template saves it. */
	public static Value valueAt(Level level, BlockPos p) {
		BlockState s = level.getBlockState(p);
		Value v = value(s);
		if (s.hasBlockEntity()) {
			CompoundTag nbt = beNbt(level, p);
			if (nbt != null) {
				return v.withNbt(nbt);
			}
		}
		return v;
	}

	/** A block entity's data, saved as {@code StructureTemplate.fillFromWorld} saves it ({@code saveWithId}), or null. */
	public static @Nullable CompoundTag beNbt(Level level, BlockPos p) {
		BlockEntity be = level.getBlockEntity(p);
		if (be == null) {
			return null;
		}
		TagValueOutput out = TagValueOutput.createWithContext(ProblemReporter.DISCARDING, level.registryAccess());
		be.saveWithId(out);
		return out.buildResult();
	}

	/** A journal value's block state (cached). */
	public static BlockState state(Value v) {
		CompoundTag t = v.state();
		synchronized (BY_TAG) {
			BlockState s = BY_TAG.get(t);
			if (s != null) {
				return s;
			}
		}
		BlockState s = BY_EQUAL.get(t);
		if (s == null) {
			s = NbtUtils.readBlockState(BuiltInRegistries.BLOCK, t);
			BY_EQUAL.put(t.copy(), s);
		}
		synchronized (BY_TAG) {
			if (BY_TAG.size() < 65536) {
				BY_TAG.put(t, s);
			}
		}
		return s;
	}

	// ------------------------------------------------------------------ capture

	/** A box captured cell by cell: values in box index order ({@code (y * dz + z) * dx + x}). */
	public record Captured(Anchors.Bounds box, Value[] values) {
		public int dx() {
			return box.maxX() - box.minX() + 1;
		}

		public int dz() {
			return box.maxZ() - box.minZ() + 1;
		}

		public int index(int x, int y, int z) {
			return ((y - box.minY()) * dz() + (z - box.minZ())) * dx() + (x - box.minX());
		}

		public @Nullable Value at(long pos) {
			int x = Journal.x(pos);
			int y = Journal.y(pos);
			int z = Journal.z(pos);
			return box.contains(x, y, z) ? values[index(x, y, z)] : null;
		}

		public int size() {
			return values.length;
		}
	}

	/**
	 * Captures {@code box} (states and block entity data, air included), in one go. Reads chunk sections directly; the result
	 * equals what {@code StructureTemplate.fillFromWorld} saves for the same box. Loads chunks (the caller checked they are
	 * loaded).
	 */
	public static Captured capture(ServerLevel level, Anchors.Bounds box) {
		Value[] v = new Value[(box.maxX() - box.minX() + 1) * (box.maxY() - box.minY() + 1) * (box.maxZ() - box.minZ() + 1)];
		Captured c = new Captured(box, v);
		captureSlice(level, c, 0, v.length);
		return c;
	}

	/** An empty capture of {@code box}, filled by {@link #captureSlice}. */
	public static Captured empty(Anchors.Bounds box) {
		return new Captured(box, new Value[(box.maxX() - box.minX() + 1) * (box.maxY() - box.minY() + 1) * (box.maxZ() - box.minZ() + 1)]);
	}

	/** Captures box indexes {@code from} (inclusive) to {@code to} (exclusive) of {@code c}. */
	public static void captureSlice(ServerLevel level, Captured c, int from, int to) {
		Anchors.Bounds b = c.box();
		int dx = c.dx();
		int dz = c.dz();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		LevelChunk chunk = null;
		for (int i = from; i < to; i++) {
			int x = b.minX() + i % dx;
			int rest = i / dx;
			int z = b.minZ() + rest % dz;
			int y = b.minY() + rest / dz;
			if (chunk == null || chunk.getPos().x() != x >> 4 || chunk.getPos().z() != z >> 4) {
				chunk = level.getChunk(x >> 4, z >> 4);
			}
			BlockState s;
			int si = level.getSectionIndex(y);
			if (si < 0 || si >= chunk.getSections().length) {
				s = net.minecraft.world.level.block.Blocks.VOID_AIR.defaultBlockState();
			} else {
				LevelChunkSection sec = chunk.getSections()[si];
				s = sec.getBlockState(x & 15, y & 15, z & 15);
			}
			Value v = value(s);
			if (s.hasBlockEntity()) {
				CompoundTag nbt = beNbt(level, m.set(x, y, z));
				if (nbt != null) {
					v = v.withNbt(nbt);
				}
			}
			c.values()[i] = v;
		}
	}

	/** Captures these positions of {@code c} again (change tracking); positions outside its box are skipped. */
	public static void recapture(ServerLevel level, Captured c, long[] positions) {
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (long p : positions) {
			int x = Journal.x(p);
			int y = Journal.y(p);
			int z = Journal.z(p);
			if (c.box().contains(x, y, z)) {
				c.values()[c.index(x, y, z)] = valueAt(level, m.set(x, y, z));
			}
		}
	}

	/** The sections a box touches (ascending keys). */
	public static TreeSet<Long> sectionsOf(Anchors.Bounds b) {
		TreeSet<Long> out = new TreeSet<>();
		for (int sy = b.minY() >> 4; sy <= b.maxY() >> 4; sy++) {
			for (int sz = b.minZ() >> 4; sz <= b.maxZ() >> 4; sz++) {
				for (int sx = b.minX() >> 4; sx <= b.maxX() >> 4; sx++) {
					out.add(Sections.key(sx, sy, sz));
				}
			}
		}
		return out;
	}

	/**
	 * A captured box as section cells: every cell of {@code before} ({@code skip}: positions left out), {@code after} from
	 * {@code after} at the same index (null: unknown), all at {@code layer}.
	 */
	public static List<SectionCells> sections(Captured before, @Nullable Captured after, long layer, java.util.function.@Nullable LongPredicate skip) {
		Anchors.Bounds b = before.box();
		List<SectionCells> out = new ArrayList<>();
		for (long key : sectionsOf(b)) {
			int x0 = Math.max(b.minX(), Sections.sx(key) << 4);
			int x1 = Math.min(b.maxX(), (Sections.sx(key) << 4) + 15);
			int y0 = Math.max(b.minY(), Sections.sy(key) << 4);
			int y1 = Math.min(b.maxY(), (Sections.sy(key) << 4) + 15);
			int z0 = Math.max(b.minZ(), Sections.sz(key) << 4);
			int z1 = Math.min(b.maxZ(), (Sections.sz(key) << 4) + 15);
			int n = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
			short[] idx = new short[n];
			Value[] bv = new Value[n];
			Value[] av = new Value[n];
			long[] lv = new long[n];
			int k = 0;
			for (int y = y0; y <= y1; y++) {
				for (int z = z0; z <= z1; z++) {
					for (int x = x0; x <= x1; x++) {
						if (skip != null && skip.test(Journal.pos(x, y, z))) {
							continue;
						}
						int i = before.index(x, y, z);
						idx[k] = (short) ((y & 15) << 8 | (z & 15) << 4 | x & 15);
						bv[k] = before.values()[i];
						av[k] = after == null ? null : after.values()[i];
						lv[k] = layer;
						k++;
					}
				}
			}
			if (k == 0) {
				continue;
			}
			if (k < n) {
				idx = java.util.Arrays.copyOf(idx, k);
				bv = java.util.Arrays.copyOf(bv, k);
				av = java.util.Arrays.copyOf(av, k);
				lv = java.util.Arrays.copyOf(lv, k);
			}
			out.add(new SectionCells(key, idx, bv, av, lv, null));
		}
		return out;
	}

	/** An entry's sections with every {@code after} read from {@code after} (by position). */
	public static List<SectionCells> withAfter(Collection<SectionCells> secs, Captured after) {
		List<SectionCells> out = new ArrayList<>(secs.size());
		for (SectionCells s : secs) {
			Value[] av = new Value[s.size()];
			for (int k = 0; k < s.size(); k++) {
				Value v = after.at(s.pos(k));
				av[k] = v != null ? v : s.after(k);
			}
			out.add(new SectionCells(s.key, s.idx, s.before, av, s.layer, s.written));
		}
		return out;
	}

	// ------------------------------------------------------------------ still ours

	/** Whether the world at {@code pos} still holds {@code after} ({@link StillOurs}). */
	public static boolean holds(Level level, long pos, Value after) {
		BlockPos p = BlockPos.of(pos);
		BlockState now = level.getBlockState(p);
		BlockState want = state(after);
		if (now.getBlock() != want.getBlock() && !(want.isAir() && !now.getFluidState().isEmpty()) && !(StillOurs.spread(now) && StillOurs.spread(want))) {
			return false; // (a fluid in cleared air goes to StillOurs, phase 6a)
		}
		return StillOurs.holds(now, now.hasBlockEntity() ? beNbt(level, p) : null, want, after.nbt());
	}

	/** Whether a recorded value {@code v} still holds {@code after} ({@link StillOurs}). */
	public static boolean same(Value v, Value after) {
		if (v.equals(after)) {
			return true;
		}
		return StillOurs.holds(state(v), v.nbt(), state(after), after.nbt());
	}

	// ------------------------------------------------------------------ stacks

	/** One cell of a stack: the entry's index meta and its cell there. */
	public record Layer(JournalStore.Meta meta, Cell cell) {
	}

	/** The active cells at {@code pos} (ACTIVE and PLACING entries), bottom first (by layer, ties by id). */
	public static List<Layer> stack(String dimension, long pos) throws IOException {
		JournalStore s = store();
		long key = Sections.key(pos);
		int idx = Sections.index(pos);
		List<Layer> out = new ArrayList<>();
		for (String id : s.inSection(dimension, key)) {
			JournalStore.Meta m = s.meta(id);
			if (m == null || !m.active()) {
				continue;
			}
			SectionCells sc = s.section(id, key);
			int k = sc == null ? -1 : sc.find(idx);
			if (k >= 0) {
				out.add(new Layer(m, sc.cell(k)));
			}
		}
		out.sort(java.util.Comparator.comparingLong((Layer l) -> l.cell().layer()).thenComparing(l -> l.meta().id()));
		return out;
	}

	/** The active entries with cells in section {@code key} as section slices (the stacks there). */
	public static List<Entry> activeSlices(String dimension, long key) throws IOException {
		JournalStore s = store();
		List<Entry> out = new ArrayList<>();
		for (String id : s.inSection(dimension, key)) {
			JournalStore.Meta m = s.meta(id);
			if (m != null && m.active()) {
				Entry e = s.slice(id, key);
				if (e != null) {
					out.add(e);
				}
			}
		}
		return out;
	}

	// ------------------------------------------------------------------ undo planning

	/**
	 * An undo planned one section at a time (R1): the plan, the entries undone, and the entries that stay on top of any of
	 * their cells (the covering entries: their cells are the restore's mask).
	 */
	public record UndoWork(String group, long at, String dimension, List<String> ids, Sections.Plan plan, Set<String> covering, TreeSet<Long> sections) {
		/** The writes of one entry (position -> value, in plan order). */
		public LinkedHashMap<Long, Value> writesBy(String id) {
			LinkedHashMap<Long, Value> m = new LinkedHashMap<>();
			for (Journal.Write w : plan.writes()) {
				if (w.by().equals(id)) {
					m.put(w.pos(), w.value());
				}
			}
			return m;
		}

		/** Hand-downs per receiving entry (cells handed). */
		public Map<String, Integer> handedDown() {
			Map<String, Integer> out = new TreeMap<>();
			for (var u : plan.undos().values()) {
				for (HandDown h : u.handed()) {
					out.merge(h.to(), 1, Integer::sum);
				}
			}
			return out;
		}
	}

	/**
	 * Plans undoing {@code ids} (active or placing entries of {@code dimension}) together as {@code group} against
	 * {@code level}: per section, the stacks of every active entry there. Pure apart from reading the journal and the world.
	 */
	public static UndoWork planUndo(ServerLevel level, Collection<String> ids, String group) throws IOException {
		UndoPlanner p = new UndoPlanner(level, ids, group);
		p.sync = true;
		p.step(Long.MAX_VALUE);
		return p.work();
	}

	/**
	 * {@link #planUndo} spread over ticks (docs/CONTRACT.md phase 4e: undo planning sliced per section): {@link #step} plans
	 * sections until a deadline; {@link #work} once it says done. Server thread.
	 */
	public static final class UndoPlanner {
		private final ServerLevel level;
		private final JournalStore s;
		private final String dim;
		private final List<String> ids;
		private final String group;
		private final long at = System.currentTimeMillis();
		private final TreeSet<Long> sections = new TreeSet<>();
		private final java.util.Iterator<Long> next;
		private final Set<String> undo;
		private final Set<String> covering = new LinkedHashSet<>();
		private final Sections.Planner planner;
		private int planned;

		public UndoPlanner(ServerLevel level, Collection<String> ids, String group) throws IOException {
			this.level = level;
			this.s = store();
			this.dim = level.dimension().identifier().toString();
			this.ids = List.copyOf(ids);
			this.group = group;
			for (String id : ids) {
				JournalStore.Meta m = s.meta(id);
				if (m == null || !m.active()) {
					throw new IOException("not an active journal entry: " + id);
				}
				for (long k : m.sections()) {
					sections.add(k);
				}
			}
			this.undo = new HashSet<>(ids);
			this.next = sections.iterator();
			this.planner = new Sections.Planner(ids, group, at, (pos, after) -> holds(level, pos, after), WorldJournal::same);
		}

		private java.util.concurrent.@Nullable CompletableFuture<Void> warm;
		private final Map<String, JournalNbt.Region> read = new java.util.concurrent.ConcurrentHashMap<>();
		/** {@link #planUndo}: everything in one call (no warming). */
		boolean sync;

		/**
		 * Reads the region files of the sections to plan off the server thread first (a large entry's region decodes in tens of
		 * milliseconds); false while that runs. A small undo plans at once.
		 */
		public boolean ready() {
			if (sync || sections.size() <= 24) {
				return true;
			}
			if (warm == null) {
				Set<Long> regions = new TreeSet<>();
				sections.forEach(k -> regions.add(Sections.region(k)));
				warm = java.util.concurrent.CompletableFuture.runAsync(() -> {
					for (long r : regions) {
						for (long k : sections) {
							if (Sections.region(k) != r) {
								continue;
							}
							try {
								for (String id : s.inSection(dim, k)) {
									JournalStore.Meta m = s.meta(id);
									String key = id + "@" + r;
									if (m != null && m.active() && !read.containsKey(key)) {
										read.put(key, s.region(id, r)); // held here: a large region may not stay in the store's cache
									}
								}
							} catch (IOException e) {
								// planning reads it again and reports
							}
						}
					}
				});
			}
			return warm.isDone();
		}

		/** Plans sections until {@code deadline} (at least one); true when every section is planned. */
		public boolean step(long deadline) throws IOException {
			if (!ready()) {
				return false;
			}
			int n = 0;
			while (next.hasNext()) {
				if (n > 0 && System.nanoTime() >= deadline) {
					return false;
				}
				long k = next.next();
				List<Entry> l = new ArrayList<>();
				for (String id : s.inSection(dim, k)) {
					JournalStore.Meta m = s.meta(id);
					if (m != null && m.active()) {
						Entry e = s.slice(id, k, read.get(id + "@" + Sections.region(k)));
						if (e != null) {
							l.add(e);
						}
					}
				}
				// covering entries: on top of an undone cell and staying
				if (l.size() > 1) {
					Map<Long, Entry> top = new HashMap<>();
					Map<Long, Long> topLayer = new HashMap<>();
					Set<Long> undonePos = new HashSet<>();
					for (Entry e : l) {
						for (Cell c : e.cells()) {
							if (undo.contains(e.id())) {
								undonePos.add(c.pos());
							}
							Long tl = topLayer.get(c.pos());
							if (tl == null || c.layer() > tl || c.layer() == tl && e.id().compareTo(top.get(c.pos()).id()) > 0) {
								topLayer.put(c.pos(), c.layer());
								top.put(c.pos(), e);
							}
						}
					}
					for (long p : undonePos) {
						Entry t = top.get(p);
						if (t != null && !undo.contains(t.id())) {
							covering.add(t.id());
						}
					}
				}
				planner.add(k, l);
				planned++;
				n++;
			}
			return true;
		}

		public int planned() {
			return planned;
		}

		public int sections() {
			return sections.size();
		}

		public UndoWork work() {
			return new UndoWork(group, at, dim, ids, planner.finish(), covering, sections);
		}
	}

	/**
	 * The commit of an undo (R2): every undone entry UNDONE with what the undo wrote and its hand-downs (per region file), and
	 * every entry that got a hand-down with its new befores. One commit.
	 */
	public static JournalStore.Txn undoTxn(UndoWork w) throws IOException {
		JournalStore s = store();
		boolean handed = w.plan().undos().values().stream().anyMatch(u -> !u.handed().isEmpty());
		JournalStore.Txn t = s.begin().label("R2:" + w.group() + (handed ? "+handed" : ""));
		for (String id : w.ids()) {
			Journal.Undo u = w.plan().undos().get(id);
			JournalStore.Meta m = s.meta(id);
			List<SectionCells> secs = new ArrayList<>();
			for (long k : m.sections()) {
				SectionCells sc = s.section(id, k);
				if (sc != null) {
					secs.add(sc.withWritten(u.written()));
				}
			}
			t.sections(id, secs);
			Map<Long, List<HandDown>> byRegion = new TreeMap<>();
			for (HandDown h : u.handed()) {
				byRegion.computeIfAbsent(Sections.region(Sections.key(h.pos())), k -> new ArrayList<>()).add(h);
			}
			byRegion.forEach((r, hs) -> t.handed(id, r, hs));
			t.status(id, Status.UNDONE, w.group(), w.at());
		}
		for (var e : w.plan().cells().entrySet()) {
			List<SectionCells> secs = new ArrayList<>();
			e.getValue().forEach((k, cells) -> secs.add(SectionCells.of(k, cells, null)));
			t.sections(e.getKey(), secs);
		}
		return t;
	}

	/**
	 * The mask of a restore with holes: the cells of the covering entries (sites that stay on top of an undone cell). Null
	 * without covering entries (no holes: the 4d restore, unchanged).
	 */
	public static java.util.function.@Nullable LongPredicate mask(UndoWork w) throws IOException {
		if (w.covering().isEmpty()) {
			return null;
		}
		JournalStore s = store();
		Map<Long, long[]> bits = new HashMap<>();
		for (String id : w.covering()) {
			JournalStore.Meta m = s.meta(id);
			if (m == null) {
				continue;
			}
			for (long k : m.sections()) {
				if (!near(w.sections(), k)) {
					continue;
				}
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

	private static boolean near(TreeSet<Long> sections, long k) {
		int sx = Sections.sx(k);
		int sy = Sections.sy(k);
		int sz = Sections.sz(k);
		for (int dx = -1; dx <= 1; dx++) {
			for (int dy = -1; dy <= 1; dy++) {
				for (int dz = -1; dz <= 1; dz++) {
					if (sections.contains(Sections.key(sx + dx, sy + dy, sz + dz))) {
						return true;
					}
				}
			}
		}
		return false;
	}

	// ------------------------------------------------------------------ crash tests (DevBridge)

	/** Arms a kill point ({@code K1}..{@code K8}, {@code migrate-before-commit}, {@code migrate-after-commit}); null disarms. */
	public static void killAt(@Nullable String point) {
		killAt = point;
		Architect.LOGGER.warn("World journal: kill point armed: {}", point);
	}

	public static @Nullable String armed() {
		return killAt;
	}

	/** The next commit fails at its first file write (as on a full disk). */
	public static void failNextCommit() {
		failNext = true;
	}

	/** A named step of a change: halts the JVM when it is the armed kill point (no shutdown hooks, nothing saved). */
	public static void kill(String point) {
		if ((point + "+save").equals(killAt)) {
			// TEST (5b "journal wins"): the world's chunks are saved first, as if an autosave had just run, then the halt
			var sv = dev.larattalabs.architect.site.SiteDeltas.serverOrNull();
			if (sv != null) {
				sv.saveAllChunks(true, true, true);
			}
			Architect.LOGGER.error("World journal: kill point {} reached after a save; halting the JVM (dev.journal.killAt)", killAt);
			Runtime.getRuntime().halt(7);
		}
		if (point.equals(killAt)) {
			Architect.LOGGER.error("World journal: kill point {} reached; halting the JVM (dev.journal.killAt)", point);
			Runtime.getRuntime().halt(7);
		}
	}

	/** The store's I/O steps: K1 (a placement's PLACING commit) and K8 (an undo's hand-down commit) halt before the index. */
	private static void ioStep(String step) {
		if (failNext && step.startsWith("write ")) {
			failNext = false;
			throw new IllegalStateException("dev.journal.failNextCommit (a full disk)");
		}
		String k = killAt;
		if (k == null || !step.equals("index")) {
			return;
		}
		String label = writing;
		if (k.equals("K1") && label.startsWith("P3:") || k.equals("D2") && label.startsWith("D3:") || k.equals("K8") && label.startsWith("R2:")
			&& label.contains("+handed")
			|| k.equals("migrate-before-commit") && label.startsWith("migrate")) {
			Architect.LOGGER.error("World journal: kill point {} reached inside commit {}; halting the JVM", k, label);
			Runtime.getRuntime().halt(7);
		}
	}

	// ------------------------------------------------------------------ DevBridge views

	/** The journal as JSON ({@code dev.journal.state}): status, counters, every entry's metadata, the legacy names. Any thread. */
	public static JsonObject json() {
		JsonObject o = new JsonObject();
		JournalStore s = store;
		o.addProperty("open", s != null);
		o.addProperty("unavailable", unavailable());
		if (s == null) {
			return o;
		}
		JournalStore.Index idx = s.index();
		o.addProperty("nextId", idx.nextId());
		o.addProperty("nextLayer", idx.nextLayer());
		o.addProperty("nextRoad", idx.nextRoad());
		o.addProperty("nextCells", idx.nextCells());
		o.addProperty("bytesOnDisk", s.bytesOnDisk());
		o.addProperty("indexBytes", s.indexBytes());
		double[] ms = s.indexCommitMs();
		java.util.Arrays.sort(ms);
		o.addProperty("indexCommits", ms.length);
		o.addProperty("indexCommitP50Ms", ms.length == 0 ? 0 : ms[ms.length / 2]);
		o.addProperty("indexCommitP99Ms", ms.length == 0 ? 0 : ms[Math.min(ms.length - 1, (int) Math.floor(ms.length * 0.99))]);
		o.addProperty("indexCommitMaxMs", ms.length == 0 ? 0 : ms[ms.length - 1]);
		o.addProperty("durable", s.durable() == idx);
		JsonArray es = new JsonArray();
		for (JournalStore.Meta m : idx.entries().values()) {
			JsonObject j = new JsonObject();
			j.addProperty("id", m.id());
			j.addProperty("kind", m.kind());
			j.addProperty("site", m.site());
			if (m.group() != null) {
				j.addProperty("group", m.group());
			}
			j.addProperty("dimension", m.dimension());
			j.addProperty("policy", m.policy().name());
			j.addProperty("layer", m.layer());
			j.addProperty("status", m.status().name());
			j.addProperty("cells", m.cells());
			j.addProperty("sections", m.sections().length);
			if (m.box() != null) {
				JsonArray b = new JsonArray();
				for (int v : m.box()) {
					b.add(v);
				}
				j.add("box", b);
			}
			JsonObject files = new JsonObject();
			m.files().forEach(files::addProperty);
			j.add("files", files);
			if (m.undoGroup() != null) {
				j.addProperty("undoGroup", m.undoGroup());
				j.addProperty("undoneAt", m.undoneAt());
			}
			es.add(j);
		}
		o.add("entries", es);
		JsonObject leg = new JsonObject();
		idx.legacy().forEach(leg::addProperty);
		o.add("legacy", leg);
		JsonArray un = new JsonArray();
		s.unreferenced().forEach(un::add);
		o.add("unreferenced", un);
		return o;
	}

	/** The stack at a cell ({@code dev.journal.at}): every active entry with a cell there, bottom first. Server thread. */
	public static JsonObject at(String dimension, int x, int y, int z) throws IOException {
		long pos = Journal.pos(x, y, z);
		JsonObject o = new JsonObject();
		o.addProperty("pos", x + "," + y + "," + z);
		JsonArray st = new JsonArray();
		for (Layer l : stack(dimension, pos)) {
			JsonObject j = new JsonObject();
			j.addProperty("entry", l.meta().id());
			j.addProperty("kind", l.meta().kind());
			j.addProperty("site", l.meta().site());
			j.addProperty("policy", l.meta().policy().name());
			j.addProperty("status", l.meta().status().name());
			j.addProperty("layer", l.cell().layer());
			j.addProperty("before", l.cell().before().toString());
			j.addProperty("after", l.cell().after() == null ? null : l.cell().after().toString());
			st.add(j);
		}
		o.add("stack", st);
		return o;
	}

	public static @Nullable MinecraftServer server() {
		return server;
	}
}
