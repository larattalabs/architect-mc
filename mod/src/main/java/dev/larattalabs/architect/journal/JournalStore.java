package dev.larattalabs.architect.journal;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Undo;
import dev.larattalabs.architect.journal.Journal.Value;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collection;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import org.jspecify.annotations.Nullable;

/**
 * The world journal on disk (docs/CONTRACT.md "Phase 4e contract", "On disk"). Adapted from AgentCraft
 * {@code dev.agentcraft.journal.JournalStore} at {@code ab08a02}: the commit protocol, generations, read-back and tidy rules
 * are kept; the files are sharded per entry per 512x512 column region, the index gains a section map, and encoding and file
 * I/O run on one journal I/O thread in commit order.
 *
 * <pre>
 * &lt;world&gt;/architect-journal/journal.json         the index (the commit point)
 *                         e/&lt;id&gt;/&lt;rx&gt;.&lt;rz&gt;.&lt;gen&gt;.nbt   an entry's cells in one region ({@link JournalNbt#encode})
 *                         e/&lt;id&gt;/head.&lt;gen&gt;.nbt       its site record and leaf ring
 *                         legacy/                      4d snapshot files after migration
 * </pre>
 *
 * <p><b>Commit protocol</b> (per file): each changed {@code (entry, region)} file is written as its next generation (a
 * {@code .tmp}, an atomic move, a read-back whose cell count must match); then {@code journal.json} is replaced atomically
 * (<b>the commit point</b>); then the superseded generations are deleted. One commit may carry many entries. At open:
 * generations the index doesn't name and {@code .tmp} files are deleted; files of entries the index doesn't know are kept and
 * listed ({@link #unreferenced}).
 *
 * <p><b>Threads.</b> The server thread prepares a commit ({@link Txn}) and {@link #submit}s it: the new state is this
 * store's view at once ({@link #index}, {@link #section}: the files not written yet are pinned in memory), and the I/O
 * thread makes it durable in submit order. The caller never writes a block that depends on a commit before its future has
 * completed. A commit that fails leaves the disk as it was (its new files are leftovers the next open deletes); the view
 * goes back to the last durable state and every commit submitted after it fails too.
 */
public final class JournalStore {
	public static final String DIR = "architect-journal";
	public static final String INDEX = "journal.json";
	public static final String ENTRIES = "e";
	public static final String HEAD = "head";
	public static final int VERSION = 1;
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
	private static final Pattern REGION_FILE = Pattern.compile("(-?\\d+)\\.(-?\\d+)\\.(\\d+)\\.nbt");
	private static final Pattern HEAD_FILE = Pattern.compile("head\\.(\\d+)\\.nbt");

	/**
	 * An entry as the index knows it (no cells). {@code files}: {@code "rx,rz"} (or {@code "head"}) -> generation;
	 * {@code sections}: the section keys it has cells in, ascending; {@code box}: {minX, minY, minZ, maxX, maxY, maxZ}, null
	 * without cells.
	 */
	public record Meta(String id, String kind, String site, @Nullable String group, String dimension, Policy policy, long layer, Status status,
		long createdAt, int cells, int @Nullable [] box, Map<String, Integer> files, long[] sections, @Nullable String undoGroup, long undoneAt) {
		public Meta {
			files = Collections.unmodifiableMap(new LinkedHashMap<>(files));
		}

		public boolean active() {
			return status != Status.UNDONE;
		}

		Meta with(Status s, @Nullable String ug, long at) {
			return new Meta(id, kind, site, group, dimension, policy, layer, s, createdAt, cells, box, files, sections, ug, at);
		}

		public boolean intersects(String dim, int[] b) {
			return box != null && dimension.equals(dim) && box[0] <= b[3] && b[0] <= box[3] && box[1] <= b[4] && b[1] <= box[4] && box[2] <= b[5]
				&& b[2] <= box[5];
		}

		/** A fresh header for {@link Txn#create} (files, sections, cells and box are filled in by the commit). */
		public static Meta header(String id, String kind, String site, @Nullable String group, String dimension, Policy policy, long layer,
			Status status, long createdAt) {
			return new Meta(id, kind, site, group, dimension, policy, layer, status, createdAt, 0, null, Map.of(), new long[0], null, 0L);
		}
	}

	/** The index: entries by id (creation order), the counters, legacy snapshot name -> entry id. Immutable. */
	public record Index(Map<String, Meta> entries, long nextId, long nextLayer, long nextRoad, long nextCells, Map<String, String> legacy) {
		public static final Index EMPTY = new Index(Map.of(), 1, 1, 1, 1, Map.of());
	}

	/** A test and DevBridge hook: called with the name of each I/O step of a commit (a throw there is a fault at that step). */
	public static volatile @Nullable Consumer<String> faultHook;

