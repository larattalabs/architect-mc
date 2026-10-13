package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.AdoptResult;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BuildConsent;
import dev.larattalabs.architect.api.BuildState;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.SiteEvents;
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
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placed.Builds;
import dev.larattalabs.architect.placed.BuildViews;
import dev.larattalabs.architect.placed.Placed;
import dev.larattalabs.architect.placed.PlacedChunk;
import dev.larattalabs.architect.placed.TrackingRule;
import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.placement.TemplateGrid;
import it.unimi.dsi.fastutil.longs.Long2IntOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.function.LongPredicate;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.ByteArrayTag;
import net.minecraft.nbt.ByteTag;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.DoubleTag;
import net.minecraft.nbt.FloatTag;
import net.minecraft.nbt.IntArrayTag;
import net.minecraft.nbt.IntTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.LongArrayTag;
import net.minecraft.nbt.LongTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.ShortTag;
import net.minecraft.nbt.StringTag;
import net.minecraft.nbt.Tag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jspecify.annotations.Nullable;

/**
 * Adopting a player's build as a site (docs/CONTRACT.md "Phase 6c slice PT2"): its cells are captured as version 1 of a new library
 * entry with a captured source, and a site stands on them <b>without a block written</b>; the journal holds one {@code adopt} entry
 * whose {@code before} equals its {@code after}. The build stays a build, {@code ADOPTED}, linked to the site. A remove (or undo)
 * of the site un-adopts: its deltas are undone as any site's, the {@code adopt} entry is released (never undone: a BOX undo would
 * write its befores over the player's later edits), the record goes, the build returns to its prior state, and the entry is trashed
 * when it has one version. Server thread throughout.
 */
public final class Adopt {
	/** The journal entry kind of an adoption. */
	public static final String KIND = WorldJournal.ADOPT;
	/** The site ext key the mod sets last ({@code {build, entry, at}}); it marks a site as adopted. */
	public static final String EXT_KEY = "architect_mc:adopted";
	/** The detail of an adopted entry's place or check (N-PT2-2), at the start of the refusal's message. */
	public static final String PLACED_ELSEWHERE = "placed_elsewhere";
	public static final int MAX_X = 96;
	public static final int MAX_Y = 64;
	public static final int MAX_Z = 96;
	public static final int MAX_CELLS = 262_144;
	/** Captured in one tick up to this many cells; above, sliced with change tracking (4e's capture). */
	public static final int SYNC_CELLS = 50_000;
	/** A sliced capture re-reads what changed; one that cannot settle in this many passes fails SITE_BUSY (temporary). */
	public static final int PASSES = 3;
	/** Inventories are never captured (a copy could duplicate items); the world's container keeps them. */
	static final List<String> INVENTORY_KEYS = List.of("Items", "Item", "RecordItem", "Book");
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();
	private static final Gson PRETTY = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	private Adopt() {
	}