	private final Path dir;
	private volatile Index head;
	private volatile Index durable;
	private long allocatedId;
	private long allocatedLayer;
	private long allocatedRoad;
	private long allocatedCells;
	private final List<String> unreferenced = new ArrayList<>();
	/** Files written by a submitted commit, not on disk yet: pinned (path -> data). */
	private final Map<Path, Object> pinned = new ConcurrentHashMap<>();
	private final Cache cache;
	/** dimension -> section key -> entry ids with cells there (any status). Server thread. */
	private final Map<String, Long2ObjectOpenHashMap<List<String>>> sectionMap = new HashMap<>();
	private final ExecutorService io;
	private volatile long epoch;
	private volatile boolean closed;
	/** Bytes on disk, roughly (updated at commits): the size warning. */
	private volatile long bytesOnDisk;

	private JournalStore(Path dir, Index index, long cacheBytes) {
		this.dir = dir;
		this.head = index;
		this.durable = index;
		this.allocatedId = index.nextId();
		this.allocatedLayer = index.nextLayer();
		this.allocatedRoad = index.nextRoad();
		this.allocatedCells = index.nextCells();
		this.cache = new Cache(cacheBytes);
		this.io = Executors.newSingleThreadExecutor(r -> {
			Thread t = new Thread(r, "Architect journal I/O");
			t.setDaemon(true);
			return t;
		});
		rebuildSectionMap();
	}

	public static Path dirOf(Path worldDir) {
		return worldDir.resolve(DIR);
	}

	/** Whether the world has a journal index (the migration's "done" marker). */
	public static boolean exists(Path worldDir) {
		return Files.exists(dirOf(worldDir).resolve(INDEX));
	}

	/**
	 * Opens the journal of {@code worldDir} (an empty one when there is no index yet; nothing is written until the first
	 * commit) and tidies its folder. Throws when the index exists but cannot be read: the caller then leaves everything alone
	 * and refuses world changes.
	 */
	public static JournalStore open(Path worldDir, long cacheBytes) throws IOException {
		Path dir = dirOf(worldDir);
		Path f = dir.resolve(INDEX);
		Index idx = Index.EMPTY;
		if (Files.exists(f)) {
			try {
				idx = indexFromJson(JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject());
			} catch (RuntimeException e) {
				throw new IOException(INDEX + " is not a journal index: " + e.getMessage(), e);
			}
		}
		JournalStore s = new JournalStore(dir, idx, cacheBytes);
		s.tidy();
		return s;
	}

	public static JournalStore open(Path worldDir) throws IOException {
		return open(worldDir, 64L << 20);
	}

	/** Stops the I/O thread after the commits submitted so far. */
	public void close() {
		closed = true;
		io.shutdown();
		try {
			io.awaitTermination(60, java.util.concurrent.TimeUnit.SECONDS);
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		}
	}

	/** Waits until every submitted commit is durable (or failed). */
	public void flush() {
		try {
			io.submit(() -> {
			}).get();
		} catch (Exception e) {
			// nothing to wait for
		}
	}

	public Path dir() {
		return dir;
	}

	/** The current view (every submitted commit applied). */
	public Index index() {
		return head;
	}

	/** What is on disk. */
	public Index durable() {
		return durable;
	}

	public List<String> unreferenced() {
		return List.copyOf(unreferenced);
	}

	public long bytesOnDisk() {
		return bytesOnDisk;
	}

	private void tidy() throws IOException {
		Path e = dir.resolve(ENTRIES);
		long bytes = 0;
		if (Files.isDirectory(dir)) {
			try (var list = Files.list(dir)) {
				for (Path p : (Iterable<Path>) list::iterator) {
					if (p.getFileName().toString().endsWith(".tmp")) {
						Files.deleteIfExists(p);
					}
				}
			}
		}
		if (!Files.isDirectory(e)) {
			bytesOnDisk = 0;
			return;
		}
		try (var dirs = Files.list(e)) {
			for (Path d : (Iterable<Path>) dirs::iterator) {
				String id = d.getFileName().toString();
				Meta m = head.entries().get(id);
				if (!Files.isDirectory(d)) {
					continue;
				}
				try (var files = Files.list(d)) {
					for (Path f : (Iterable<Path>) files::iterator) {
						String name = f.getFileName().toString();
						if (name.endsWith(".tmp")) {
							Files.deleteIfExists(f);
							continue;
						}
						if (m == null) {
							unreferenced.add(id + "/" + name);
							continue;
						}
						String key;
						int gen;
						Matcher rm = REGION_FILE.matcher(name);
						Matcher hm = HEAD_FILE.matcher(name);
						if (rm.matches()) {
							key = rm.group(1) + "," + rm.group(2);
							gen = Integer.parseInt(rm.group(3));
						} else if (hm.matches()) {
							key = HEAD;
							gen = Integer.parseInt(hm.group(1));
						} else {
							continue;
						}
						Integer want = m.files().get(key);
						if (want == null || want != gen) {
							Files.deleteIfExists(f); // superseded, or written by a commit that never reached the index
						} else {
							bytes += Files.size(f);
						}
					}
				}
			}
		}
		bytesOnDisk = bytes;
	}

	// ------------------------------------------------------------------ ids and layers

	/** A new entry id ({@code j<n>}), never used by any entry, committed or not. */
	public synchronized String newId() {
		while (true) {
			String id = "j" + allocatedId++;
			if (!head.entries().containsKey(id) && !Files.exists(entryDir(id))) {
				return id;
			}
		}
	}

	/** The next layer (later changes are higher). */
	public synchronized long newLayer() {
		return allocatedLayer++;
	}

	/** A new road site id number ({@code r<n>}); the counter lives in the index, so 0.7.0 can't reuse one. */
	public synchronized long newRoad() {
		return allocatedRoad++;
	}

	/** A new cell site id number ({@code c<n>}). */
	public synchronized long newCells() {
		return allocatedCells++;
	}

	/** Raises the counters to at least these (migration, late import). */
	public synchronized void reserve(long id, long layer) {
		allocatedId = Math.max(allocatedId, id);
		allocatedLayer = Math.max(allocatedLayer, layer);
	}

	// ------------------------------------------------------------------ reads

	public @Nullable Meta meta(String id) {
		return head.entries().get(id);
	}

	public List<Meta> find(Predicate<Meta> p) {
		List<Meta> out = new ArrayList<>();
		for (Meta m : head.entries().values()) {
			if (p.test(m)) {
				out.add(m);
			}
		}
		return out;
	}

	/** The ids of entries (any status) with cells in section {@code key} of {@code dimension}. Server thread. */
	public List<String> inSection(String dimension, long key) {
		Long2ObjectOpenHashMap<List<String>> m = sectionMap.get(dimension);
		List<String> l = m == null ? null : m.get(key);
		return l == null ? List.of() : List.copyOf(l);
	}

	/** Every section key of {@code dimension} that has entries (DevBridge, sync). Server thread. */
	public Set<Long> sectionsOf(String dimension) {
		Long2ObjectOpenHashMap<List<String>> m = sectionMap.get(dimension);
		return m == null ? Set.of() : java.util.Collections.unmodifiableSet(new java.util.HashSet<>(m.keySet()));
	}

	Path entryDir(String id) {
		return dir.resolve(ENTRIES).resolve(id);
	}

	static String regionName(long region) {
		return Sections.rx(region) + "," + Sections.rz(region);
	}

	private Path regionPath(String id, long region, int gen) {
		return entryDir(id).resolve(Sections.rx(region) + "." + Sections.rz(region) + "." + gen + ".nbt");
	}

	private Path headPath(String id, int gen) {
		return entryDir(id).resolve(HEAD + "." + gen + ".nbt");
	}

	/** An entry's region file data (empty when it has none there). */
	public JournalNbt.Region region(String id, long region) throws IOException {
		Meta m = head.entries().get(id);
		if (m == null) {
			throw new IOException("no journal entry " + id);
		}
		Integer gen = m.files().get(regionName(region));
		if (gen == null) {
			return new JournalNbt.Region(region, new TreeMap<>(), List.of());
		}
		return readRegion(id, region, gen, m.layer());
	}

	private JournalNbt.Region readRegion(String id, long region, int gen, long layer) throws IOException {
		Path p = regionPath(id, region, gen);
		Object pin = pinned.get(p);
		if (pin instanceof JournalNbt.Region r) {
			return r;
		}
		JournalNbt.Region r = cache.get(p);
		if (r != null) {
			return r;
		}
		CompoundTag t;
		try {
			t = NbtIo.readCompressed(p, NbtAccounter.unlimitedHeap());
		} catch (IOException ex) {
			// the I/O thread may have moved it from the pins to the disk meanwhile
			Object again = pinned.get(p);
			if (again instanceof JournalNbt.Region rr) {
				return rr;
			}
			throw ex;
		}
		try {
			r = JournalNbt.decode(t, layer);
		} catch (RuntimeException ex) {
			throw new IOException(p.getFileName() + ": " + ex.getMessage(), ex);
		}
		cache.put(p, r);
		return r;
	}

	/** An entry's cells in one section, or null when it has none there. */
	public @Nullable SectionCells section(String id, long key) throws IOException {
		return region(id, Sections.region(key)).sections().get(key);
	}