	public static void init() {
		// registered after Sites' and the build index's own SERVER_STARTED listeners (Placed.init and Sites.init run first): both are loaded
		ServerLifecycleEvents.SERVER_STARTED.register(Adopt::repair);
		ServerTickEvents.END_SERVER_TICK.register(Adopt::tick);
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
			for (Job j : JOBS) {
				j.stop();
				j.future.completeExceptionally(new ArchitectRefused(Reason.WORLD_STOPPED, "the world stopped while " + j.buildId + " was captured"));
			}
			JOBS.clear();
		});
	}

	// ------------------------------------------------------------------ what is adopted

	/** Whether a site is an adopted build's (the mod's ext key). */
	public static boolean isAdopted(@Nullable Site b) {
		return b != null && b.ext() != null && b.ext().get(EXT_KEY) instanceof JsonObject;
	}

	/** Whether a library entry's blueprint JSON is an adopted entry's (never placed elsewhere, never polished). */
	public static boolean isAdoptedEntry(@Nullable JsonObject json) {
		return json != null && (json.get("adopted") instanceof JsonObject || "captured".equals(str(json, "sourceKind")));
	}

	/** The adopted build id a site stands on, or null. */
	public static @Nullable String buildOf(@Nullable Site b) {
		return isAdopted(b) && b.ext().getAsJsonObject(EXT_KEY).get("build") instanceof JsonPrimitive p ? p.getAsString() : null;
	}

	private static @Nullable String str(JsonObject o, String k) {
		return o.get(k) instanceof JsonPrimitive p && p.isString() ? p.getAsString() : null;
	}

	// ------------------------------------------------------------------ the checks (§5) and the cells (§3)

	/** The cells a capture reads: positions, their kind (build cell, the placers' incidental cell, column air) and the counts. */
	static final class Cells {
		final LongArrayList pos = new LongArrayList();
		/** 0: a tracked cell of the build; 1: an incidental cell of one of its placers; 2: a column's air (column fill). */
		final it.unimi.dsi.fastutil.bytes.ByteArrayList kind = new it.unimi.dsi.fastutil.bytes.ByteArrayList();
		int minX = Integer.MAX_VALUE;
		int minY = Integer.MAX_VALUE;
		int minZ = Integer.MAX_VALUE;
		int maxX = Integer.MIN_VALUE;
		int maxY = Integer.MIN_VALUE;
		int maxZ = Integer.MIN_VALUE;
		int skipped;

		void add(long p, byte k) {
			pos.add(p);
			kind.add(k);
			int x = BlockPos.getX(p);
			int y = BlockPos.getY(p);
			int z = BlockPos.getZ(p);
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			minZ = Math.min(minZ, z);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
			maxZ = Math.max(maxZ, z);
		}

		int size() {
			return pos.size();
		}

		Anchors.Bounds box() {
			return new Anchors.Bounds(minX, minY, minZ, maxX, maxY, maxZ);
		}
	}

	/** One check's refusal (§5): thrown as {@link ArchitectRefused} with the detail. */
	static ArchitectRefused refused(Reason r, String message, String detail) {
		return new ArchitectRefused(r, message, detail);
	}

	/**
	 * The checks of §5 in order (first refusal wins: the journal and the world, tracking, the build and its state, the consent, the
	 * chunks, the cells' owners, the size, {@code ext}) and the cells to capture. Throws {@link ArchitectRefused}. Never writes.
	 */
	static Plan check(MinecraftServer server, String buildId, @Nullable BuildConsent consent, @Nullable JsonObject ext) {
		if (server.isStopped() || !server.isRunning()) {
			throw new ArchitectRefused(Reason.WORLD_STOPPED, "the world is stopping");
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			throw new ArchitectRefused(Reason.JOURNAL_UNAVAILABLE, why);
		}
		if (!TrackingRule.on) {
			throw refused(Reason.ADOPT_REFUSED, "player tracking is off (the world rule architect.playerTracking): builds can't be adopted", "tracking_off");
		}
		Builds.Info b = buildId == null ? null : Builds.info(buildId);
		if (b == null || b.state() == BuildState.RELEASED) {
			throw refused(Reason.ADOPT_REFUSED, (b == null ? "no build " + buildId : b.id() + " is released") + ": claim it first (/architect build claim, "
				+ "Sites.claimBuild), then adopt the build", "not_a_build");
		}
		if (b.state() == BuildState.PROVISIONAL) {
			throw refused(Reason.ADOPT_REFUSED, b.id() + " is provisional (a player is still building it): wait for its promotion (BUILD_CHANGED) or claim it",
				"provisional");
		}
		if (b.state() == BuildState.ADOPTED) {
			throw refused(Reason.ADOPT_REFUSED, b.id() + " is already adopted as " + b.siteId(), "already_adopted");
		}
		// the consent: it names the build, it has an actor, the actor placed 10% of it or holds permission 2
		if (consent == null) {
			throw refused(Reason.ADOPT_REFUSED, "adopting " + b.id() + " needs a consent naming it with the asking player as actor", "consent");
		}
		boolean names = false;
		for (String id : consent.buildIds()) {
			names |= b.id().equals(Builds.resolve(id));
		}
		if (!names) {
			throw refused(Reason.ADOPT_REFUSED, "the consent does not name " + b.id(), "consent");
		}
		if (consent.actor() == null) {
			throw refused(Reason.ADOPT_REFUSED, "the consent has no actor (the player asking)", "consent");
		}
		if (!BuildViews.consent(server, consent, false).allows(b.id())) {
			throw refused(Reason.ADOPT_REFUSED, "the actor " + consent.actor() + " placed less than 10% of " + b.id() + " and is not an op (permission 2)",
				"consent");
		}
		ServerLevel level = Sites.levelOf(server, b.dimension());
		if (level == null) {
			throw new ArchitectRefused(Reason.NOT_LOADED, b.id() + "'s dimension " + b.dimension() + " is not loaded");
		}
		int[] bb = b.bounds();
		List<String> unloaded = new ArrayList<>();
		for (int cx = bb[0] >> 4; cx <= bb[3] >> 4; cx++) {
			for (int cz = bb[2] >> 4; cz <= bb[5] >> 4; cz++) {
				if (level.getChunkSource().getChunkNow(cx, cz) == null) {
					unloaded.add(cx + "," + cz);
				}
			}
		}
		if (!unloaded.isEmpty()) {
			throw new ArchitectRefused(Reason.NOT_LOADED, "chunks of " + b.id() + " are not loaded: " + String.join("; ", unloaded.subList(0, Math.min(8,
				unloaded.size()))) + (unloaded.size() > 8 ? " and " + (unloaded.size() - 8) + " more" : ""));
		}
		// the build's tracked cells and the column spans
		String dim = b.dimension();
		Set<UUID> placers = b.placers().keySet();
		Long2IntOpenHashMap low = new Long2IntOpenHashMap();
		Long2IntOpenHashMap high = new Long2IntOpenHashMap();
		Long2ObjectOpenHashMap<Byte> tracked = new Long2ObjectOpenHashMap<>(); // pos -> 0 (the build's) or 1 (a placer's incidental cell)
		for (int cx = bb[0] >> 4; cx <= bb[3] >> 4; cx++) {
			for (int cz = bb[2] >> 4; cz <= bb[5] >> 4; cz++) {
				LevelChunk ch = level.getChunkSource().getChunkNow(cx, cz);
				PlacedChunk pc = ch == null ? null : ch.getAttached(Placed.TYPE);
				if (pc == null) {
					continue;
				}
				for (int sy : pc.sectionYs()) {
					int[] cells = pc.cells(sy);
					for (int i = 0; i < cells.length; i += 2) {
						int idx = cells[i];
						int v = cells[i + 1];
						int x = (cx << 4) + (idx & 15);
						int y = (sy << 4) + (idx >> 8);
						int z = (cz << 4) + (idx >> 4 & 15);
						long p = BlockPos.asLong(x, y, z);
						String lb = pc.build(PlacedChunk.buildOf(v));
						if (lb != null && b.id().equals(Builds.resolve(lb))) {
							tracked.put(p, Byte.valueOf((byte) 0));
							long col = BlockPos.asLong(x, 0, z);
							low.put(col, low.containsKey(col) ? Math.min(low.get(col), y) : y);
							high.put(col, high.containsKey(col) ? Math.max(high.get(col), y) : y);
						} else if (lb == null && placers.contains(pc.placer(PlacedChunk.placerOf(v)))) {
							tracked.put(p, Byte.valueOf((byte) 1));
						}
					}
				}
			}
		}
		if (low.isEmpty()) {
			throw refused(Reason.ADOPT_REFUSED, b.id() + " has no tracked cells loaded", "not_a_build");
		}
		// the owners: a tracked cell of the build owned by a journal entry refuses; owned air, fill and incidental cells are void
		Owned owned = new Owned(dim);
		Map<String, Integer> overlap = new TreeMap<>();
		for (var e : tracked.long2ObjectEntrySet()) {
			if (e.getValue() == 0) {
				String site = owned.site(e.getLongKey());
				if (site != null) {
					overlap.merge(site, 1, Integer::sum);
				}
			}
		}
		if (!overlap.isEmpty()) {
			List<String> l = new ArrayList<>();
			overlap.forEach((s, n) -> l.add(Sites.describe(s) + " (" + n + " cell" + (n == 1 ? "" : "s") + ")"));
			throw new ArchitectRefused(Reason.OVERLAP, b.id() + "'s blocks are owned by " + String.join(", ", l) + ": remove those first");
		}
		// the size: the bounds and the cells the capture reads (the column spans)
		int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE, maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
		long span = 0;
		for (var e : low.long2IntEntrySet()) {
			int x = BlockPos.getX(e.getLongKey());
			int z = BlockPos.getZ(e.getLongKey());
			int y0 = e.getIntValue();
			int y1 = high.get(e.getLongKey());
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z);
			maxZ = Math.max(maxZ, z);
			minY = Math.min(minY, y0);
			maxY = Math.max(maxY, y1);
			span += y1 - y0 + 1;
		}
		int sx = maxX - minX + 1;
		int sy = maxY - minY + 1;
		int sz = maxZ - minZ + 1;
		if (sx > MAX_X || sy > MAX_Y || sz > MAX_Z || span > MAX_CELLS) {
			throw new ArchitectRefused(Reason.TOO_LARGE, b.id() + " is " + sx + "x" + sy + "x" + sz + " with " + span + " cells to capture (at most " + MAX_X + "x"
				+ MAX_Y + "x" + MAX_Z + " and " + MAX_CELLS + " cells)");
		}
		if (ext != null) {
			String bad = dev.larattalabs.architect.apiimpl.FieldLimits.adoptExt(ext);
			if (bad != null) {
				throw new ArchitectRefused(Reason.FIELD_LIMIT, bad);
			}
		}
		// the cells: per column, the build's cells, the placers' incidental cells and the air between its lowest and highest build cell
		Cells c = new Cells();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		List<Long> cols = new ArrayList<>(low.keySet());
		cols.sort(Comparator.<Long>comparingInt(k -> BlockPos.getZ(k)).thenComparingInt(k -> BlockPos.getX(k)));
		for (long col : cols) {
			int x = BlockPos.getX(col);
			int z = BlockPos.getZ(col);
			for (int y = low.get(col); y <= high.get(col); y++) {
				long p = BlockPos.asLong(x, y, z);
				Byte k = tracked.get(p);
				if (k != null && k == 0) {
					c.add(p, (byte) 0);
				} else if (k != null) {
					if (owned.site(p) != null) {
						c.skipped++;
					} else {
						c.add(p, (byte) 1);
					}
				} else if (level.getBlockState(m.set(x, y, z)).isAir() && owned.site(p) == null) {
					c.add(p, (byte) 2);
				} else {
					c.skipped++; // natural, a fluid, another player's or another build's block, an owned air cell: void
				}
			}
		}
		return new Plan(level, b, c, consent, ext);
	}

	/** Which site owns a position (the top active non-guard entry's), read section by section through the journal's masks. */
	static final class Owned {
		final String dim;
		final Map<Long, List<Object[]>> bySection = new HashMap<>();

		Owned(String dim) {
			this.dim = dim;
		}

		@Nullable String site(long p) {
			JournalStore s = WorldJournal.storeOrNull();
			if (s == null) {
				return null;
			}
			long key = Sections.key(p);
			List<Object[]> l = bySection.computeIfAbsent(key, k -> {
				List<Object[]> out = new ArrayList<>();
				for (String id : s.inSection(dim, k)) {
					JournalStore.Meta mt = s.meta(id);
					if (mt == null || !mt.active() || mt.kind().equals(WorldJournal.LEAVES)) {
						continue;
					}
					try {
						SectionCells sc = s.section(id, k);
						if (sc != null) {
							out.add(new Object[] {mt, sc});
						}
					} catch (IOException e) {
						throw new ArchitectRefused(Reason.JOURNAL_UNAVAILABLE, "journal entry " + id + " can't be read: " + e.getMessage());
					}
				}
				return out;
			});
			int idx = Sections.index(p);
			String best = null;
			long layer = Long.MIN_VALUE;
			for (Object[] o : l) {
				SectionCells sc = (SectionCells) o[1];
				int j = sc.find(idx);
				if (j >= 0 && sc.layer(j) > layer) {
					layer = sc.layer(j);
					best = ((JournalStore.Meta) o[0]).site();
				}
			}
			return best;
		}
	}

	/** What the checks found: the build, the cells, the request. */
	record Plan(ServerLevel level, Builds.Info build, Cells cells, BuildConsent consent, @Nullable JsonObject ext) {
	}

	// ------------------------------------------------------------------ the capture (one tick, or sliced with change tracking)

	/** A sliced capture in progress (more than {@link #SYNC_CELLS} cells). */
	static final class Job {
		final Plan plan;
		final String buildId;
		final @Nullable String owner;
		final CompletableFuture<AdoptResult> future;
		final Value[] values;
		final @Nullable CompoundTag[] nbt;
		final ChangeTracker tracker;
		final Long2IntOpenHashMap index = new Long2IntOpenHashMap();
		int cursor;
		int pass = 1;
		long[] pending = new long[0];
		int pendingCursor;

		Job(Plan plan, @Nullable String owner, CompletableFuture<AdoptResult> future) {
			this.plan = plan;
			this.buildId = plan.build().id();
			this.owner = owner;
			this.future = future;
			int n = plan.cells().size();
			this.values = new Value[n];
			this.nbt = new CompoundTag[n];
			for (int i = 0; i < n; i++) {
				index.put(plan.cells().pos.getLong(i), i);
			}
			LongOpenHashSet secs = new LongOpenHashSet();
			for (int i = 0; i < n; i++) {
				secs.add(Sections.key(plan.cells().pos.getLong(i)));
			}
			this.tracker = ChangeTracker.start(plan.level(), secs);
		}

		void stop() {
			tracker.stop();
		}
	}

	private static final List<Job> JOBS = new ArrayList<>();

	/** The ongoing sliced captures (tests, the dev hooks). */
	public static int jobs() {
		return JOBS.size();
	}

	/**
	 * A sliced capture's settle rule, pure: after pass {@code pass} the changed cells must be re-read; they are read in the commit's
	 * tick when at most {@code sync} of them changed (the capture then equals a one-tick capture taken then), else another pass
	 * reads them over ticks; past {@code passes} passes the capture fails SITE_BUSY. Returns "commit", "again" or "busy".
	 */
	public static String settle(int pass, int changed, int sync, int passes) {
		if (changed <= sync) {
			return "commit";
		}
		return pass >= passes ? "busy" : "again";
	}

	private static void tick(MinecraftServer server) {
		if (JOBS.isEmpty()) {
			return;
		}
		for (Job j : List.copyOf(JOBS)) {
			try {
				if (step(server, j)) {
					JOBS.remove(j);
				}
			} catch (ArchitectRefused e) {
				j.stop();
				JOBS.remove(j);
				j.future.completeExceptionally(e);
			} catch (RuntimeException e) {
				j.stop();
				JOBS.remove(j);
				Architect.LOGGER.error("PT2: the capture of {} failed", j.buildId, e);
				j.future.completeExceptionally(new ArchitectRefused(Reason.OTHER, "the capture of " + j.buildId + " failed: " + e));
			}
		}
	}

	/** One tick of a sliced capture; true when it finished (committed or failed). */
	private static boolean step(MinecraftServer server, Job j) {
		Cells c = j.plan.cells();
		ServerLevel level = j.plan.level();
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		if (j.cursor < c.size()) {
			int end = Math.min(c.size(), j.cursor + SYNC_CELLS);
			for (; j.cursor < end; j.cursor++) {
				read(level, j, j.cursor, m);
			}
			if (j.cursor < c.size()) {
				return false;
			}
		}
		if (j.pendingCursor < j.pending.length) {
			int end = Math.min(j.pending.length, j.pendingCursor + SYNC_CELLS);
			for (; j.pendingCursor < end; j.pendingCursor++) {
				int i = j.index.getOrDefault(j.pending[j.pendingCursor], -1);
				if (i >= 0) {
					read(level, j, i, m);
				}
			}
			if (j.pendingCursor < j.pending.length) {
				return false;
			}
		}
		long[] changed = j.tracker.drain();
		String s = settle(j.pass, changed.length, SYNC_CELLS, PASSES);
		if (s.equals("busy")) {
			j.stop();
			j.future.completeExceptionally(new ArchitectRefused(Reason.SITE_BUSY, j.buildId + " kept changing while it was captured (" + changed.length
				+ " cells after " + PASSES + " passes): try again"));
			return true;
		}
		if (s.equals("again")) {
			j.pass++;
			j.pending = changed;
			j.pendingCursor = 0;
			return false;
		}
		for (long p : changed) {
			int i = j.index.getOrDefault(p, -1);
			if (i >= 0) {
				read(level, j, i, m);
			}
		}
		j.stop();
		try {
			j.future.complete(commit(server, j.plan, j.owner, j.values, j.nbt));
		} catch (ArchitectRefused e) {
			j.future.completeExceptionally(e);
		}
		return true;
	}

	private static void read(ServerLevel level, Job j, int i, BlockPos.MutableBlockPos m) {
		m.set(j.plan.cells().pos.getLong(i));
		BlockState s = level.getBlockState(m);
		j.values[i] = WorldJournal.value(s);
		j.nbt[i] = s.hasBlockEntity() ? captured(WorldJournal.beNbt(level, m)) : null;
	}

	/** A block entity's data as captured: without inventories (a copy could never duplicate items), without its position. */
	public static @Nullable CompoundTag captured(@Nullable CompoundTag nbt) {
		if (nbt == null) {
			return null;
		}
		CompoundTag t = nbt.copy();
		for (String k : INVENTORY_KEYS) {
			t.remove(k);
		}
		t.remove("x");
		t.remove("y");
		t.remove("z");
		return t;
	}

	/**
	 * Adopts {@code buildId} (§2): the checks, the capture (one tick, or sliced over ticks with change tracking), then the commit. The
	 * future completes on the server thread; refusals complete it exceptionally with {@link ArchitectRefused}.
	 */
	public static CompletableFuture<AdoptResult> adopt(MinecraftServer server, String buildId, @Nullable String owner, @Nullable BuildConsent consent,
		@Nullable JsonObject ext) {
		CompletableFuture<AdoptResult> f = new CompletableFuture<>();
		try {
			Plan p = check(server, buildId, consent, ext);
			if (p.cells().size() > SYNC_CELLS) {
				JOBS.add(new Job(p, owner, f));
				return f;
			}
			int n = p.cells().size();
			Value[] values = new Value[n];
			CompoundTag[] nbt = new CompoundTag[n];
			BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
			for (int i = 0; i < n; i++) {
				m.set(p.cells().pos.getLong(i));
				BlockState s = p.level().getBlockState(m);
				values[i] = WorldJournal.value(s);
				nbt[i] = s.hasBlockEntity() ? captured(WorldJournal.beNbt(p.level(), m)) : null;
			}
			f.complete(commit(server, p, owner, values, nbt));
		} catch (ArchitectRefused e) {
			f.completeExceptionally(e);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("PT2: adopting {} failed", buildId, e);
			f.completeExceptionally(new ArchitectRefused(Reason.OTHER, "adopting " + buildId + " failed: " + e));
		}
		return f;
	}

	// ------------------------------------------------------------------ the commit: entry, site, journal, build (§2 steps 3-5)

	/** The frame (§3): the front, the entrance's lower half (or null), whether it was guessed. */
	record Frame(Direction front, @Nullable BlockPos door, boolean guessed) {
	}

	/**
	 * The frame: of the build's entrances the one lowest in the build and nearest its footprint edge (ties by position); its front
	 * is the side of the footprint it opens to. With none, the longest side facing the open side, guessed (SQ-PT2-1).
	 */
	static Frame frame(ServerLevel level, Builds.Info b, Cells c) {
		LongOpenHashSet cols = new LongOpenHashSet();
		for (int i = 0; i < c.size(); i++) {
			if (c.kind.getByte(i) == 0) {
				long p = c.pos.getLong(i);
				cols.add(BlockPos.asLong(BlockPos.getX(p), 0, BlockPos.getZ(p)));
			}
		}
		BlockPos best = null;
		long bestKey = Long.MAX_VALUE;
		for (long[] e : b.entrances()) {
			BlockPos p = BlockPos.of(e[0]);
			int edge = Math.min(Math.min(p.getX() - c.minX, c.maxX - p.getX()), Math.min(p.getZ() - c.minZ, c.maxZ - p.getZ()));
			long key = ((long) (p.getY() - c.minY) << 40) | ((long) Math.max(0, edge) << 32) | (p.asLong() & 0xffffffffL);
			if (best == null || key < bestKey || key == bestKey && p.asLong() < best.asLong()) {
				best = p;
				bestKey = key;
			}
		}
		if (best != null) {
			// the side it opens to: of the four, the one whose neighbour column is outside the footprint (nearest the edge first)
			Direction out = null;
			int outDist = Integer.MAX_VALUE;
			for (Direction d : Direction.Plane.HORIZONTAL) {
				long n = BlockPos.asLong(best.getX() + d.getStepX(), 0, best.getZ() + d.getStepZ());
				if (cols.contains(n)) {
					continue;
				}
				int dist = switch (d) {
					case NORTH -> best.getZ() - c.minZ;
					case SOUTH -> c.maxZ - best.getZ();
					case WEST -> best.getX() - c.minX;
					default -> c.maxX - best.getX();
				};
				if (dist < outDist) {
					out = d;
					outDist = dist;
				}
			}
			if (out == null) {
				out = nearestEdge(best, c);
			}
			return new Frame(out, best, false);
		}
		// guessed: the longer horizontal axis; of its two sides, the more open one (air outside it at the lowest row)
		boolean alongX = c.maxX - c.minX >= c.maxZ - c.minZ;
		Direction a = alongX ? Direction.NORTH : Direction.WEST;
		Direction bside = alongX ? Direction.SOUTH : Direction.EAST;
		return new Frame(open(level, c, bside) >= open(level, c, a) ? bside : a, null, true);
	}

	private static Direction nearestEdge(BlockPos p, Cells c) {
		int[] d = {p.getZ() - c.minZ, c.maxX - p.getX(), c.maxZ - p.getZ(), p.getX() - c.minX};
		Direction[] ds = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};
		int k = 0;
		for (int i = 1; i < 4; i++) {
			if (d[i] < d[k]) {
				k = i;
			}
		}
		return ds[k];
	}

	/** How many air cells lie just outside a side of the box at its lowest row. */
	private static int open(ServerLevel level, Cells c, Direction side) {
		int n = 0;
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		if (side.getAxis() == Direction.Axis.Z) {
			int z = side == Direction.NORTH ? c.minZ - 1 : c.maxZ + 1;
			for (int x = c.minX; x <= c.maxX; x++) {
				n += level.getBlockState(m.set(x, c.minY, z)).isAir() ? 1 : 0;
			}
		} else {
			int x = side == Direction.WEST ? c.minX - 1 : c.maxX + 1;
			for (int z = c.minZ; z <= c.maxZ; z++) {
				n += level.getBlockState(m.set(x, c.minY, z)).isAir() ? 1 : 0;
			}
		}
		return n;
	}

	/** A block state as the capture's palette string ({@code ns:name[k=v,...]}, the block's own property order). */
	static String stateString(BlockState s) {
		return dev.larattalabs.architect.library.Schematics.stateString(s);
	}

	/** A new entry id ({@code adopted_<8 hex of a random UUID>}), unused in the library and its folder. */
	static String newEntryId() {
		for (int i = 0; i < 100; i++) {
			String id = "adopted_" + UUID.randomUUID().toString().replace("-", "").substring(0, 8);
			if (Blueprints.entry(id) == null && !Files.exists(Blueprints.userDir().resolve(id))) {
				return id;
			}
		}
		throw new IllegalStateException("no free entry id");
	}

	private static AdoptResult commit(MinecraftServer server, Plan p, @Nullable String owner, Value[] values, @Nullable CompoundTag[] nbt) {
		ServerLevel level = p.level();
		Builds.Info b = p.build();
		// the build may have changed state while a sliced capture ran
		Builds.Info now = Builds.info(b.id());
		if (now == null || now.state() != BuildState.ACTIVE && now.state() != BuildState.CLAIMED) {
			throw refused(Reason.ADOPT_REFUSED, b.id() + " changed while it was captured (" + (now == null ? "gone" : now.state().name().toLowerCase(Locale.ROOT))
				+ ")", now != null && now.state() == BuildState.ADOPTED ? "already_adopted" : "not_a_build");
		}
		Cells c = p.cells();
		Frame fr = frame(level, b, c);
		int sx = c.maxX - c.minX + 1;
		int sy = c.maxY - c.minY + 1;
		int sz = c.maxZ - c.minZ + 1;
		int groundY = fr.door() != null ? fr.door().getY() - c.minY : 0;
		long at = System.currentTimeMillis();
		String entryId = newEntryId();
		String siteId = Sites.newSiteId();
		String kindName = b.kind().name().toLowerCase(Locale.ROOT);
		String name = "Adopted " + kindName + " " + b.id();
		// the entry's files (version 1): the template, the part map, the captured source, the blueprint JSON
		Path dir = Blueprints.userDir().resolve(entryId);
		Path tmp = Blueprints.userDir().resolve("." + entryId + ".tmp");
		Counts counts = new Counts();
		try {
			Files.createDirectories(tmp);
			Entry e = entryFiles(entryId, name, b, c, values, nbt, fr, groundY, at, counts);
			NbtIo.writeCompressed(e.template(), tmp.resolve(entryId + ".nbt"));
			NbtIo.writeCompressed(e.parts(), tmp.resolve(entryId + ".parts.nbt"));
			Files.writeString(tmp.resolve(entryId + ".mjs"), e.source(), StandardCharsets.UTF_8);
			Files.writeString(tmp.resolve(entryId + Blueprints.SIDECAR_SUFFIX), PRETTY.toJson(e.json()) + "\n", StandardCharsets.UTF_8);
			Files.move(tmp, dir, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException ex) {
			deleteQuietly(tmp);
			throw new ArchitectRefused(Reason.OTHER, "the adopted entry " + entryId + " could not be written: " + ex.getMessage());
		}
		Blueprints.reload(server);
		Blueprints.Entry entry = Blueprints.entry(entryId);
		if (entry == null) {
			trash(server, entryId, dir);
			throw new ArchitectRefused(Reason.OTHER, "the adopted entry " + entryId + " did not load: " + String.join("; ", Blueprints.lastProblems()));
		}
		// the site record: BUILT, rotation none, box = the cells' bounds, no approach, no crate, every cell unpaid (no construction)
		Anchors.Bounds box = c.box();
		JsonObject sext = new JsonObject();
		if (p.ext() != null) {
			p.ext().entrySet().forEach(x -> sext.add(x.getKey(), x.getValue().deepCopy()));
		}
		JsonObject mark = new JsonObject();
		mark.addProperty("build", b.id());
		mark.addProperty("entry", entryId);
		mark.addProperty("at", at);
		sext.add(EXT_KEY, mark); // set last: it wins over a caller's key of the same name
		Map<String, Anchor> anchors = new LinkedHashMap<>();
		entry.blueprint().anchors().forEach((k, a) -> anchors.put(k, new Anchor(k, a.x() + box.minX(), a.y() + box.minY(), a.z() + box.minZ(), a.yaw(), a
			.pitch())));
		Site.Pin pin = Sites.pinFor(TemplateGrid.of(entry), 0);
		int[] origin = {box.minX(), box.minY(), box.minZ()};
		Site.Versioning v = new Site.Versioning(1, List.of(new Site.History(1, at, "placed", null, origin, true)), 0, 0);
		Site site = new Site(siteId, entryId, "none", box, box, anchors, at, b.dimension(), null, Sites.journalName(siteId), null, pin, null, owner, sext,
			null, false, v);
		// the journal: one adopt entry, BOX, before == after == the world as captured (block states only: inventories stay the world's),
		// no pt member (nothing is written, so no record changes); its files are written as version 4 (an older mod refuses them)
		JournalStore js;
		try {
			js = WorldJournal.store();
		} catch (IOException ex) {
			trash(server, entryId, dir);
			throw new ArchitectRefused(Reason.JOURNAL_UNAVAILABLE, ex.getMessage());
		}
		String jid = js.newId();
		long layer = js.newLayer();
		List<Cell> cells = new ArrayList<>(c.size());
		for (int i = 0; i < c.size(); i++) {
			cells.add(new Cell(c.pos.getLong(i), layer, values[i], values[i]));
		}
		JournalStore.Txn t = js.begin().label("adopt:" + siteId);
		t.create(JournalStore.Meta.header(jid, KIND, siteId, null, b.dimension(), Policy.BOX, layer, Status.ACTIVE, at), List.of(), new JournalNbt.Head(site
			.toJson(), new int[0]));
		t.sections(jid, JournalStore.bySection(cells)); // replaces the create's (pt-annotated) sections: an adopt entry carries no pt
		try {
			SiteJournal.await(js.submit(t), "the adoption of " + b.id());
		} catch (Sites.SiteException ex) {
			trash(server, entryId, dir);
			throw new ArchitectRefused(ex.reason(), ex.getMessage());
		}
		Sites.putRecord(server, site);
		if (!Builds.markAdopted(b.id(), siteId)) {
			Architect.LOGGER.warn("PT2: {} changed state while {} was committed; the site stands, the build is repaired at the next start", b.id(), siteId);
		}
		SiteEvents.ADOPTED.invoker().onAdopted(siteId, b.id(), entryId);
		Architect.LOGGER.info("Adopted {} ({}) as site {} (entry {} v1): {} cells ({} air, {} block entities), {} void, front {}{}", b.id(), kindName, siteId,
			entryId, c.size(), counts.air, counts.blockEntities, c.skipped, fr.front().getSerializedName(), fr.guessed() ? " (guessed)" : "");
		return new AdoptResult(siteId, entryId, 1, b.id(), new net.minecraft.world.level.levelgen.structure.BoundingBox(box.minX(), box.minY(), box.minZ(),
			box.maxX(), box.maxY(), box.maxZ()), c.size(), counts.air, counts.blockEntities, c.skipped, fr.front(), fr.guessed());
	}

	static final class Counts {
		int air;
		int blockEntities;
	}

	/** Version 1's files: the template (blocks y, z, x), the part map (one part), the captured source, the blueprint JSON. */
	record Entry(CompoundTag template, CompoundTag parts, String source, JsonObject json) {
	}

	static Entry entryFiles(String entryId, String name, Builds.Info b, Cells c, Value[] values, @Nullable CompoundTag[] nbt, Frame fr, int groundY,
		long at, Counts counts) {
		int sx = c.maxX - c.minX + 1;
		int sy = c.maxY - c.minY + 1;
		int sz = c.maxZ - c.minZ + 1;
		Integer[] order = new Integer[c.size()];
		for (int i = 0; i < order.length; i++) {
			order[i] = i;
		}
		java.util.Arrays.sort(order, Comparator.<Integer>comparingInt(i -> BlockPos.getY(c.pos.getLong(i))).thenComparingInt(i -> BlockPos.getZ(c.pos
			.getLong(i))).thenComparingInt(i -> BlockPos.getX(c.pos.getLong(i))));
		// the template
		Map<String, Integer> palIdx = new LinkedHashMap<>();
		ListTag pal = new ListTag();
		ListTag blocks = new ListTag();
		Map<String, Integer> use = new HashMap<>();
		List<String> palStrings = new ArrayList<>();
		JsonArray runs = new JsonArray();
		JsonObject nbtJson = new JsonObject();
		int[] run = null; // y, z, x0, x1, p
		for (int i : order) {
			long p = c.pos.getLong(i);
			int x = BlockPos.getX(p) - c.minX;
			int y = BlockPos.getY(p) - c.minY;
			int z = BlockPos.getZ(p) - c.minZ;
			BlockState s = WorldJournal.state(values[i]);
			String ss = stateString(s);
			Integer pi = palIdx.get(ss);
			if (pi == null) {
				pi = palIdx.size();
				palIdx.put(ss, pi);
				pal.add(NbtUtils.writeBlockState(s));
				palStrings.add(ss);
			}
			CompoundTag bt = new CompoundTag();
			ListTag pos = new ListTag();
			pos.add(IntTag.valueOf(x));
			pos.add(IntTag.valueOf(y));
			pos.add(IntTag.valueOf(z));
			bt.put("pos", pos);
			bt.putInt("state", pi);
			if (nbt[i] != null) {
				bt.put("nbt", nbt[i]);
				nbtJson.add(x + "," + y + "," + z, tagJson(nbt[i]));
				counts.blockEntities++;
			}
			blocks.add(bt);
			if (s.isAir()) {
				counts.air++;
			} else {
				use.merge(ss, 1, Integer::sum);
			}
			if (run != null && run[0] == y && run[1] == z && run[3] == x - 1 && run[4] == pi) {
				run[3] = x;
			} else {
				if (run != null) {
					for (int k : run) {
						runs.add(k);
					}
				}
				run = new int[] {y, z, x, x, pi};
			}
		}
		if (run != null) {
			for (int k : run) {
				runs.add(k);
			}
		}
		CompoundTag tpl = new CompoundTag();
		tpl.putInt("DataVersion", SharedConstants.getCurrentVersion().dataVersion().version());
		ListTag size = new ListTag();
		size.add(IntTag.valueOf(sx));
		size.add(IntTag.valueOf(sy));
		size.add(IntTag.valueOf(sz));
		tpl.put("size", size);
		tpl.put("palette", pal);
		tpl.put("blocks", blocks);
		tpl.put("entities", new ListTag());
		CompoundTag parts = new CompoundTag();
		ListTag names = new ListTag();
		names.add(StringTag.valueOf("adopted"));
		parts.put("names", names);
		parts.putIntArray("idx", new int[order.length]);
		// the most used non-air state: what an added storey is built of
		String wall = use.entrySet().stream().sorted(Map.Entry.<String, Integer>comparingByValue().reversed().thenComparing(Map.Entry.comparingByKey()))
			.map(Map.Entry::getKey).findFirst().orElse("minecraft:oak_planks");
		// anchors (template coordinates): the entrance just outside the door, the spawn 2 further
		JsonObject anchors = new JsonObject();
		if (fr.door() != null) {
			Direction d = fr.front();
			double ex = fr.door().getX() - c.minX + d.getStepX() + 0.5;
			double ez = fr.door().getZ() - c.minZ + d.getStepZ() + 0.5;
			float yaw = d.getOpposite().toYRot();
			anchors.add("entrance", anchorJson(ex, groundY, ez, yaw));
			anchors.add("spawn", anchorJson(ex + 2 * d.getStepX(), groundY, ez + 2 * d.getStepZ(), yaw));
		}
		JsonObject cap = new JsonObject();
		cap.addProperty("format", 1);
		cap.addProperty("build", b.id());
		cap.addProperty("name", name);
		cap.addProperty("description", "Captured from the player's build " + b.id() + " (" + b.kind().name().toLowerCase(Locale.ROOT) + ")");
		JsonArray sz3 = new JsonArray();
		sz3.add(sx);
		sz3.add(sy);
		sz3.add(sz);
		cap.add("size", sz3);
		cap.addProperty("groundY", groundY);
		cap.addProperty("front", fr.front().getSerializedName());
		cap.addProperty("frameGuessed", fr.guessed());
		JsonArray pj = new JsonArray();
		palStrings.forEach(pj::add);
		cap.add("palette", pj);
		cap.add("runs", runs);
		cap.add("nbt", nbtJson);
		cap.addProperty("wall", wall);
		cap.add("anchors", anchors);
		String source = source(entryId, b.id(), at, cap);
		// the blueprint JSON (the kit's sidecar shape for lib/adopt.mjs's build, plus the mod's adopted marker)
		JsonObject j = new JsonObject();
		j.addProperty("id", entryId);
		j.addProperty("name", name);
		j.addProperty("description", cap.get("description").getAsString());
		j.addProperty("type", "adopted");
		JsonArray tags = new JsonArray();
		tags.add("adopted");
		j.add("tags", tags);
		JsonObject size3 = new JsonObject();
		size3.addProperty("x", sx);
		size3.addProperty("y", sy);
		size3.addProperty("z", sz);
		j.add("size", size3);
		j.addProperty("groundY", groundY);
		j.addProperty("front", fr.front().getSerializedName());
		JsonObject frame = new JsonObject();
		JsonArray o = new JsonArray();
		o.add(0);
		o.add(0);
		o.add(0);
		frame.add("origin", o);
		j.add("frame", frame);
		JsonArray mats = new JsonArray();
		use.entrySet().stream().map(e -> blockId(e.getKey())).distinct().forEach(mats::add);
		j.add("materials", mats);
		j.addProperty("foundationBlock", "minecraft:dirt");
		JsonObject ap = new JsonObject();
		ap.addProperty("length", 0);
		ap.addProperty("width", 3);
		j.add("approach", ap);
		j.add("anchors", anchors);
		j.addProperty("source", entryId + ".mjs");
		JsonObject params = new JsonObject();
		JsonObject fl = new JsonObject();
		fl.addProperty("type", "int");
		fl.addProperty("min", 0);
		fl.addProperty("max", 4);
		fl.addProperty("default", 0);
		fl.addProperty("label", "Storeys added on top");
		params.add("floors", fl);
		j.add("params", params);
		JsonObject vals = new JsonObject();
		vals.addProperty("floors", 0);
		j.add("values", vals);
		JsonObject pj2 = new JsonObject();
		JsonObject ad = new JsonObject();
		JsonArray pbox = new JsonArray();
		for (int k : new int[] {0, 0, 0, sx - 1, sy - 1, sz - 1}) {
			pbox.add(k);
		}
		ad.add("box", pbox);
		ad.addProperty("cells", c.size());
		pj2.add("adopted", ad);
		j.add("parts", pj2);
		j.add("profile", new JsonArray());
		j.addProperty("sourceKind", "captured");
		JsonObject adm = new JsonObject();
		adm.addProperty("build", b.id());
		adm.addProperty("at", at);
		adm.addProperty("cells", c.size());
		adm.addProperty("frameGuessed", fr.guessed());
		j.add("adopted", adm);
		j.addProperty("createdAt", at);
		return new Entry(tpl, parts, source, j);
	}

	private static String blockId(String state) {
		int i = state.indexOf('[');
		return i < 0 ? state : state.substring(0, i);
	}

	private static JsonObject anchorJson(double x, double y, double z, float yaw) {
		JsonObject a = new JsonObject();
		a.addProperty("x", x);
		a.addProperty("y", y);
		a.addProperty("z", z);
		a.addProperty("yaw", yaw);
		a.addProperty("pitch", 0);
		return a;
	}

	/** The generated source: kit/lib/adopt.mjs's {@code adopted} over the capture (one int param, {@code floors}: storeys added). */
	static String source(String entryId, String buildId, long at, JsonObject cap) {
		return "// Captured by Architect (6c slice PT2): the player's build " + buildId + ", adopted as " + entryId + " at " + java.time.Instant.ofEpochMilli(
			at) + ".\n" + "// Version 1 is the build as it stood (kit/lib/adopt.mjs). `floors` adds storeys on top; change the build by editing this file.\n"
			+ "import { adopted } from '../lib/adopt.mjs';\n\n" + "export const id = '" + entryId + "';\n" + "export const params = {\n"
			+ "  floors: { type: 'int', min: 0, max: 4, default: 0, label: 'Storeys added on top' },\n" + "};\n\n" + "export const CAPTURE = " + GSON.toJson(
				cap) + ";\n\n" + "export default function build({ floors = 0 } = {}) {\n" + "  return adopted(id, CAPTURE, { floors });\n" + "}\n";
	}

	/** A tag as lib/nbt.mjs's tagged JSON ({t, v}; a long's v as a decimal string; a list's element type as {@code of}). */
	public static JsonObject tagJson(Tag tag) {
		JsonObject o = new JsonObject();
		switch (tag) {
			case CompoundTag c -> {
				o.addProperty("t", "compound");
				JsonObject v = new JsonObject();
				for (String k : new java.util.TreeSet<>(c.keySet())) {
					v.add(k, tagJson(c.get(k)));
				}
				o.add("v", v);
			}
			case ListTag l -> {
				o.addProperty("t", "list");
				String of = "end";
				boolean mixed = false;
				for (Tag e : l) {
					String t = typeName(e);
					if (of.equals("end")) {
						of = t;
					} else if (!of.equals(t)) {
						mixed = true;
					}
				}
				JsonArray v = new JsonArray();
				for (Tag e : l) {
					if (mixed && !(e instanceof CompoundTag)) {
						CompoundTag w = new CompoundTag(); // vanilla's wrapping of a mixed list
						w.put("", e);
						v.add(tagJson(w));
					} else {
						v.add(tagJson(e));
					}
				}
				o.addProperty("of", mixed ? "compound" : of);
				o.add("v", v);
			}
			case ByteTag b -> num(o, "byte", b.value());
			case ShortTag s -> num(o, "short", s.value());
			case IntTag i -> num(o, "int", i.value());
			case LongTag l -> {
				o.addProperty("t", "long");
				o.addProperty("v", Long.toString(l.value()));
			}
			case FloatTag f -> num(o, "float", f.value());
			case DoubleTag d -> num(o, "double", d.value());
			case StringTag s -> {
				o.addProperty("t", "string");
				o.addProperty("v", s.value());
			}
			case ByteArrayTag a -> {
				o.addProperty("t", "byteArray");
				JsonArray v = new JsonArray();
				for (byte x : a.getAsByteArray()) {
					v.add(x);
				}
				o.add("v", v);
			}
			case IntArrayTag a -> {
				o.addProperty("t", "intArray");
				JsonArray v = new JsonArray();
				for (int x : a.getAsIntArray()) {
					v.add(x);
				}
				o.add("v", v);
			}
			case LongArrayTag a -> {
				o.addProperty("t", "longArray");
				JsonArray v = new JsonArray();
				for (long x : a.getAsLongArray()) {
					v.add(Long.toString(x));
				}
				o.add("v", v);
			}
			default -> throw new IllegalArgumentException("unsupported tag " + tag.getClass().getSimpleName());
		}
		return o;
	}

	private static void num(JsonObject o, String t, Number v) {
		o.addProperty("t", t);
		o.addProperty("v", v);
	}

	private static String typeName(Tag t) {
		return switch (t) {
			case CompoundTag c -> "compound";
			case ListTag l -> "list";
			case ByteTag b -> "byte";
			case ShortTag s -> "short";
			case IntTag i -> "int";
			case LongTag l -> "long";
			case FloatTag f -> "float";
			case DoubleTag d -> "double";
			case StringTag s -> "string";
			case ByteArrayTag a -> "byteArray";
			case IntArrayTag a -> "intArray";
			case LongArrayTag a -> "longArray";
			default -> "end";
		};
	}

	/**
	 * (§5) Why the library may not delete an entry now: an adopted entry whose site stands (the site pins it; remove the site first, which
	 * trashes a one-version entry itself). Null: fine. Any thread (a snapshot of the records).
	 */
	public static @Nullable String deleteRefusal(String entryId) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (e == null || !isAdoptedEntry(e.json())) {
			return null;
		}
		for (Site s : Sites.all()) {
			if (entryId.equals(s.blueprint())) {
				return entryId + " is the adopted build standing as " + s.id() + ": remove that site first (the house stays)";
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ capturedChanged (SQ-PT2-3)

	/**
	 * For an adopted entry: how many of version 1's captured cells {@code version} changes or removes, and version 1's cell count
	 * ({@code {capturedChanged, capturedTotal}}); {@code {0, 0}} for any other entry or when a version can't be read. The template
	 * delta (design coordinates, part maps aside), cached by content. Server thread or not (reads files).
	 */
	public static int[] captured(@Nullable MinecraftServer server, String entryId, int version) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (server == null || e == null || !isAdoptedEntry(e.json())) {
			return new int[2];
		}
		Blueprints.Version v1 = Blueprints.version(server, entryId, 1);
		if (v1 == null) {
			return new int[2];
		}
		if (version == 1) {
			return new int[] {0, dev.larattalabs.architect.delta.TemplateDelta.decode(new dev.larattalabs.architect.delta.TemplateDelta.Version(v1.raw(), v1
				.parts(), v1.entry().json())).cells().size()};
		}
		Blueprints.Version vk = Blueprints.version(server, entryId, version);
		if (vk == null) {
			return new int[2];
		}
		dev.larattalabs.architect.delta.TemplateDelta.Result td = SiteDeltas.templateDelta(v1, vk);
		return new int[] {td.removed().size() + td.changed().size(), td.a().cells().size()};
	}

	// ------------------------------------------------------------------ the entry's trash

	/** Moves an entry's folder to {@code architect/library-trash/} and reloads the library. */
	static void trash(MinecraftServer server, String entryId, Path dir) {
		try {
			if (Files.exists(dir)) {
				Path trash = Blueprints.gameDataDir().resolve("library-trash");
				Files.createDirectories(trash);
				Files.move(dir, trash.resolve(entryId + "-" + System.currentTimeMillis()), StandardCopyOption.ATOMIC_MOVE);
				Architect.LOGGER.info("PT2: moved the adopted entry {} to the library trash", entryId);
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("PT2: could not trash {}: {}", entryId, e.toString());
		}
		Blueprints.reload(server);
	}

	private static void deleteQuietly(Path p) {
		try (var s = Files.walk(p)) {
			s.sorted(Comparator.reverseOrder()).forEach(q -> {
				try {
					Files.deleteIfExists(q);
				} catch (IOException ignored) {
					// left
				}
			});
		} catch (IOException ignored) {
			// gone
		}
	}

	// ------------------------------------------------------------------ un-adopt: remove and undo (§6)

	/**
	 * Removes (or undoes) an adopted site (§6): its deltas, crates and held leaves are undone as any site's (a survival site's paid
	 * delta cells refunded; an adopted cell is never the site's to refund or drop), then its {@code adopt} entry is released (never
	 * undone: nothing of the house is written), the record goes, the build returns to its prior state, and the entry goes to the
	 * library trash when it has one version (it stays with two or more, SQ-PT2-5). Server thread.
	 */
	static Sites.Removed remove(ServerLevel level, Site b, boolean force, @Nullable String tagOwner) throws Sites.SiteException {
		MinecraftServer server = level.getServer();
		SiteJournal.requireAvailable();
		List<String> cover = SiteJournal.coveringSites(b.id());
		if (!cover.isEmpty()) {
			throw new Sites.SiteException(Reason.COVERED, cover.size() + " site(s) stand on cells of " + b.id() + " (" + String.join(", ", cover.stream().map(
				Sites::describe).toList()) + "); remove them first");
		}
		List<String> others = new ArrayList<>();
		LongOpenHashSet cells = new LongOpenHashSet();
		JournalStore js = WorldJournal.storeOrNull();
		for (JournalStore.Meta m : SiteJournal.active(b.id())) {
			if (m.kind().equals(KIND)) {
				continue;
			}
			others.add(m.id());
			if (js != null) {
				try {
					for (long k : m.sections()) {
						SectionCells sc = js.section(m.id(), k);
						if (sc != null) {
							for (int i = 0; i < sc.size(); i++) {
								cells.add(sc.pos(i));
							}
						}
					}
				} catch (IOException e) {
					throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "The journal of " + b.id() + " can't be read (" + e.getMessage() + ")");
				}
			}
		}
		Sites.Removed removed;
		if (others.isEmpty()) {
			// adopted, never changed: nothing is written; the entry is released with the record
			Sites.forget(server, b.id());
			removed = new Sites.Removed(b, Map.of());
		} else {
			removed = undoDeltas(level, b, others, cells, force, tagOwner);
		}
		unadopted(server, b);
		dev.larattalabs.architect.apiimpl.ApiEvents.removed(server, removed);
		return removed;
	}

	/** The deltas' undo of an adopted site's removal, then its adopt entry released (the record pending, as a removal's). */
	private static Sites.Removed undoDeltas(ServerLevel level, Site b, List<String> ids, LongOpenHashSet cells, boolean force, @Nullable String tagOwner)
		throws Sites.SiteException {
		MinecraftServer server = level.getServer();
		Anchors.Bounds wb = SiteDeltas.boundsOf(cells);
		if (wb != null) {
			Sites.refusePlayerIn(level, wb, b.id(), "removing it");
		}
		if (!force && wb != null) {
			// what the undo would destroy that the site did not bring, over the cells it writes only (the house is never written)
			Site view = b.withGeometry(b.box(), b.interior(), b.anchors(), wb, b.pin());
			List<String> blockers = Sites.removalBlockers(level, view, tagOwner).stream().filter(s -> !s.contains(" at ") || inCells(s, cells)).toList();
			if (!blockers.isEmpty()) {
				throw new Sites.SiteException(Sites.blockersMessage(b.id(), blockers));
			}
		}
		LongPredicate only = cells::contains;
		Builder.Deconstruction dec = b.construction() != null ? Builder.prepareDeconstruct(level, b, only) : null;
		Sites.Drops drops = Sites.Drops.before(level, wb != null ? wb : b.restoreBox());
		String group = SiteJournal.group(b.id());
		SiteJournal.Undone undone = SiteJournal.undoEntries(level, ids, group);
		SiteJournal.await(undone.commit(), "the removal of " + b.id());
		Sites.markPending(server, b, "removed");
		SiteJournal.Restore r = SiteJournal.writeNow(level, b.id(), group);
		Sites.Removed done = Sites.afterRestore(level, b, dec, drops, force, false, r.ring(), Sites.statsOf(undone.work(), b.id()), Map.of(), List.of(),
			List.of());
		// the adopt entry: released (its blocks stay for good, the house is the player's again)
		JournalStore js = WorldJournal.storeOrNull();
		if (js != null) {
			JournalStore.Txn t = js.begin().label("unadopt:" + b.id());
			for (JournalStore.Meta m : SiteJournal.active(b.id())) {
				if (m.kind().equals(KIND)) {
					t.release(m.id());
				}
			}
			if (!t.isEmpty()) {
				SiteJournal.await(js.submit(t), "the un-adoption of " + b.id());
			}
		}
		return done;
	}

	/** Whether a blocker line ("chest at 1, 2, 3 (...)") names a position among the written cells. */
	private static boolean inCells(String line, LongOpenHashSet cells) {
		java.util.regex.Matcher m = java.util.regex.Pattern.compile(" at (-?\\d+), (-?\\d+), (-?\\d+)").matcher(line);
		return !m.find() || cells.contains(BlockPos.asLong(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))));
	}

	/** After the record went: the build's prior state back, the entry trashed when it has one version. */
	static void unadopted(MinecraftServer server, Site b) {
		String build = buildOf(b);
		if (build != null) {
			Builds.markUnadopted(build, b.id());
		}
		Blueprints.Entry e = Blueprints.entry(b.blueprint());
		if (e != null && e.dir() != null && Blueprints.headVersion(e) <= 1 && EntryVersionsOnDisk.count(e.dir()) <= 1) {
			trash(server, b.blueprint(), e.dir());
		}
		Architect.LOGGER.info("Un-adopted site {} (build {}, entry {}): the house stays", b.id(), build, b.blueprint());
	}

	/** The complete version folders of an entry (a head never bumped counts as one). */
	static final class EntryVersionsOnDisk {
		static int count(Path dir) {
			return Math.max(1, dev.larattalabs.architect.library.EntryVersions.complete(dir).size());
		}
	}

	// ------------------------------------------------------------------ the load-time repair

	/**
	 * At world start, after the sites and the build index are loaded: an ADOPTED build whose site is gone (a stop between the record's
	 * removal and the index's save) returns to its prior state; an adopted site whose build is not ADOPTED by it is linked again (a
	 * stop between the record and the index). Never changes the world.
	 */
	public static void repair(MinecraftServer server) {
		Map<String, String> links = Builds.adoptedLinks();
		for (var e : links.entrySet()) {
			Site s = e.getValue().isEmpty() ? null : Sites.get(e.getValue());
			if (s == null || !e.getKey().equals(Builds.resolve(buildOf(s)))) {
				Architect.LOGGER.info("PT2: {} was adopted by {}, which is gone: un-adopted", e.getKey(), e.getValue());
				Builds.markUnadopted(e.getKey(), null);
			}
		}
		for (Site s : Sites.all()) {
			String build = buildOf(s);
			if (build == null) {
				continue;
			}
			if (!s.id().equals(Builds.adoptedSite(build)) && Builds.markAdopted(build, s.id())) {
				Architect.LOGGER.info("PT2: site {} stands on {}: the build is adopted again", s.id(), build);
			}
		}
	}
}