	/** An entry's head file (its site record when made, and its leaf ring). */
	public JournalNbt.Head head(String id) throws IOException {
		Meta m = head.entries().get(id);
		Integer gen = m == null ? null : m.files().get(HEAD);
		if (gen == null) {
			return JournalNbt.Head.EMPTY;
		}
		Path p = headPath(id, gen);
		Object pin = pinned.get(p);
		if (pin instanceof JournalNbt.Head h) {
			return h;
		}
		try {
			return JournalNbt.decodeHead(NbtIo.readCompressed(p, NbtAccounter.unlimitedHeap()));
		} catch (IOException ex) {
			Object again = pinned.get(p);
			if (again instanceof JournalNbt.Head h) {
				return h;
			}
			throw ex;
		} catch (RuntimeException ex) {
			throw new IOException(p.getFileName() + ": " + ex.getMessage(), ex);
		}
	}

	/**
	 * The entry as a {@link Journal.Entry} limited to section {@code key} (its undo record sliced to it), or null when it has
	 * no cells there.
	 */
	public @Nullable Entry slice(String id, long key) throws IOException {
		Meta m = head.entries().get(id);
		if (m == null) {
			return null;
		}
		JournalNbt.Region r = region(id, Sections.region(key));
		SectionCells s = r.sections().get(key);
		if (s == null) {
			return null;
		}
		Undo undo = null;
		if (m.status() == Status.UNDONE) {
			List<HandDown> handed = new ArrayList<>();
			for (HandDown h : r.handed()) {
				if (Sections.key(h.pos()) == key) {
					handed.add(h);
				}
			}
			undo = new Undo(m.undoGroup() == null ? id : m.undoGroup(), m.undoneAt(), s.writtenMap(), handed);
		}
		return new Entry(id, m.kind(), m.site(), m.dimension(), m.policy(), m.createdAt(), m.status(), s.cells(), undo, null);
	}

	/** The whole entry (every section), for tests, migration checks and small entries. */
	public Entry load(String id) throws IOException {
		Meta m = head.entries().get(id);
		if (m == null) {
			throw new IOException("no journal entry " + id);
		}
		List<Cell> cells = new ArrayList<>();
		Map<Long, Value> written = new LinkedHashMap<>();
		List<HandDown> handed = new ArrayList<>();
		for (String k : m.files().keySet()) {
			if (k.equals(HEAD)) {
				continue;
			}
			String[] xz = k.split(",");
			JournalNbt.Region r = region(id, Sections.region(Integer.parseInt(xz[0]), Integer.parseInt(xz[1])));
			for (SectionCells s : r.sections().values()) {
				cells.addAll(s.cells());
				written.putAll(s.writtenMap());
			}
			handed.addAll(r.handed());
		}
		Undo undo = m.status() == Status.UNDONE ? new Undo(m.undoGroup() == null ? id : m.undoGroup(), m.undoneAt(), written, handed) : null;
		JsonObject meta = head(id).meta();
		return new Entry(id, m.kind(), m.site(), m.dimension(), m.policy(), m.createdAt(), m.status(), cells, undo, meta);
	}

	// ------------------------------------------------------------------ commits

	/** Changes to commit together (one index write). Built on the server thread, then {@link #submit}ted. */
	public final class Txn {
		private final Map<String, Meta> creates = new LinkedHashMap<>();
		private final Map<String, Map<Long, SectionCells>> sections = new LinkedHashMap<>();
		private final Map<String, Map<Long, List<HandDown>>> handed = new LinkedHashMap<>();
		private final Map<String, JournalNbt.Head> heads = new LinkedHashMap<>();
		private final Map<String, Meta> statuses = new LinkedHashMap<>();
		private final Set<String> releases = new java.util.LinkedHashSet<>();
		private final Map<String, String> legacy = new LinkedHashMap<>();
		/** Section keys whose cells go away (an empty section after a transfer). */
		private final Map<String, Set<Long>> drops = new LinkedHashMap<>();
		String label = "";

		/** A new entry with these cells (and its head file). */
		public Txn create(Meta header, Collection<SectionCells> cells, JournalNbt.Head h) {
			creates.put(header.id(), header);
			Map<Long, SectionCells> m = sections.computeIfAbsent(header.id(), k -> new TreeMap<>());
			for (SectionCells s : cells) {
				m.put(s.key, s);
			}
			heads.put(header.id(), h);
			return this;
		}

		/** Replaces an entry's cells in these sections (its other sections are kept). */
		public Txn sections(String id, Collection<SectionCells> cells) {
			Map<Long, SectionCells> m = sections.computeIfAbsent(id, k -> new TreeMap<>());
			for (SectionCells s : cells) {
				if (s.size() == 0) {
					drops.computeIfAbsent(id, k -> new TreeSet<>()).add(s.key);
					m.remove(s.key);
				} else {
					m.put(s.key, s);
				}
			}
			return this;
		}

		/** The hand-downs an undo made, by region (they are stored in that region's file). */
		public Txn handed(String id, long region, List<HandDown> hs) {
			handed.computeIfAbsent(id, k -> new LinkedHashMap<>()).put(region, List.copyOf(hs));
			return this;
		}

		public Txn head(String id, JournalNbt.Head h) {
			heads.put(id, h);
			return this;
		}

		/** A new status (undo group and time for UNDONE; null to clear). */
		public Txn status(String id, Status s, @Nullable String undoGroup, long undoneAt) {
			Meta m = creates.containsKey(id) ? creates.get(id) : head.entries().get(id);
			if (m == null) {
				throw new IllegalArgumentException("no journal entry " + id);
			}
			Meta n = m.with(s, undoGroup, undoneAt);
			if (creates.containsKey(id)) {
				creates.put(id, n);
			} else {
				statuses.put(id, n);
			}
			return this;
		}

		public Txn release(String id) {
			releases.add(id);
			return this;
		}

		public Txn legacy(String oldName, String entryId) {
			legacy.put(oldName, entryId);
			return this;
		}

		public Txn label(String l) {
			label = l;
			return this;
		}

		public boolean isEmpty() {
			return creates.isEmpty() && sections.isEmpty() && handed.isEmpty() && heads.isEmpty() && statuses.isEmpty() && releases.isEmpty()
				&& legacy.isEmpty() && drops.isEmpty();
		}
	}

	public Txn begin() {
		return new Txn();
	}

	/** One file a commit writes. */
	private record Write(Path path, Object data, String id, long layer, int cells) {
	}

	/**
	 * Submits a commit: the view changes now, the I/O thread writes it (new generations, read back, then the index, then the
	 * superseded files go). The future completes when it is durable, or fails (then the view is back to the durable state).
	 * Server thread.
	 */
	public synchronized CompletableFuture<Void> submit(Txn t) {
		if (closed) {
			return CompletableFuture.failedFuture(new IOException("the journal is closed"));
		}
		Index base = head;
		Map<String, Meta> metas = new LinkedHashMap<>(base.entries());
		List<Write> writes = new ArrayList<>();
		List<Path> superseded = new ArrayList<>();
		Set<String> changed = new java.util.HashSet<>();
		try {
			Set<String> ids = new java.util.LinkedHashSet<>();
			ids.addAll(t.creates.keySet());
			ids.addAll(t.sections.keySet());
			ids.addAll(t.handed.keySet());
			ids.addAll(t.heads.keySet());
			ids.addAll(t.statuses.keySet());
			ids.addAll(t.drops.keySet());
			for (String id : ids) {
				if (t.releases.contains(id)) {
					continue;
				}
				Meta m = t.creates.containsKey(id) ? t.creates.get(id) : t.statuses.containsKey(id) ? t.statuses.get(id) : metas.get(id);
				if (m == null) {
					throw new IOException("no journal entry " + id);
				}
				boolean fresh = t.creates.containsKey(id);
				Map<String, Integer> files = new LinkedHashMap<>(fresh ? Map.of() : metas.get(id).files());
				TreeSet<Long> secs = new TreeSet<>();
				if (!fresh) {
					for (long k : metas.get(id).sections()) {
						secs.add(k);
					}
				}
				int cells = fresh ? 0 : metas.get(id).cells();
				int[] box = fresh || metas.get(id).box() == null ? null : metas.get(id).box().clone();
				// the regions it changes
				Map<Long, Map<Long, SectionCells>> byRegion = new TreeMap<>();
				for (SectionCells s : t.sections.getOrDefault(id, Map.of()).values()) {
					byRegion.computeIfAbsent(Sections.region(s.key), k -> new TreeMap<>()).put(s.key, s);
				}
				for (long k : t.drops.getOrDefault(id, Set.of())) {
					byRegion.computeIfAbsent(Sections.region(k), x -> new TreeMap<>());
				}
				for (long r : t.handed.getOrDefault(id, Map.of()).keySet()) {
					byRegion.computeIfAbsent(r, x -> new TreeMap<>());
				}
				for (var rt : byRegion.entrySet()) {
					long region = rt.getKey();
					String name = regionName(region);
					Integer gen = files.get(name);
					JournalNbt.Region old = gen == null ? new JournalNbt.Region(region, new TreeMap<>(), List.of()) : readRegion(id, region, gen, m.layer());
					TreeMap<Long, SectionCells> ns = new TreeMap<>(old.sections());
					for (long k : t.drops.getOrDefault(id, Set.of())) {
						if (Sections.region(k) == region) {
							ns.remove(k);
						}
					}
					ns.putAll(rt.getValue());
					List<HandDown> hs = t.handed.getOrDefault(id, Map.of()).getOrDefault(region, old.handed());
					if (m.status() != Status.UNDONE && !t.handed.getOrDefault(id, Map.of()).containsKey(region)) {
						hs = List.of(); // a reactivated entry drops its undo record
					}
					JournalNbt.Region nr = new JournalNbt.Region(region, ns, hs);
					cells += nr.cells() - old.cells();
					for (long k : old.sections().keySet()) {
						secs.remove(k);
					}
					secs.addAll(ns.keySet());
					for (SectionCells s : rt.getValue().values()) {
						box = grow(box, s);
					}
					int ng = gen == null ? 1 : gen + 1;
					if (gen != null) {
						superseded.add(regionPath(id, region, gen));
					}
					if (ns.isEmpty() && hs.isEmpty()) {
						files.remove(name);
					} else {
						files.put(name, ng);
						writes.add(new Write(regionPath(id, region, ng), nr, id, m.layer(), nr.cells()));
					}
				}
				JournalNbt.Head h = t.heads.get(id);
				if (h != null) {
					Integer gen = files.get(HEAD);
					int ng = gen == null ? 1 : gen + 1;
					if (gen != null) {
						superseded.add(headPath(id, gen));
					}
					files.put(HEAD, ng);
					writes.add(new Write(headPath(id, ng), h, id, m.layer(), -1));
				}
				long[] sa = new long[secs.size()];
				int i = 0;
				for (long k : secs) {
					sa[i++] = k;
				}
				metas.put(id, new Meta(m.id(), m.kind(), m.site(), m.group(), m.dimension(), m.policy(), m.layer(), m.status(), m.createdAt(), cells, box,
					files, sa, m.undoGroup(), m.undoneAt()));
				changed.add(id);
			}
			for (String id : t.releases) {
				Meta was = metas.remove(id);
				if (was != null) {
					for (var f : was.files().entrySet()) {
						if (f.getKey().equals(HEAD)) {
							superseded.add(headPath(id, f.getValue()));
						} else {
							String[] xz = f.getKey().split(",");
							superseded.add(regionPath(id, Sections.region(Integer.parseInt(xz[0]), Integer.parseInt(xz[1])), f.getValue()));
						}
					}
					changed.add(id);
				}
			}
		} catch (IOException e) {
			return CompletableFuture.failedFuture(e);
		}
		Map<String, String> leg = new LinkedHashMap<>(base.legacy());
		leg.putAll(t.legacy);
		leg.values().removeIf(id -> !metas.containsKey(id));
		Index next = new Index(Collections.unmodifiableMap(metas), Math.max(base.nextId(), allocatedId), Math.max(base.nextLayer(), allocatedLayer),
			Math.max(base.nextRoad(), allocatedRoad), Math.max(base.nextCells(), allocatedCells), Collections.unmodifiableMap(leg));
		for (Write w : writes) {
			pinned.put(w.path(), w.data());
		}
		head = next;
		for (String id : changed) {
			updateSectionMap(id, base.entries().get(id), next.entries().get(id));
		}
		long myEpoch = epoch;
		CompletableFuture<Void> f = new CompletableFuture<>();
		String label = t.label;
		io.execute(() -> {
			WorldJournal.writing = label;
			try {
				if (epoch != myEpoch) {
					throw new IOException("an earlier journal commit failed");
				}
				write(writes, next, superseded);
				f.complete(null);
			} catch (Throwable ex) {
				fail(myEpoch, writes, ex, label);
				f.completeExceptionally(ex);
			}
		});
		return f;
	}

	private static int[] grow(int @Nullable [] box, SectionCells s) {
		int[] b = box == null ? new int[] {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE,
			Integer.MIN_VALUE} : box;
		for (int k = 0; k < s.size(); k++) {
			long p = s.pos(k);
			b[0] = Math.min(b[0], Journal.x(p));
			b[1] = Math.min(b[1], Journal.y(p));
			b[2] = Math.min(b[2], Journal.z(p));
			b[3] = Math.max(b[3], Journal.x(p));
			b[4] = Math.max(b[4], Journal.y(p));
			b[5] = Math.max(b[5], Journal.z(p));
		}
		return b;
	}

	/** The I/O thread's part of a commit. */
	private void write(List<Write> writes, Index next, List<Path> superseded) throws IOException {
		long added = 0;
		for (Write w : writes) {
			step("write " + w.path().getFileName());
			Files.createDirectories(w.path().getParent());
			Path tmp = w.path().resolveSibling(w.path().getFileName() + ".tmp");
			CompoundTag tag = w.data() instanceof JournalNbt.Region r ? JournalNbt.encode(w.id(), r, w.layer()) : JournalNbt.encodeHead(w.id(),
				(JournalNbt.Head) w.data());
			NbtIo.writeCompressed(tag, tmp);
			step("move " + w.path().getFileName());
			Files.move(tmp, w.path(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
			step("read back " + w.path().getFileName());
			CompoundTag back = NbtIo.readCompressed(w.path(), NbtAccounter.unlimitedHeap());
			if (w.data() instanceof JournalNbt.Region) {
				int n = JournalNbt.decode(back, w.layer()).cells();
				if (n != w.cells()) {
					throw new IOException("read back " + n + " of " + w.cells() + " cells of " + w.id());
				}
			}
			added += Files.size(w.path());
		}
		step("index");
		writeIndex(next);
		durable = next;
		quietStep("committed"); // past the commit point: a halt here is a test kill; nothing can fail the commit any more
		for (Write w : writes) {
			Object d = pinned.remove(w.path());
			if (d instanceof JournalNbt.Region r) {
				cache.put(w.path(), r);
			}
		}
		long removed = 0;
		for (Path p : superseded) {
			try {
				if (Files.exists(p)) {
					removed += Files.size(p);
				}
				Files.deleteIfExists(p);
				cache.remove(p);
				if (Files.isDirectory(p.getParent())) {
					try (var l = Files.list(p.getParent())) {
						if (l.findAny().isEmpty()) {
							Files.deleteIfExists(p.getParent());
						}
					}
				}
			} catch (IOException e) {
				// a leftover the next open deletes
			}
		}
		quietStep("deleted");
		bytesOnDisk = Math.max(0, bytesOnDisk + added - removed);
	}

	private static void step(String name) throws IOException {
		Consumer<String> h = faultHook;
		if (h != null) {
			try {
				h.accept(name);
			} catch (RuntimeException e) {
				throw new IOException("injected fault at " + name, e);
			}
		}
	}

	private static void quietStep(String name) {
		try {
			step(name);
		} catch (IOException e) {
			// after the commit point
		}
	}

	/** A commit failed on the I/O thread: the view goes back to the durable state; later commits fail. */
	private synchronized void fail(long myEpoch, List<Write> writes, Throwable ex, String label) {
		for (Write w : writes) {
			pinned.remove(w.path());
		}
		if (epoch == myEpoch) {
			epoch++;
			head = durable;
			pinned.clear();
			rebuildSectionMap();
			dev.larattalabs.architect.Architect.LOGGER.error("World journal: a commit failed ({}); back to the last durable state", label, ex);
		}
	}

	private void writeIndex(Index idx) throws IOException {
		Files.createDirectories(dir);
		Path f = dir.resolve(INDEX);
		Path tmp = dir.resolve(INDEX + ".tmp");
		String json = GSON.toJson(indexToJson(idx));
		Files.writeString(tmp, json, StandardCharsets.UTF_8);
		Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		if (json.length() > 16 << 20) {
			dev.larattalabs.architect.Architect.LOGGER.warn("World journal: the index is {} MB", json.length() >> 20);
		}
	}

	// ------------------------------------------------------------------ the section map

	private synchronized void rebuildSectionMap() {
		sectionMap.clear();
		for (Meta m : head.entries().values()) {
			updateSectionMap(m.id(), null, m);
		}
	}

	private void updateSectionMap(String id, @Nullable Meta was, @Nullable Meta now) {
		if (was != null) {
			Long2ObjectOpenHashMap<List<String>> m = sectionMap.get(was.dimension());
			if (m != null) {
				for (long k : was.sections()) {
					List<String> l = m.get(k);
					if (l != null) {
						l.remove(id);
						if (l.isEmpty()) {
							m.remove(k);
						}
					}
				}
			}
		}
		if (now != null) {
			Long2ObjectOpenHashMap<List<String>> m = sectionMap.computeIfAbsent(now.dimension(), d -> new Long2ObjectOpenHashMap<>());
			for (long k : now.sections()) {
				List<String> l = m.get(k);
				if (l == null) {
					l = new ArrayList<>(2);
					m.put(k, l);
				}
				if (!l.contains(id)) {
					l.add(id);
				}
			}
		}
	}

	// ------------------------------------------------------------------ the cache

	/** An LRU cache of decoded region files, by approximate size. */
	private static final class Cache {
		private final long max;
		private long size;
		private final LinkedHashMap<Path, JournalNbt.Region> map = new LinkedHashMap<>(64, 0.75f, true);

		Cache(long max) {
			this.max = Math.max(1 << 20, max);
		}

		synchronized JournalNbt.@Nullable Region get(Path p) {
			return map.get(p);
		}

		synchronized void put(Path p, JournalNbt.Region r) {
			JournalNbt.Region was = map.put(p, r);
			if (was != null) {
				size -= was.weight();
			}
			size += r.weight();
			var it = map.entrySet().iterator();
			while (size > max && it.hasNext()) {
				var e = it.next();
				if (e.getValue() == r) {
					continue;
				}
				size -= e.getValue().weight();
				it.remove();
			}
		}

		synchronized void remove(Path p) {
			JournalNbt.Region was = map.remove(p);
			if (was != null) {
				size -= was.weight();
			}
		}
	}

	// ------------------------------------------------------------------ index JSON

	static String sectionsB64(long[] keys) {
		ByteBuffer b = ByteBuffer.allocate(keys.length * 8);
		for (long k : keys) {
			b.putLong(k);
		}
		return Base64.getEncoder().encodeToString(b.array());
	}

	static long[] sectionsFrom(String s) {
		byte[] a = Base64.getDecoder().decode(s);
		ByteBuffer b = ByteBuffer.wrap(a);
		long[] out = new long[a.length / 8];
		for (int i = 0; i < out.length; i++) {
			out[i] = b.getLong();
		}
		Arrays.sort(out);
		return out;
	}

	static JsonObject indexToJson(Index idx) {
		JsonObject o = new JsonObject();
		o.addProperty("version", VERSION);
		o.addProperty("nextId", idx.nextId());
		o.addProperty("nextLayer", idx.nextLayer());
		o.addProperty("nextRoad", idx.nextRoad());
		o.addProperty("nextCells", idx.nextCells());
		JsonArray es = new JsonArray();
		for (Meta m : idx.entries().values()) {
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
			j.addProperty("createdAt", m.createdAt());
			j.addProperty("cells", m.cells());
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
			j.addProperty("sections", sectionsB64(m.sections()));
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
		return o;
	}

	static Index indexFromJson(JsonObject o) {
		if (o.get("version") == null || o.get("version").getAsInt() != VERSION) {
			throw new IllegalArgumentException("unknown journal version " + o.get("version"));
		}
		Map<String, Meta> metas = new LinkedHashMap<>();
		for (JsonElement el : o.getAsJsonArray("entries")) {
			JsonObject j = el.getAsJsonObject();
			int[] box = null;
			if (j.get("box") instanceof JsonArray b && b.size() == 6) {
				box = new int[6];
				for (int i = 0; i < 6; i++) {
					box[i] = b.get(i).getAsInt();
				}
			}
			Map<String, Integer> files = new LinkedHashMap<>();
			if (j.get("files") instanceof JsonObject fo) {
				fo.entrySet().forEach(e -> files.put(e.getKey(), e.getValue().getAsInt()));
			}
			Meta m = new Meta(j.get("id").getAsString(), j.get("kind").getAsString(), j.get("site").getAsString(),
				j.has("group") ? j.get("group").getAsString() : null, j.get("dimension").getAsString(), Policy.valueOf(j.get("policy").getAsString()),
				j.get("layer").getAsLong(), Status.valueOf(j.get("status").getAsString()), j.get("createdAt").getAsLong(), j.get("cells").getAsInt(), box,
				files, j.has("sections") ? sectionsFrom(j.get("sections").getAsString()) : new long[0],
				j.has("undoGroup") ? j.get("undoGroup").getAsString() : null, j.has("undoneAt") ? j.get("undoneAt").getAsLong() : 0L);
			metas.put(m.id(), m);
		}
		Map<String, String> legacy = new LinkedHashMap<>();
		if (o.get("legacy") instanceof JsonObject leg) {
			leg.entrySet().forEach(e -> legacy.put(e.getKey(), e.getValue().getAsString()));
		}
		return new Index(Collections.unmodifiableMap(metas), o.get("nextId").getAsLong(), o.get("nextLayer").getAsLong(),
			o.has("nextRoad") ? o.get("nextRoad").getAsLong() : 1, o.has("nextCells") ? o.get("nextCells").getAsLong() : 1,
			Collections.unmodifiableMap(legacy));
	}

	/** The cells of {@code cells} grouped by section (ascending), as {@link SectionCells} without an undo record. */
	public static List<SectionCells> bySection(Collection<Cell> cells) {
		TreeMap<Long, List<Cell>> by = new TreeMap<>();
		for (Cell c : cells) {
			by.computeIfAbsent(Sections.key(c.pos()), k -> new ArrayList<>()).add(c);
		}
		List<SectionCells> out = new ArrayList<>(by.size());
		by.forEach((k, l) -> out.add(SectionCells.of(k, l, null)));
		return out;
	}
}
