package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.CellDiff;
import dev.larattalabs.architect.api.DiagnoseScope;
import dev.larattalabs.architect.api.Diagnosis;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RepairCode;
import dev.larattalabs.architect.api.RepairFinding;
import dev.larattalabs.architect.api.RepairResult;
import dev.larattalabs.architect.api.RepairSuspect;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.WorldJournal;
import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.TagParser;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.status.ChunkStatus;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (DR, docs/CONTRACT.md "Slice DR") Diagnose and repair: an op's roll-forward of cells that lag the journal after a crash. The journal
 * wins for committed operations; DR never reverses a commit, never RECOVERs or reactivates, and never decides by a share of cells. Only
 * {@link RepairCode#LAGGING} cells are written, to their owner's committed value, through the journal's write path
 * ({@link SiteJournal#writeCells}: its flags and FluidRearm), in commit order. A repair is final: its durable record
 * ({@code architect-repairs/<planId>.json}) is written before any write, is the audit trail, and finishes an interrupted repair. After an
 * unclean start the auto-diagnose reads the stuck records and the entries committed after the last completed save, spread over ticks,
 * caches the suspects and posts one line to the ops; it never repairs. Server thread.
 */
public final class Repairs {
	private Repairs() {
	}

	/** At most this many chunks a diagnose call loads (§1); the rest is UNREAD with a continuation. */
	static final int CHUNK_BUDGET = 256;
	/** The auto-diagnose's chunk loads a tick. */
	static final int AUTO_CHUNKS_PER_TICK = 8;
	/** Over this many cells a command's repair asks SAFETY's confirm (run it again within 30 s). */
	static final int LARGE = 2000;
	static final String DIR = "architect-repairs";
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	// ------------------------------------------------------------------ state

	/** One site's part of a diagnosis: its wants, which of them lag, how they read. */
	record Unit(String site, @Nullable String region, boolean stuck, @Nullable String group, List<RepairCore.Want> wants,
		List<RepairCore.Want> lagging, int foreign, List<CellDiff> diffs, List<CellDiff> foreignDiffs, int unread, int taken, String obs) {
	}

	/** A diagnosis with what a repair needs. */
	record Diag(Diagnosis diagnosis, List<Unit> units, List<String[]> custody, long at) {
	}

	private static final Map<String, Diag> PLANS = new LinkedHashMap<>();
	private static volatile List<RepairSuspect> suspects = List.of();
	private static volatile boolean autoPending;
	private static volatile @Nullable String lastOpsLine;
	private static boolean opsLineSent;
	private static int startTicks = -1;
	private static boolean startDone;
	/** The previous run's marker, read before the start overwrites it: its last completed save and the jobs running at it. */
	private static long prevSavedAt = 0;
	private static Set<String> prevJobs = Set.of();
	private static boolean prevUnclean;
	private static long thisStart;
	private static long saveStartedAt;
	private static volatile boolean running;
	private static volatile @Nullable Path world;
	private static @Nullable AutoRun auto;
	/** TEST (kill point DRK1): the next repair halts the JVM after its record is durable and half its cells are written. */
	public static volatile boolean killDRK1;
	/**
	 * (DR2, TEST) A named kill point for the next repair: {@code DRK1pt} halts before its first cell that restores a player's record (P1-4),
	 * {@code DRK2} after its record is final, nothing saved after (P1-1: the durability barrier came first). Null: none.
	 */
	public static volatile @Nullable String killPoint;
	/** (DR2, TEST) The most chunks the auto-diagnose loaded in one tick this session. */
	public static volatile int autoMaxLoads;
	/** (TEST) how many SITE_REPAIRED fired this session, and the last's site and region. */
	public static volatile int repairedEvents;
	public static volatile @Nullable String lastRepairedSite, lastRepairedRegion;

	public static void init() {
		ServerLifecycleEvents.SERVER_STARTED.register(srv -> {
			world = srv.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize();
			startTicks = 0;
			startDone = false;
			running = true;
			opsLineSent = false;
			lastOpsLine = null;
			suspects = List.of();
			autoPending = prevUnclean;
			PLANS.clear();
		});
		ServerTickEvents.END_SERVER_TICK.register(Repairs::tick);
		ServerLifecycleEvents.BEFORE_SAVE.register((srv, flush, force) -> saveStartedAt = System.currentTimeMillis());
		// registered after Stockpiles' AFTER_SAVE (which joins the chunk IO): the save's start time is the conservative bound
		ServerLifecycleEvents.AFTER_SAVE.register((srv, flush, force) -> recordSave(srv));
		ServerLifecycleEvents.SERVER_STOPPING.register(srv -> running = false);
		ServerLifecycleEvents.SERVER_STOPPED.register(srv -> {
			running = false;
			startTicks = -1;
			startDone = false;
			auto = null;
			PLANS.clear();
			suspects = List.of();
			autoPending = false;
			prevUnclean = false;
			world = null;
		});
		ServerPlayConnectionEvents.JOIN.register((h, sender, srv) -> {
			if (!opsLineSent && lastOpsLine != null && op(h.getPlayer())) {
				h.getPlayer().sendSystemMessage(Component.literal(lastOpsLine));
				opsLineSent = true;
			}
		});
		MinedCells.World.init();
		// (DR2, P1-3) a player's break of a journal-owned cell is marked in its chunk (saved with it): later at its pre-op value, it is mined
		net.fabricmc.fabric.api.event.player.PlayerBlockBreakEvents.BEFORE.register((level, player, pos, state, be) -> {
			if (level instanceof ServerLevel sl && !state.isAir() && (SiteJournal.owned(Sites.dimensionId(sl), pos.asLong()) || SiteJournal
				.pendingRemovalStands(Sites.dimensionId(sl), pos.asLong(), state, () -> WorldJournal.beNbt(sl, pos)))) { // (DR2 fix, P1-4) a stuck removal's standing block too
				MinedCells.World.mark(sl, pos, System.currentTimeMillis());
			}
			return true;
		});
		RepairCommands.init();
	}

	/**
	 * (SiteDeltas.atStart, before it rewrites the marker) The previous run's marker: present means an unclean stop; its {@code saved}
	 * line is that run's last completed save, {@code jobs} the sites with a job at it.
	 */
	static void markerAtStart(Path marker, boolean unclean) {
		prevUnclean = unclean;
		prevSavedAt = 0;
		prevJobs = Set.of();
		thisStart = System.currentTimeMillis();
		if (!unclean) {
			return;
		}
		try {
			long start = 0;
			for (String l : Files.readAllLines(marker, StandardCharsets.UTF_8)) {
				l = l.trim();
				if (l.startsWith("saved=")) {
					prevSavedAt = Long.parseLong(l.substring(6));
				} else if (l.startsWith("jobs=")) {
					Set<String> j = new HashSet<>();
					for (String x : l.substring(5).split(",")) {
						if (!x.isBlank()) {
							j.add(x);
						}
					}
					prevJobs = Set.copyOf(j);
				} else if (!l.isEmpty() && Character.isDigit(l.charAt(0))) {
					start = Long.parseLong(l);
				}
			}
			if (prevSavedAt == 0) {
				prevSavedAt = start; // no save completed in that run: what it loaded is what is on disk
			}
		} catch (IOException | RuntimeException e) {
			prevSavedAt = 0; // unreadable: every entry
		}
	}

	/** After a completed save while the world runs: the marker records the save's start and the jobs running then (atomic). */
	private static void recordSave(MinecraftServer srv) {
		Path w = world;
		if (!running || w == null) {
			return;
		}
		Path marker = w.resolve(SiteDeltas.RUNNING_MARKER);
		if (!Files.exists(marker)) {
			return;
		}
		String text = thisStart + "\nsaved=" + saveStartedAt + "\njobs=" + String.join(",", Placement.jobSites(srv)) + "\n";
		try {
			Path tmp = marker.resolveSibling(SiteDeltas.RUNNING_MARKER + ".tmp");
			Files.writeString(tmp, text, StandardCharsets.UTF_8);
			Files.move(tmp, marker, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Repairs: could not record the save in the running marker ({})", e.getMessage());
		}
	}

	/** Whether the start's settles are done: Sites.reconcile, Stockpiles.reconcileAtStart and RS's rescanFree (queued 20 ticks in). */
	public static boolean startDone() {
		return startDone;
	}

	private static void tick(MinecraftServer srv) {
		if (startTicks < 0) {
			return;
		}
		if (!startDone) {
			startTicks++;
			if (startTicks > 21 && RegionTargets.rescanIdle()) {
				startDone = true;
				if (autoPending) {
					auto = new AutoRun(srv);
				}
			}
			return;
		}
		AutoRun a = auto;
		if (a != null && a.step(srv)) {
			auto = null;
			autoPending = false;
		}
	}

	// ------------------------------------------------------------------ diagnose

	/** The world of one dimension as diagnose reads it: loaded chunks, plus loads within {@code budget} (null: never load). */
	static final class LevelReader implements RepairCore.Reader {
		final ServerLevel level;
		final int[] budget;
		final Set<Long> loaded;

		LevelReader(ServerLevel level, int[] budget, Set<Long> loaded) {
			this.level = level;
			this.budget = budget;
			this.loaded = loaded;
		}

		boolean ensure(int cx, int cz) {
			if (level.getChunkSource().getChunkNow(cx, cz) != null) {
				return true;
			}
			if (budget[0] <= 0) {
				return false;
			}
			budget[0]--;
			loaded.add(net.minecraft.world.level.ChunkPos.pack(cx, cz));
			level.getChunk(cx, cz, ChunkStatus.FULL, true);
			return true;
		}

		@Override
		public @Nullable BlockState get(long pos) {
			int cx = Journal.x(pos) >> 4;
			int cz = Journal.z(pos) >> 4;
			if (level.getChunkSource().getChunkNow(cx, cz) == null) {
				return null;
			}
			return level.getBlockState(BlockPos.of(pos));
		}

		@Override
		public @Nullable CompoundTag nbt(long pos) {
			return WorldJournal.beNbt(level, BlockPos.of(pos));
		}

		@Override
		public boolean pt(long pos) {
			return dev.larattalabs.architect.placed.Placed.record(level, BlockPos.of(pos)) != null;
		}

		@Override
		public long mined(long pos) {
			return MinedCells.World.at(level, pos);
		}

		@Override
		public long evicted(long pos) {
			return MinedCells.World.evicted(level, pos);
		}

		/** (DR-S) Whether the cell is a container holding items (never rolled forward: a write would destroy them). */
		boolean holdsItems(long pos) {
			return level.getBlockEntity(BlockPos.of(pos)) instanceof net.minecraft.world.Container c && !c.isEmpty();
		}
	}

	/** The sites a scope names, in a stable order, with their region (from their journal entries' group). */
	static List<String> unitsOf(MinecraftServer srv, DiagnoseScope scope) {
		JournalStore js = WorldJournal.storeOrNull();
		Set<String> out = new LinkedHashSet<>();
		if (js == null) {
			return List.of();
		}
		Set<String> stuck = stuckSites(srv);
		for (JournalStore.Meta m : js.index().entries().values()) {
			if (m.site().startsWith(SiteGroupRec.CRATE_PREFIX)) {
				continue;
			}
			boolean in = switch (scope.kind()) {
				case ALL -> true;
				case SITE -> m.site().equals(scope.id());
				case REGION -> scope.id() != null && scope.id().equals(regionOf(m));
				case HERE -> {
					BlockPos c = scope.center();
					String dim = scope.dimension() == null ? null : scope.dimension().identifier().toString();
					yield c != null && dim != null && m.box() != null && m.intersects(dim, new int[] {(c.getX() >> 4) - 4 << 4, -4096, (c.getZ() >> 4)
						- 4 << 4, ((c.getX() >> 4) + 5 << 4) - 1, 4096, ((c.getZ() >> 4) + 5 << 4) - 1});
				}
			};
			if (in && (m.status() == Journal.Status.ACTIVE || m.status() == Journal.Status.UNDONE && stuck.contains(m.site()))) {
				out.add(m.site());
			}
		}
		List<String> l = new ArrayList<>(out);
		l.sort(String::compareTo);
		return l;
	}

	/** The region a journal entry builds for (its site group's region), or null. */
	static @Nullable String regionOf(JournalStore.Meta m) {
		if (m.group() == null) {
			return null;
		}
		SiteGroupRec g = Sites.group(m.group());
		return g != null && g.ext().has(RegionItems.EXT_REGION) ? g.ext().get(RegionItems.EXT_REGION).getAsString() : null;
	}

	/** The pending records (sites and roads) left after the start's settle with no job in the queue: STUCK (F5). */
	static Set<String> stuckSites(MinecraftServer srv) {
		Set<String> jobs = Placement.jobSites(srv);
		Set<String> out = new LinkedHashSet<>();
		for (Site.Pending p : Sites.pending()) {
			if (!"moved".equals(p.why()) && !jobs.contains(p.site().id()) && !Groups.removing(p.site().id()) && SiteJournal.lastGroup(p.site().id()) != null) {
				out.add(p.site().id());
			}
		}
		for (Infra i : Infras.pendingAll()) {
			if (!jobs.contains(i.id()) && !Groups.removing(i.id()) && SiteJournal.lastGroup(i.id()) != null) {
				out.add(i.id());
			}
		}
		return out;
	}

	/**
	 * Whether a site is RL's: a standing construction site or fed target (its unbuilt cells are its queue, its book RL's reconcile; never
	 * DR's). (DR-S) A pending one (a survival removal) is DR's: its committed removal rolls forward like any, its stored credit booked once.
	 */
	static boolean fed(String id) {
		Site s = Sites.get(id);
		if (s != null) {
			return s.construction() != null;
		}
		Infra i = Infras.get(id);
		return i != null && i.construction() != null;
	}

	/** (DR-S) The credit key of a pending survival record (site or road), or null. */
	static @Nullable String pendingKeyOf(String id) {
		Site s = Sites.pendingRecord(id);
		if (s != null) {
			return s.construction() != null ? Builder.creditKey(s) : null;
		}
		Infra i = Infras.pending(id);
		return i != null && i.construction() != null ? RoadBuilder.creditKey(i) : null;
	}

	/**
	 * (DR-S) Whether a placement entry may lag the world: committed after the last completed save before this start's unclean stop (or with
	 * a job at that save), and before this start. After a clean stop nothing lags, and a placed cell holding its pre-op value later is a
	 * player's mining, never LAGGING (DR's leftover).
	 */
	static boolean mayLag(JournalStore.Meta m) {
		return mayLag(m, prevUnclean, thisStart, prevSavedAt, prevJobs);
	}

	static boolean mayLag(JournalStore.Meta m, boolean unclean, long start, long savedAt, Set<String> jobsAtSave) {
		return unclean && m.createdAt() < start && RepairCore.afterSave(m, savedAt, jobsAtSave);
	}

	/** The wants of one site: a stuck record's committed removal, else its ACTIVE entries' tops. */
	static List<RepairCore.Want> wantsOf(JournalStore js, String site, boolean stuck, @Nullable String group,
		java.util.function.Predicate<JournalStore.Meta> bound) throws IOException {
		if (stuck && group != null) {
			return RepairCore.removalWants(js, site, group);
		}
		List<RepairCore.Want> w = new ArrayList<>();
		for (JournalStore.Meta m : SiteJournal.entries(site)) {
			if (m.status() == Journal.Status.ACTIVE && bound.test(m)) {
				w.addAll(RepairCore.placementWants(js, m));
			}
		}
		return w;
	}

	/** Classifies a unit's wants (every chunk already read). */
	static Unit classify(String site, @Nullable String region, boolean stuck, @Nullable String group, List<RepairCore.Want> wants,
		java.util.function.Function<String, RepairCore.@Nullable Reader> readers) {
		List<RepairCore.Want> lag = new ArrayList<>();
		List<CellDiff> diffs = new ArrayList<>();
		List<CellDiff> fdiffs = new ArrayList<>();
		int foreign = 0;
		int unread = 0;
		int taken = 0;
		boolean survival = stuck && pendingKeyOf(site) != null;
		java.security.MessageDigest md;
		try {
			md = java.security.MessageDigest.getInstance("SHA-256");
		} catch (java.security.NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
		for (RepairCore.Want w : wants) {
			RepairCore.Reader r = readers.apply(w.dim());
			RepairCore.Cell c = r == null ? null : cellOf(r, w, survival);
			if (c == null) {
				unread++; // (DR2) no level, or its chunk not read: never a silent clean
				continue;
			}
			if (c != RepairCore.Cell.OK) {
				// (DR2 fix, should-fix) every lagging and foreign cell as observed (its state, its record, its mark) in the plan id, beyond the
				// first 64 diffs; OK cells change the classification lines when they change (a random tick inside the scope never stales it)
				md.update((w.pos() + "=" + r.get(w.pos()) + "|" + r.pt(w.pos()) + "|" + markOf(r, w.pos()) + ";").getBytes(StandardCharsets.UTF_8));
			}
			// (DR2 round after OVF) taken by its mark alone, whatever the cell reads now (the undo's value, or air over a pre-op block): a repair
			// settles the removal around it, never writes it, and withholds its refund share
			boolean took = c == RepairCore.Cell.FOREIGN && RepairCore.takenAfter(markOf(r, w.pos()), w, survival);
			if (took) {
				taken++;
			}
			if (c == RepairCore.Cell.LAGGING && r instanceof LevelReader lr && lr.holdsItems(w.pos())) {
				c = RepairCore.Cell.FOREIGN; // (DR-S) a container's contents are never written over (custody's rule): a crate or chest with items
			}
			if (c == null || c == RepairCore.Cell.OK) {
				continue;
			}
			CellDiff d = new CellDiff(BlockPos.of(w.pos()), RepairCore.text(w.expected()), RepairCore.text(r.get(w.pos())) + (took ? " (taken by a player)"
				: ""));
			if (c == RepairCore.Cell.LAGGING) {
				lag.add(w);
				if (diffs.size() < 64) {
					diffs.add(d);
				}
			} else {
				foreign++;
				if (fdiffs.size() < 64) {
					fdiffs.add(d);
				}
			}
		}
		StringBuilder obs = new StringBuilder();
		byte[] h = md.digest();
		for (int i = 0; i < 8; i++) {
			obs.append(String.format(java.util.Locale.ROOT, "%02x", h[i]));
		}
		return new Unit(site, region, stuck, group, wants, lag, foreign, diffs, fdiffs, unread, taken, obs.toString());
	}

	/**
	 * A cell's classification for a repair: {@link RepairCore#classify}, then (DR2 fix, P1-4) a survival removal's cell a player broke after
	 * its undo (its placed block, still standing then, taken: the item is the player's) is FOREIGN even where it now holds the undo's value:
	 * the removal never settles while one is there (its stored refund includes that block: booking it would pay it twice).
	 */
	static RepairCore.@Nullable Cell cellOf(RepairCore.Reader r, RepairCore.Want w, boolean survival) {
		RepairCore.Cell c = RepairCore.classify(r, w);
		return c == null ? null : RepairCore.takenSince(c, markOf(r, w.pos()), w, survival);
	}

	/** (DR2 fix) A cell's mark, else its chunk's newest dropped mark (it may have been one of them), else -1. */
	static long markOf(RepairCore.Reader r, long pos) {
		long m = r.mined(pos);
		return m >= 0 ? m : r.evicted(pos);
	}

	/** {@link Sites#diagnose}: read-only, after the start's settles. */
	public static Diagnosis diagnose(MinecraftServer srv, DiagnoseScope scope) {
		return diag(srv, scope).diagnosis();
	}

	static Diag diag(MinecraftServer srv, DiagnoseScope scope) {
		JournalStore js = WorldJournal.storeOrNull();
		String sc = scope.describe() + (scope.kind() == DiagnoseScope.Kind.HERE && scope.center() != null ? " " + scope.center().toShortString() : "");
		if (js == null) {
			Diagnosis d = new Diagnosis(scope, "none", List.of(new RepairFinding(RepairCode.UNREAD, null, null, null, 0, 0, 0, List.of(),
				"The world journal is not open")), 1, null);
			return new Diag(d, List.of(), List.of(), System.currentTimeMillis());
		}
		List<String> ids = unitsOf(srv, scope);
		Set<String> stuck = stuckSites(srv);
		int from = 0;
		if (scope.continuation() != null) {
			try {
				from = Math.max(0, Integer.parseInt(scope.continuation()));
			} catch (NumberFormatException e) {
				from = 0;
			}
		}
		int[] budget = {CHUNK_BUDGET};
		Set<Long> loaded = new HashSet<>();
		Map<String, LevelReader> readers = new LinkedHashMap<>();
		List<Unit> units = new ArrayList<>();
		List<JournalStore.Meta> read = new ArrayList<>();
		List<String> failed = new ArrayList<>();
		int unread = 0;
		String cont = null;
		for (int i = from; i < ids.size(); i++) {
			String id = ids.get(i);
			if (fed(id)) {
				continue; // RL's (one owner): its reconcile at the start settled it
			}
			boolean st = stuck.contains(id);
			String group = st ? SiteJournal.lastGroup(id) : null;
			List<RepairCore.Want> wants;
			try {
				wants = wantsOf(js, id, st, group, Repairs::mayLag);
			} catch (IOException | RuntimeException e) {
				failed.add(id + " (" + e.getMessage() + ")"); // (DR2) a journal read failure is UNREAD, never a false clean
				continue;
			}
			// its chunks, within the budget
			Map<String, Set<Long>> chunks = new LinkedHashMap<>();
			for (RepairCore.Want w : wants) {
				chunks.computeIfAbsent(w.dim(), k -> new LinkedHashSet<>()).add(net.minecraft.world.level.ChunkPos.pack(Journal.x(w.pos()) >> 4, Journal
					.z(w.pos()) >> 4));
			}
			boolean ok = true;
			for (var e : chunks.entrySet()) {
				LevelReader r = readerFor(srv, readers, e.getKey(), budget, loaded);
				if (r == null) {
					continue;
				}
				for (long c : e.getValue()) {
					if (!r.ensure(net.minecraft.world.level.ChunkPos.getX(c), net.minecraft.world.level.ChunkPos.getZ(c))) {
						ok = false;
						break;
					}
				}
				if (!ok) {
					break;
				}
			}
			if (!ok) {
				unread = ids.size() - i;
				cont = Integer.toString(i);
				break;
			}
			read.addAll(SiteJournal.entries(id));
			String region = SiteJournal.entries(id).stream().map(Repairs::regionOf).filter(java.util.Objects::nonNull).findFirst().orElse(null);
			units.add(classify(id, region, st, group, wants, d -> readerFor(srv, readers, d, budget, loaded)));
		}
		List<RepairFinding> findings = new ArrayList<>();
		List<String> lines = new ArrayList<>();
		for (Unit u : units) {
			findingsOf(u, findings, lines);
		}
		stacked(js, units, stuck, findings);
		List<String[]> custody = new ArrayList<>();
		if (scope.kind() == DiagnoseScope.Kind.ALL || scope.kind() == DiagnoseScope.Kind.SITE) {
			ledgerFindings(scope, findings, lines, custody);
		}
		for (String open : openRecords()) {
			findings.add(new RepairFinding(RepairCode.STUCK, null, null, "repair:" + open, 0, 0, 0, List.of(), "Repair " + open
				+ " is open (stopped part way); /architect repair " + sc + " confirm " + open + " finishes it from its record"));
			lines.add("open " + open);
		}
		if (unread > 0) {
			findings.add(new RepairFinding(RepairCode.UNREAD, null, null, null, 0, 0, 0, List.of(), unread + " site(s) not read (the "
				+ CHUNK_BUDGET + "-chunk budget); diagnose again to read on"));
		}
		for (String f : failed) {
			String id = f.substring(0, f.indexOf(' '));
			findings.add(new RepairFinding(RepairCode.UNREAD, id, null, null, 0, 0, 0, List.of(), "Site " + id + "'s journal could not be read "
				+ f.substring(f.indexOf(' ') + 1) + ": not diagnosed (not clean)"));
			lines.add("unread " + f);
		}
		unread += failed.size();
		String planId = RepairCore.planId(sc + "@" + from, js.index(), read, lines);
		Diagnosis d = new Diagnosis(scope, planId, findings, unread, cont);
		Diag dg = new Diag(d, units, custody, System.currentTimeMillis());
		synchronized (PLANS) {
			PLANS.put(planId, dg);
			while (PLANS.size() > 32) {
				PLANS.remove(PLANS.keySet().iterator().next());
			}
		}
		return dg;
	}

	private static @Nullable LevelReader readerFor(MinecraftServer srv, Map<String, LevelReader> readers, String dim, int[] budget, Set<Long> loaded) {
		LevelReader r = readers.get(dim);
		if (r == null) {
			ServerLevel l = Sites.levelOf(srv, dim);
			if (l == null) {
				return null;
			}
			r = new LevelReader(l, budget, loaded);
			readers.put(dim, r);
		}
		return r;
	}

	private static void findingsOf(Unit u, List<RepairFinding> out, List<String> lines) {
		int lag = u.lagging().size();
		lines.add("obs " + u.site() + " " + u.obs()); // (DR2 fix) any change to an observed cell changes the plan id
		if (u.unread() > 0) {
			out.add(new RepairFinding(RepairCode.UNREAD, u.site(), u.region(), null, u.unread(), 0, 0, List.of(), u.site() + ": " + u.unread()
				+ " cell(s) not read (their dimension or chunk unavailable): not diagnosed"));
			lines.add("unread " + u.site() + " " + u.unread());
		}
		StringBuilder cells = new StringBuilder();
		u.lagging().forEach(w -> cells.append(w.pos()).append(','));
		if (u.stuck()) {
			List<CellDiff> all = new ArrayList<>(u.diffs());
			for (CellDiff d : u.foreignDiffs()) {
				if (all.size() < 64) {
					all.add(d);
				}
			}
			out.add(new RepairFinding(RepairCode.STUCK, u.site(), u.region(), null, u.wants().size(), lag, u.foreign(), all, "Removed " + u.site()
				+ " was kept unsettled at the start (a stop before the world saved its restore): " + lag + " of " + u.wants().size()
				+ " cells lag the journal" + (u.foreign() > 0 ? ", " + u.foreign() + " changed since" : "")));
			lines.add("stuck " + u.site() + " " + u.group() + " " + cells + " f" + u.foreign());
		} else if (lag > 0) {
			out.add(new RepairFinding(RepairCode.LAGGING, u.site(), u.region(), null, u.wants().size(), lag, u.foreign(), u.diffs(), message(u)));
			lines.add("lag " + u.site() + " " + cells + " f" + u.foreign());
		}
		if (u.foreign() > 0) {
			out.add(new RepairFinding(RepairCode.FOREIGN, u.site(), u.region(), null, u.foreign(), 0, u.foreign(), u.foreignDiffs(), u.site()
				+ ": " + u.foreign() + " cell(s) hold neither the journal's value nor the operation's pre-op value (players' or the world's): left"
				+ (u.taken() > 0 ? "; " + u.taken() + " of them a player took from the pending removal: a repair settles it around them and "
					+ "withholds their refund share (never paid twice)" : "")));
			StringBuilder f = new StringBuilder();
			u.foreignDiffs().forEach(d -> f.append(d.pos().asLong()).append(':').append(d.found()).append(','));
			lines.add("foreign " + u.site() + " " + f);
		}
	}

	/** The message of a lagging site (§4). */
	static String message(Unit u) {
		return String.format(java.util.Locale.ROOT, "Site %s lags the journal at %,d of %,d cells (a stop before the world saved)%s.", u.site(),
			u.lagging().size(), u.wants().size(), u.foreign() > 0 ? "; " + u.foreign() + " changed since" : "");
	}

	/** (DR2) {@link RepairCore#shadowedBy}, a read failure counted as shadowed (never settled on a guess). */
	static Set<String> shadowed(JournalStore js, String site, String group) {
		try {
			return RepairCore.shadowedBy(js, site, group);
		} catch (IOException e) {
			return Set.of("(journal unreadable: " + e.getMessage() + ")");
		}
	}

	/** (F7) Stuck removals whose boxes share cells: rolled forward top-down in commit order. (DR2) Also one under a newer site. */
	private static void stacked(JournalStore js, List<Unit> units, Set<String> stuck, List<RepairFinding> out) {
		Set<String> seen = new HashSet<>();
		for (Unit u : units) {
			if (!u.stuck()) {
				continue;
			}
			String ug = u.group() != null ? u.group() : SiteJournal.lastGroup(u.site());
			for (String n : ug == null ? Set.<String>of() : shadowed(js, u.site(), ug)) {
				out.add(new RepairFinding(RepairCode.STACKED, u.site(), u.region(), n, 0, 0, 0, List.of(), "Removed " + u.site() + " lies under newer site "
					+ n + " (placed after its removal): its cells there are " + n + "'s, and it stays pending until " + n + " is gone"));
			}
			for (String o : stackedWith(js, u.site(), stuck)) {
				if (!o.equals(u.site()) && seen.add(u.site().compareTo(o) < 0 ? u.site() + "|" + o : o + "|" + u.site())) {
					out.add(new RepairFinding(RepairCode.STACKED, u.site(), u.region(), o, 0, 0, 0, List.of(), u.site() + " and " + o + " were removed "
						+ "over shared cells; a repair rolls them forward top-down, in commit order, and they settle together"));
				}
			}
		}
	}

	/** {@code site} and every stuck removal stacked with it (boxes sharing cells), transitively. */
	static Set<String> stackedWith(JournalStore js, String site, Set<String> stuck) {
		Set<String> comp = new LinkedHashSet<>();
		java.util.ArrayDeque<String> q = new java.util.ArrayDeque<>(List.of(site));
		while (!q.isEmpty()) {
			String x = q.poll();
			if (!comp.add(x)) {
				continue;
			}
			int[] a = boxOf(x);
			for (String o : stuck) {
				int[] b = boxOf(o);
				if (!comp.contains(o) && a != null && b != null && a[0] <= b[3] && b[0] <= a[3] && a[1] <= b[4] && b[1] <= a[4] && a[2] <= b[5]
					&& b[2] <= a[5]) {
					q.add(o);
				}
			}
		}
		return comp;
	}

	private static int @Nullable [] boxOf(String site) {
		String g = SiteJournal.lastGroup(site);
		int[] out = null;
		for (JournalStore.Meta m : g == null ? List.<JournalStore.Meta>of() : SiteJournal.undone(site, g)) {
			int[] b = m.box();
			if (b != null) {
				out = out == null ? b.clone() : new int[] {Math.min(out[0], b[0]), Math.min(out[1], b[1]), Math.min(out[2], b[2]), Math.max(out[3], b[3]),
					Math.max(out[4], b[4]), Math.max(out[5], b[5])};
			}
		}
		return out;
	}

	/** The id a ledger key names ({@code site:s12@123} -> s12), or null. */
	static @Nullable String idOfKey(String key) {
		int c = key.indexOf(':');
		int at = key.lastIndexOf('@');
		return c < 0 || at <= c + 1 ? null : key.substring(c + 1, at);
	}

	/** Whether a key's target is in a record, a pending record, or a queued removal. */
	static boolean known(String key) {
		String id = idOfKey(key);
		if (id == null) {
			return true; // not a target key: not ours to judge
		}
		return Sites.get(id) != null || Sites.pendingRecord(id) != null || Infras.get(id) != null || Infras.pending(id) != null || Groups.removing(
			id);
	}

	/** CUSTODY, PAID_ORPHAN (report only) and (DR-S) BOOK (report only: RL owns it) over every stockpile ledger. */
	private static void ledgerFindings(DiagnoseScope scope, List<RepairFinding> out, List<String> lines, List<String[]> custody) {
		for (var e : new TreeMap<>(Stockpiles.UNRECONCILED).entrySet()) {
			String id = e.getKey();
			if (scope.kind() == DiagnoseScope.Kind.SITE && !id.equals(scope.id()) || Sites.get(id) == null && Infras.get(id) == null) {
				continue;
			}
			String[] v = e.getValue();
			out.add(new RepairFinding(RepairCode.BOOK, id, null, v[1], 0, 0, 0, List.of(), "Fed target " + id + " (" + v[0] + ", " + v[1]
				+ ") was not reconciled at this start (" + v[2] + "): its saved cell book may disagree with the world. Reported only: RL owns it"));
			lines.add("book " + id + " " + v[1]);
		}
		for (Stockpiles.Pile p : Stockpiles.all()) {
			var led = p.ledger();
			for (String key : new java.util.TreeSet<>(led.custodyKeys())) {
				if (scope.kind() == DiagnoseScope.Kind.SITE && !java.util.Objects.equals(idOfKey(key), scope.id())) {
					continue;
				}
				String id = idOfKey(key);
				boolean standing = id != null && Sites.get(id) != null;
				if (standing || led.credited(key) || id != null && (Sites.pendingRecord(id) != null || Groups.removing(id))) {
					continue;
				}
				int n = led.custody(key).values().stream().mapToInt(Integer::intValue).sum();
				out.add(new RepairFinding(RepairCode.CUSTODY, id, null, key, n, 0, 0, List.of(), "Custody " + key + " (" + n
					+ " items) has no standing site, queued removal or credit: a repair credits it under the cap"));
				lines.add("custody " + p.owner() + " " + key + " " + led.custody(key));
				custody.add(new String[] {p.owner(), key});
			}
			if (scope.kind() != DiagnoseScope.Kind.ALL) {
				continue;
			}
			for (String key : new java.util.TreeSet<>(led.paid().keySet())) {
				if (!known(key) && !led.credited(key)) {
					int n = led.paid().get(key).values().stream().mapToInt(Integer::intValue).sum();
					out.add(new RepairFinding(RepairCode.PAID_ORPHAN, idOfKey(key), null, key, n, 0, 0, List.of(), "Paid record " + key + " (" + n
						+ " items) names no record, tombstone or queued removal: reported only"));
					lines.add("orphan " + p.owner() + " " + key);
				}
			}
		}
	}

	// ------------------------------------------------------------------ repair

	/** Why a site can't be repaired now (a job, a queued removal, a revision or adoption in flight), or null. */
	static @Nullable String busy(MinecraftServer srv, String id) {
		if (Placement.jobSites(srv).contains(id)) {
			return id + " has a job in the queue";
		}
		if (Groups.leaving(id) || Groups.removing(id)) {
			return id + "'s removal is queued";
		}
		Placement.Job j = Placement.job(id);
		if (j != null) {
			return id + " has a " + j.kind() + " job";
		}
		String b = Sites.busy(id, Journal.Status.ACTIVE);
		if (b != null) {
			return id + " " + b;
		}
		Site s = Sites.get(id);
		if (s != null) {
			if (s.versioning().updating() > 0 || s.versioning().reverting() > 0) {
				return id + " has a revision in flight";
			}
			String ad = Sites.adoptBusy(s.member() == null ? null : s.member().group());
			if (ad != null) {
				return id + " " + ad;
			}
		}
		return null;
	}

	private static RepairResult refused(String planId, Reason r, String msg) {
		return new RepairResult(planId, false, 0, Map.of(), List.of(), 0, null, r, msg, List.of());
	}

	/** {@link Sites#repair}: a dry run unless {@code apply}; the actor must be an op. */
	public static RepairResult repair(MinecraftServer srv, String planId, @Nullable ServerPlayer actor, boolean apply) {
		if (actor == null || !op(actor)) {
			return refused(planId, Reason.PERMISSION, "A repair needs an operator (gamemaster permission) as its actor");
		}
		if (!startDone) {
			return refused(planId, Reason.SITE_BUSY, "The world is still starting (its settles are not done)");
		}
		Path rec = recordPath(planId);
		if (rec != null && Files.exists(rec)) {
			JsonObject o = readRecord(rec);
			if (o != null && "open".equals(o.has("state") ? o.get("state").getAsString() : "")) {
				return apply ? finishOpen(srv, planId, rec, o, actor) : new RepairResult(planId, false, o.getAsJsonArray("cells").size(), Map.of(),
					List.of(), 0, rec.toString(), null, "Repair " + planId + " is open; confirm finishes it from its record", List.of());
			}
			if (o != null) {
				return refused(planId, Reason.REPAIR_STALE, "Repair " + planId + " is final already (" + rec + ")");
			}
		}
		Diag old;
		synchronized (PLANS) {
			old = PLANS.get(planId);
		}
		if (old == null) {
			return refused(planId, Reason.REPAIR_STALE, "No diagnosis " + planId + " (or it is gone): diagnose again");
		}
		// busy first (a job, a queued removal): SITE_BUSY even when that job has since moved the cells
		for (Unit u : old.units()) {
			String b = u.stuck() || !u.lagging().isEmpty() ? busy(srv, u.site()) : null;
			if (b != null) {
				return refused(planId, Reason.SITE_BUSY, b + "; nothing was written");
			}
		}
		Diag now = diag(srv, old.diagnosis().scope());
		if (!now.diagnosis().planId().equals(planId)) {
			return refused(planId, Reason.REPAIR_STALE, "The cells of " + planId + " changed since its diagnosis (now " + now.diagnosis().planId()
				+ "); nothing was written. Diagnose again");
		}
		List<Unit> todo = now.units().stream().filter(u -> u.stuck() || !u.lagging().isEmpty()).toList();
		for (Unit u : todo) {
			String b = busy(srv, u.site());
			if (b != null) {
				return refused(planId, Reason.SITE_BUSY, b + "; nothing was written");
			}
		}
		int write = todo.stream().mapToInt(u -> u.lagging().size()).sum();
		int left = todo.stream().mapToInt(Unit::foreign).sum();
		Set<String> settles = settling(js(), now.units(), stuckSites(srv));
		Map<String, Integer> credit = new TreeMap<>();
		for (Unit u : todo) {
			if (settles.contains(u.site())) {
				// (DR-S) it books only as the removal settles; (DR2 round after OVF) less its taken cells' share
				Map<String, Integer> share = u.taken() > 0 ? shareOf(u.site(), takenNow(srv, u.site(), u.group())) : Map.of();
				Map<String, Integer> pc = new TreeMap<>(pendingCreditOf(u.site()));
				(share == null ? Map.<String, Integer>of() : share).forEach((k, v) -> pc.computeIfPresent(k, (x, n) -> n - v > 0 ? n - v : null));
				pc.forEach((k, v) -> credit.merge(k, v, Integer::sum));
			}
		}
		for (String[] c : now.custody()) {
			Stockpiles.Pile p = Stockpiles.get(c[0]);
			if (p != null) {
				p.ledger().custody(c[1]).forEach((k, v) -> credit.merge(k, v, Integer::sum));
			}
		}
		List<String> sites = todo.stream().map(Unit::site).toList();
		if (!apply) {
			return new RepairResult(planId, false, write, credit, List.of(), left, null, null, dryMessage(planId, now, todo, write, left), sites);
		}
		// (DR-S) no record when nothing would change: nothing written, nothing credited, no stuck removal able to settle (a stuck removal with
		// players' cells stays pending, and repeating its repair wrote an empty record each time)
		if (write == 0 && credit.isEmpty() && now.custody().isEmpty() && settles.isEmpty()) {
			return new RepairResult(planId, false, 0, Map.of(), List.of(), left, null, null, "Nothing to repair in " + now.diagnosis().scope().describe()
				+ " (" + planId + "); nothing was written", List.of()); // no record: nothing changes
		}
		String off = Stockpiles.savingOff(srv);
		if (off != null) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "Repair " + planId + " refused: " + off + "; nothing was written");
		}
		// the record, durable before any write
		JsonObject o = new JsonObject();
		o.addProperty("planId", planId);
		o.addProperty("state", "open");
		o.addProperty("op", actor.getGameProfile().name());
		o.addProperty("opUuid", actor.getUUID().toString());
		o.addProperty("scope", now.diagnosis().scope().describe());
		o.addProperty("at", System.currentTimeMillis());
		JsonArray cells = new JsonArray();
		List<RepairCore.Want> all = new ArrayList<>();
		todo.forEach(u -> all.addAll(u.lagging()));
		RepairCore.commitOrder(all);
		for (RepairCore.Want w : all) {
			cells.add(wantJson(w));
		}
		o.add("cells", cells);
		JsonArray st = new JsonArray();
		for (Unit u : todo) {
			if (u.stuck()) {
				JsonObject s = new JsonObject();
				s.addProperty("site", u.site());
				s.addProperty("group", u.group());
				st.add(s);
			}
		}
		o.add("settle", st);
		JsonArray cu = new JsonArray();
		now.custody().forEach(c -> {
			JsonArray a = new JsonArray();
			a.add(c[0]);
			a.add(c[1]);
			cu.add(a);
		});
		o.add("custody", cu);
		JsonObject reg = new JsonObject();
		todo.forEach(u -> {
			if (u.region() != null) {
				reg.addProperty(u.site(), u.region());
			}
		});
		o.add("regions", reg);
		Path path = recordPath(planId);
		if (path == null) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "No world is running");
		}
		try {
			writeDurable(path, o);
		} catch (IOException e) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "The repair record could not be written (" + e.getMessage() + "); nothing was written");
		}
		return run(srv, planId, path, o, all, left);
	}

	/**
	 * The writes, the durability barrier, the settles, the credits, then the record final. Shared by a new repair and an open one finished.
	 * (DR2, P1-1) Nothing settles and the record never goes final before the written chunks are on disk: a crash before the barrier leaves
	 * the journal as it was and the record open (resumable); a refused save the same, without a crash. The record names its phase
	 * ({@code written}, then {@code settling} with the credit keys of the removals it settles, read while their records still stand).
	 */
	private static RepairResult run(MinecraftServer srv, String planId, Path path, JsonObject o, List<RepairCore.Want> all, int left) {
		kill("DRK0", "the record durable, nothing written");
		int written = write(srv, all);
		Set<String> touched = new LinkedHashSet<>();
		all.forEach(w -> touched.add(w.site()));
		try {
			worldSaved(srv);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Repair {}: wrote {} cell(s) but the world's save was refused ({}); nothing settled, the record stays open", planId,
				written, e.getMessage());
			return new RepairResult(planId, false, written, Map.of(), List.of(), left, path.toString(), Reason.JOURNAL_UNAVAILABLE, String.format(
				java.util.Locale.ROOT, "Repair %s wrote %,d cell(s), but the world's save was refused (%s): nothing settled and nothing credited. The "
					+ "record stays open; /architect repair ... confirm %s finishes it.", planId, written, e.getMessage(), planId), List.copyOf(touched));
		}
		kill("DRK3", "the barrier saved the writes and the ledger, the record not yet at written");
		o.addProperty("phase", "written");
		o.addProperty("written", (o.has("writtenBefore") ? o.get("writtenBefore").getAsInt() : 0) + written);
		durableOrWarn(planId, path, o);
		List<String> settled = new ArrayList<>();
		List<String> release = new ArrayList<>();
		Set<String> stuckNow = stuckSites(srv);
		JournalStore js = WorldJournal.storeOrNull();
		// a stuck removal settles with every stuck removal stacked over or under it (F1: an upper's expected values are a lower's later
		// undo, which a release would forget), and only when all of them are unanimous
		Set<String> asked = new LinkedHashSet<>();
		for (var e : o.getAsJsonArray("settle")) {
			asked.add(e.getAsJsonObject().get("site").getAsString());
		}
		Set<String> done = new HashSet<>();
		Map<String, List<RepairCore.Want>> takenBy = new LinkedHashMap<>(); // (DR2 round after OVF) per settled survival removal
		for (String site : asked) {
			if (!stuckNow.contains(site) || js == null || done.contains(site)) {
				continue;
			}
			Set<String> comp = stackedWith(js, site, stuckNow);
			done.addAll(comp);
			boolean every = true;
			Map<String, List<RepairCore.Want>> tk = new LinkedHashMap<>();
			for (String m : comp) {
				String g = SiteJournal.lastGroup(m);
				Set<String> newer = g == null ? Set.of() : shadowed(js, m, g);
				if (!newer.isEmpty()) {
					Architect.LOGGER.warn("Repair {}: {}'s removal stays pending: newer site(s) {} stand over its cells (it settles once they are gone)",
						planId, m, newer);
				}
				List<RepairCore.Want> taken = new ArrayList<>();
				every &= g != null && newer.isEmpty() && unanimous(srv, js, m, g, taken);
				if (!taken.isEmpty() && shareOf(m, taken) == null) {
					every = false; // (DR2 round after OVF) a share it can't prove (a road's record): the whole credit stays pending, as before
					Architect.LOGGER.warn("Repair {}: {}'s removal stays pending: players took {} of its blocks and their share can't be proven", planId, m,
						taken.size());
				}
				tk.put(m, taken);
			}
			if (!every) {
				if (comp.size() > 1) {
					Architect.LOGGER.warn("Repair {}: {} written; its removal settles with {} once they are repaired too (stacked)", planId, site, comp);
				}
				continue;
			}
			for (String m : comp) {
				release.addAll(SiteJournal.undone(m, SiteJournal.lastGroup(m)).stream().map(JournalStore.Meta::id).toList());
				settled.add(m);
				takenBy.put(m, tk.getOrDefault(m, List.of()));
			}
		}
		// (DR-S) the settled survival removals' credit keys, read before their records go; (DR2) kept in the record first, with an earlier
		// attempt's (a resumed repair books what it settled before the stop: once per key)
		Set<String> keys = new LinkedHashSet<>();
		if (o.has("keys")) {
			o.getAsJsonArray("keys").forEach(k -> keys.add(k.getAsString()));
		}
		for (String site : settled) {
			String k = pendingKeyOf(site);
			if (k != null) {
				keys.add(k);
			}
		}
		JsonArray settledBefore = o.has("settledBefore") ? o.getAsJsonArray("settledBefore") : new JsonArray();
		if (!settled.isEmpty() || !keys.isEmpty()) {
			JsonArray ka = new JsonArray();
			keys.forEach(ka::add);
			o.add("keys", ka);
			JsonArray sb = settledBefore.deepCopy();
			settled.forEach(sb::add);
			o.add("settledBefore", sb);
			o.addProperty("phase", "settling");
			durableOrWarn(planId, path, o);
			kill("DRK4", "the settling record durable, nothing withheld or released");
		}
		// (DR2 round after OVF, the GPT review's P1) a settled survival removal a player took blocks from: its pending credit keeps what was
		// restored or removed, the taken cells' share moves to its held key (the player holds those blocks), confirmed on disk before the
		// release (speed rule 17): released first, a stop would let the start book the whole pending credit, the taken blocks included
		JsonObject withheld = o.has("withheld") && o.get("withheld").isJsonObject() ? o.getAsJsonObject("withheld") : new JsonObject();
		boolean split = false;
		for (String site : settled) {
			List<RepairCore.Want> taken = takenBy.getOrDefault(site, List.of());
			String k = pendingKeyOf(site);
			Map<String, Integer> share = shareOf(site, taken);
			if (k == null || taken.isEmpty() || share == null) {
				continue;
			}
			Map<String, Integer> held = Stockpiles.withhold(k, share);
			withheld.add(site, Builder.counts(held));
			split = true;
			Architect.LOGGER.warn("Repair {}: players took {} of {}'s standing blocks after its removal: their share {} is withheld from {} (held as {}{})",
				planId, taken.size(), site, held, k, Stockpiles.TAKEN, k);
		}
		if (split) {
			try {
				ledgerSaved(srv);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Repair {}: the withheld share's save was refused ({}); nothing released, the record stays open", planId,
					e.getMessage());
				return new RepairResult(planId, false, written, Map.of(), List.of(), left, path.toString(), Reason.JOURNAL_UNAVAILABLE, "Repair " + planId
					+ " wrote its cells, but the ledger's save was refused (" + e.getMessage() + "): nothing settled and nothing credited; the record "
					+ "stays open; confirm finishes it", List.copyOf(touched));
			}
			o.add("withheld", withheld);
			durableOrWarn(planId, path, o);
			kill("DRK5", "the withheld share on disk, nothing released");
		}
		// every settled group released after all are judged (a lower removal's later undo is the upper's expected value: F1)
		if (!release.isEmpty()) {
			SiteJournal.releaseGroup(release);
		}
		for (String site : settled) {
			if (Sites.pendingRecord(site) != null) {
				Sites.settledByRepair(srv, site);
			} else if (Infras.pending(site) != null) {
				Infra i = Infras.pending(site);
				Infras.drop(srv, site);
				dev.larattalabs.architect.apiimpl.ApiEvents.removedInfra(srv, i, 0);
			}
			Architect.LOGGER.warn("Repair {}: {}'s removal settled (released, its restore written by the repair)", planId, site);
		}
		if (!settled.isEmpty()) {
			kill("DRK6", "released, the pending credits not booked");
		}
		// survival: a rolled-forward removal's stored credit (J2 2a's, or a group removal's decCredit held pending, slice DR-S) books once, keyed
		// to the removals this repair settled only, then saved with the world; custody under the cap. What is credited is what left the
		// pending credits and the custody for the stock: returned plus overflow (dropped as items)
		// (DR2 fix) an earlier attempt's refused-save credits already booked in memory (nothing of them pending now, no stop since)
		boolean bookedBefore = keys.stream().noneMatch(k -> Stockpiles.all().stream().anyMatch(p -> p.ledger().pendingKeys().contains(k)));
		Map<String, Integer> credited = new TreeMap<>(); // this attempt's (a resumed one books only what is still pending: once per key)
		boolean saveRefused = false;
		if (!keys.isEmpty()) {
			try {
				Stockpiles.bookPendingFor(srv, keys).forEach((k, v) -> credited.merge(k, v, Integer::sum));
				ledgerSaved(srv); // (speed rule 17) the booking confirmed on disk before the record goes final
			} catch (IllegalStateException e) {
				saveRefused = true; // booked in memory; on disk still pending: the next start (or this record, resumed) books it once
				Architect.LOGGER.error("Repair {}: the credits' save was refused ({}); the record stays open", planId, e.getMessage());
			}
		}
		boolean cust = false;
		for (var e : o.getAsJsonArray("custody")) {
			String owner = e.getAsJsonArray().get(0).getAsString();
			String key = e.getAsJsonArray().get(1).getAsString();
			Stockpiles.Pile p = Stockpiles.get(owner);
			if (p == null || p.ledger().credited(key) || p.ledger().custody(key).isEmpty()) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, p.dimension());
			if (level != null) {
				BlockPos at = p.crates().isEmpty() ? BlockPos.ZERO : p.crates().get(0).above();
				var c = Stockpiles.credit(srv, p, key, Map.of(), at); // FK's rule: the site is gone, so credited under the cap, never written back
				c.returned().forEach((k, v) -> credited.merge(k, v, Integer::sum));
				c.overflow().forEach((k, v) -> credited.merge(k, v, Integer::sum));
				cust = true;
			}
		}
		if (cust) {
			try {
				Stockpiles.saveCredit(srv);
				ledgerSaved(srv);
			} catch (IllegalStateException e) {
				saveRefused = true;
				Architect.LOGGER.error("Repair {}: the custody credit's save was refused ({}); the record stays open", planId, e.getMessage());
			}
		}
		if (!keys.isEmpty() || cust) {
			kill("DRK7", "the credits on disk, the record not final");
		}
		JsonObject prior = o.has("credited") && o.get("credited").isJsonObject() ? o.getAsJsonObject("credited") : null;
		if (o.get("creditedUnsaved") instanceof JsonObject un && bookedBefore) {
			prior = creditedAudit(prior, creditedAudit(un, Map.of()).entrySet().stream().collect(java.util.stream.Collectors.toMap(e -> e.getKey(),
				e -> e.getValue().getAsInt()))); // an earlier attempt booked them in memory (its save refused, no stop since): counted once
		}
		if (saveRefused) {
			o.add("creditedUnsaved", creditedAudit(null, credited)); // its save refused: books again (once per key) when resumed
		} else {
			o.add("credited", creditedAudit(prior, credited));
			o.remove("creditedUnsaved");
		}
		JsonArray sj = settledBefore.deepCopy();
		settled.forEach(sj::add);
		o.add("settled", sj);
		o.addProperty("left", left);
		if (saveRefused) {
			durableOrWarn(planId, path, o);
			return new RepairResult(planId, false, written, credited, List.of(), left, path.toString(), Reason.JOURNAL_UNAVAILABLE, "Repair " + planId
				+ " wrote and settled, but a credit's save was refused: the record stays open; confirm finishes it", List.copyOf(touched));
		}
		o.addProperty("state", "final");
		o.addProperty("finishedAt", System.currentTimeMillis());
		try {
			writeDurable(path, o);
		} catch (IOException e) {
			Architect.LOGGER.error("Repair {}: the record could not be made final ({})", planId, e.getMessage());
		}
		if ("DRK2".equals(killPoint)) {
			// TEST (DR2 kill point DRK2): after the record is final, nothing saved after it; the barrier put the writes on disk first
			Architect.LOGGER.error("Repair: kill point DRK2 (the record final, {} cells written): halting the JVM", written);
			Runtime.getRuntime().halt(7);
		}
		Set<String> sites = new LinkedHashSet<>(touched);
		sites.addAll(settled);
		JsonObject reg = o.has("regions") ? o.getAsJsonObject("regions") : new JsonObject();
		RepairResult res = new RepairResult(planId, true, written, credited, List.of(), left, path.toString(), null, String.format(java.util.Locale.ROOT,
			"Repaired %s: wrote %,d, left %,d (players' blocks or changed since)%s. Final: record %s/%s.json.", String.join(", ", sites), written,
			left, settled.isEmpty() ? "" : "; settled " + String.join(", ", settled), DIR, planId), List.copyOf(sites));
		Architect.LOGGER.warn("Repair {} by {}: wrote {} cell(s), left {}, settled {}, credited {} (record {})", planId, o.get("op").getAsString(), written,
			left, settled, credited, path);
		for (String s : sites) {
			String region = reg.has(s) ? reg.get(s).getAsString() : null;
			repairedEvents++;
			lastRepairedSite = s;
			lastRepairedRegion = region;
			try {
				SiteEvents.SITE_REPAIRED.invoker().onRepaired(s, region, res);
			} catch (RuntimeException e) {
				Architect.LOGGER.warn("A SITE_REPAIRED listener failed", e);
			}
		}
		List<RepairSuspect> left2 = new ArrayList<>(suspects);
		left2.removeIf(x -> sites.contains(x.siteId()) || x.reason().equals("repair_open") && x.siteId().equals(planId));
		suspects = List.copyOf(left2);
		synchronized (PLANS) {
			PLANS.remove(planId);
		}
		return res;
	}

	/**
	 * (DR2 fix, should-fix) The record's credit audit over every attempt: an earlier attempt's (a resumed repair books only what is still
	 * pending) plus this one's.
	 */
	static JsonObject creditedAudit(@Nullable JsonObject before, Map<String, Integer> now) {
		Map<String, Integer> all = new TreeMap<>();
		if (before != null) {
			before.entrySet().forEach(e -> all.merge(e.getKey(), e.getValue().getAsInt(), Integer::sum));
		}
		now.forEach((k, v) -> all.merge(k, v, Integer::sum));
		JsonObject cr = new JsonObject();
		all.forEach(cr::addProperty);
		return cr;
	}

	/** The open record rewritten at a phase; a failure is logged (the record before it still resumes: every step is keyed or idempotent). */
	private static void durableOrWarn(String planId, Path path, JsonObject o) {
		try {
			writeDurable(path, o);
		} catch (IOException e) {
			Architect.LOGGER.warn("Repair {}: the record's phase {} could not be written ({})", planId, o.get("phase"), e.getMessage());
		}
	}

	private static @Nullable JournalStore js() {
		return WorldJournal.storeOrNull();
	}

	/**
	 * (DR-S) The stuck removals of {@code units} a repair of them settles: no foreign cell, and every stuck removal stacked with it is one of
	 * {@code units} with none either (a stacked partner left out keeps both pending).
	 */
	static Set<String> settling(@Nullable JournalStore js, List<Unit> units, Set<String> stuck) {
		Map<String, Unit> by = new LinkedHashMap<>();
		units.forEach(u -> by.put(u.site(), u));
		Set<String> out = new LinkedHashSet<>();
		for (Unit u : units) {
			if (!u.stuck() || u.foreign() > u.taken() || js == null || u.taken() > 0 && Infras.pending(u.site()) != null) {
				continue; // (DR2 round after OVF) a player's taken cells alone never keep it pending: their share is withheld (a road's can't be proven)
			}
			boolean all = true;
			for (String o : stackedWith(js, u.site(), stuck)) {
				Unit x = by.get(o);
				String g = SiteJournal.lastGroup(o);
				all &= x != null && x.foreign() <= x.taken() && g != null && shadowed(js, o, g).isEmpty(); // (DR2) none under a newer site
			}
			if (all) {
				out.add(u.site());
			}
		}
		return out;
	}

	/** A pending site's or road's stored credit (J2 2a; slice DR-S: a group removal's held pending too), or empty. */
	private static Map<String, Integer> pendingCreditOf(String site) {
		String key = pendingKeyOf(site);
		if (key == null) {
			return Map.of();
		}
		Map<String, Integer> out = new TreeMap<>();
		for (Stockpiles.Pile p : Stockpiles.all()) {
			if (!p.ledger().credited(key)) {
				p.ledger().pendingItems(key).forEach((k, v) -> out.merge(k, v, Integer::sum));
				p.ledger().custody(key).forEach((k, v) -> out.merge(k, v, Integer::sum));
			}
		}
		return out;
	}

	/**
	 * (DR2 fix, P1-4) How many of a pending removal's cells a player broke after its undo while its placed block stood there (their marks,
	 * saved with their chunks; the chunks loaded as needed). The start's settle keeps such a survival removal pending.
	 */
	static int takenAfterUndo(MinecraftServer srv, String site, String group) {
		return takenNow(srv, site, group).size();
	}

	/**
	 * Whether every cell a stuck removal owns now holds what its undo wrote; (DR2 round after OVF) a survival removal's cell a player took
	 * after its undo ({@link RepairCore#takenAfter}) is no blocker: it is added to {@code taken} (never written; its share withheld).
	 */
	private static boolean unanimous(MinecraftServer srv, JournalStore js, String site, String group, List<RepairCore.Want> taken) {
		boolean survival = pendingKeyOf(site) != null;
		try {
			List<RepairCore.Want> w = RepairCore.removalWants(js, site, group);
			Map<String, LevelReader> readers = new LinkedHashMap<>();
			int[] budget = {Integer.MAX_VALUE};
			Set<Long> loaded = new HashSet<>();
			for (RepairCore.Want x : w) {
				LevelReader r = readerFor(srv, readers, x.dim(), budget, loaded);
				if (r == null || !r.ensure(Journal.x(x.pos()) >> 4, Journal.z(x.pos()) >> 4)) {
					return false;
				}
				if (RepairCore.takenAfter(markOf(r, x.pos()), x, survival)) {
					taken.add(x);
					continue;
				}
				if (cellOf(r, x, survival) != RepairCore.Cell.OK
					|| x.pt() != null && dev.larattalabs.architect.placed.TrackingRule.on && !r.pt(x.pos())) { // (DR2 fix, P1-5) a restored player's record missing: not settled
					return false;
				}
			}
			return true;
		} catch (IOException e) {
			return false;
		}
	}

	/**
	 * (DR2 round after OVF) A stuck survival removal's taken cells' refund share ({@link RepairCore#takenShare} over its pending record's
	 * queue), or null when it can't be proven (a road's record, or none): the caller then keeps the removal pending as before.
	 */
	static @Nullable Map<String, Integer> shareOf(String site, List<RepairCore.Want> taken) {
		if (taken.isEmpty()) {
			return Map.of();
		}
		Site s = Sites.pendingRecord(site);
		if (s == null || s.construction() == null) {
			return null;
		}
		return RepairCore.takenShare(s.restoreBox(), s.construction().queue(), s.construction().free(), taken);
	}

	/** (DR2 round after OVF) A stuck removal's taken cells now (their marks; the chunks loaded as needed), for the dry run's preview. */
	private static List<RepairCore.Want> takenNow(MinecraftServer srv, String site, String group) {
		JournalStore js = WorldJournal.storeOrNull();
		List<RepairCore.Want> out = new ArrayList<>();
		if (js == null || pendingKeyOf(site) == null) {
			return out;
		}
		try {
			Map<String, LevelReader> readers = new LinkedHashMap<>();
			int[] budget = {Integer.MAX_VALUE};
			for (RepairCore.Want x : RepairCore.removalWants(js, site, group)) {
				LevelReader r = readerFor(srv, readers, x.dim(), budget, new HashSet<>());
				if (r != null && r.ensure(Journal.x(x.pos()) >> 4, Journal.z(x.pos()) >> 4) && RepairCore.takenAfter(markOf(r, x.pos()), x, true)) {
					out.add(x);
				}
			}
		} catch (IOException e) {
			return out;
		}
		return out;
	}

	/**
	 * (DR2 round after OVF, speed rule 17) The repair's saves, in two helpers so that TXN's T0 barrier replaces them in one place:
	 * {@link #worldSaved} the durability barrier (the written chunks, then the ledger, on disk), {@link #ledgerSaved} the ledger's confirmed
	 * save ({@link Stockpiles#saveConfirmed}: it throws unless the ledger reached the disk). Both throw on a refusal.
	 */
	private static void worldSaved(MinecraftServer srv) {
		Stockpiles.durableBarrier(srv);
	}

	private static void ledgerSaved(MinecraftServer srv) {
		Stockpiles.saveConfirmed(srv);
	}

	/** (DR2 round after OVF, TEST) kill point {@code name} if armed ({@code dev.repair op killAt}): halts the JVM, nothing saved. */
	private static void kill(String name, String what) {
		if (name.equals(killPoint)) {
			Architect.LOGGER.error("Repair: kill point {} ({}): halting the JVM", name, what);
			Runtime.getRuntime().halt(7);
		}
	}

	/** Writes the wants (in their order) through the journal's write path; DRK1 halts half way. Returns how many were written. */
	private static int write(MinecraftServer srv, List<RepairCore.Want> all) {
		int n = 0;
		int half = all.size() / 2;
		Map<String, ServerLevel> levels = new LinkedHashMap<>();
		for (RepairCore.Want w : all) {
			if (killDRK1 && n == half && half > 0) {
				Architect.LOGGER.error("Repair: kill point DRK1 (the record durable, {} of {} cells written): halting the JVM", n, all.size());
				Runtime.getRuntime().halt(7);
			}
			if (w.pt() != null && "DRK1pt".equals(killPoint)) {
				// TEST (DR2, P1-4): before the first cell restoring a player's record, nothing saved
				Architect.LOGGER.error("Repair: kill point DRK1pt (the record durable, {} of {} cells written, next a player's block): halting the JVM", n,
					all.size());
				Runtime.getRuntime().halt(7);
			}
			ServerLevel level = levels.computeIfAbsent(w.dim(), d -> Sites.levelOf(srv, d));
			if (level == null) {
				continue;
			}
			level.getChunk(Journal.x(w.pos()) >> 4, Journal.z(w.pos()) >> 4);
			List<SiteJournal.CellWrite> one = List.of(new SiteJournal.CellWrite(w.pos(), w.expected(), w.flags()));
			if (w.pt() != null) {
				it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<dev.larattalabs.architect.placed.Placed.Expect> pts =
					new it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap<>();
				pts.put(w.pos(), new dev.larattalabs.architect.placed.Placed.Expect(WorldJournal.state(w.expected()).getBlock(), w.pt()));
				dev.larattalabs.architect.placed.Placed.beginRestore(pts);
				try {
					SiteJournal.writeCells(level, one);
				} finally {
					dev.larattalabs.architect.placed.Placed.endRestore();
				}
				// (DR2 fix, P1-5) a cell already holding the block (a stacked upper's identical write came first) gets its record, as an undo's does
				dev.larattalabs.architect.placed.Placed.restoreUnchanged(level, pts);
			} else {
				SiteJournal.writeCells(level, one);
			}
			MinedCells.World.clear(level, w.pos()); // (DR2) the journal's value again: an old mark no longer describes it
			n++;
		}
		return n;
	}

	/**
	 * Finishes an open repair (DRK1, a refused save) from its record. (DR2, P1-2) The record is not trusted alone: every site it names must
	 * not be busy (SITE_BUSY, the record stays open), and each recorded cell is replayed only while the journal still owes it now
	 * ({@link RepairCore#stillOwed}: the same commit, still its owner, a removal's site still stuck under the same undo group); a newer
	 * placement over it or a later removal of it wins. The cells still owed are classified again (a player's mark, a PT record: FOREIGN).
	 * Credits are keyed (once).
	 */
	private static RepairResult finishOpen(MinecraftServer srv, String planId, Path path, JsonObject o, ServerPlayer actor) {
		JournalStore js = WorldJournal.storeOrNull();
		if (js == null) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "The world journal is not open; repair " + planId + " stays open");
		}
		List<RepairCore.Want> recorded = new ArrayList<>();
		Set<String> named = new LinkedHashSet<>();
		try {
			for (var e : o.getAsJsonArray("cells")) {
				RepairCore.Want w = wantOf(e.getAsJsonObject());
				recorded.add(w);
				named.add(w.site());
			}
		} catch (IllegalStateException e) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "Repair " + planId + "'s record could not be read (" + e.getMessage() + "); it stays open");
		}
		Map<String, String> groups = new LinkedHashMap<>();
		for (var e : o.getAsJsonArray("settle")) {
			JsonObject x = e.getAsJsonObject();
			named.add(x.get("site").getAsString());
			if (x.has("group") && !x.get("group").isJsonNull()) {
				groups.put(x.get("site").getAsString(), x.get("group").getAsString());
			}
		}
		for (String site : named) {
			String b = busy(srv, site);
			if (b != null) {
				return refused(planId, Reason.SITE_BUSY, b + "; repair " + planId + " stays open, nothing was written");
			}
		}
		String off = Stockpiles.savingOff(srv);
		if (off != null) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "Repair " + planId + " refused: " + off + "; it stays open, nothing was written");
		}
		Set<String> stuck = stuckSites(srv);
		List<RepairCore.Want> owed;
		try {
			owed = RepairCore.stillOwed(js, recorded);
		} catch (IOException e) {
			return refused(planId, Reason.JOURNAL_UNAVAILABLE, "The journal could not be read (" + e.getMessage() + "); repair " + planId + " stays open");
		}
		// a removal's cell only while its site is still stuck under the undo the record named
		owed.removeIf(w -> w.removal() && (!stuck.contains(w.site()) || groups.containsKey(w.site()) && !groups.get(w.site()).equals(SiteJournal
			.lastGroup(w.site()))));
		List<RepairCore.Want> all = new ArrayList<>();
		int left = 0;
		for (RepairCore.Want w : owed) {
			ServerLevel level = Sites.levelOf(srv, w.dim());
			if (level == null) {
				left++;
				continue;
			}
			level.getChunk(Journal.x(w.pos()) >> 4, Journal.z(w.pos()) >> 4);
			LevelReader r = new LevelReader(level, new int[] {0}, new HashSet<>());
			RepairCore.Cell c = RepairCore.classify(r, w);
			if (c == RepairCore.Cell.LAGGING && r.holdsItems(w.pos())) {
				c = RepairCore.Cell.FOREIGN; // (DR-S) a container's contents are never written over
			}
			if (c == RepairCore.Cell.LAGGING) {
				all.add(w);
			} else if (c == RepairCore.Cell.FOREIGN) {
				left++;
			}
		}
		RepairCore.commitOrder(all);
		int stale = recorded.size() - owed.size();
		o.addProperty("finishedBy", actor.getGameProfile().name());
		o.addProperty("stale", stale);
		o.addProperty("writtenBefore", o.has("written") ? o.get("written").getAsInt() : 0);
		Architect.LOGGER.warn("Repair {}: open (stopped part way); finishing {} cell(s) from its record ({} no longer owed: a newer commit wins)", planId,
			all.size(), stale);
		return run(srv, planId, path, o, all, left);
	}

	private static String dryMessage(String planId, Diag d, List<Unit> todo, int write, int left) {
		if (todo.isEmpty()) {
			return "Nothing to repair in " + d.diagnosis().scope().describe() + " (" + planId + ")";
		}
		StringBuilder sb = new StringBuilder();
		for (Unit u : todo) {
			sb.append(u.stuck() ? "Removed " + u.site() + " is stuck at " + u.lagging().size() + " of " + u.wants().size() + " cells" : message(u)).append(' ');
		}
		sb.append(String.format(java.util.Locale.ROOT, "/architect repair %s confirm %s writes the %,d and leaves the %,d.", d.diagnosis().scope()
			.describe(), planId, write, left));
		return sb.toString().trim();
	}

	// ------------------------------------------------------------------ records

	static @Nullable Path recordDir() {
		Path w = world;
		return w == null ? null : w.resolve(DIR);
	}

	static @Nullable Path recordPath(String planId) {
		Path d = recordDir();
		return d == null || !planId.matches("[0-9a-f]{1,16}") ? null : d.resolve(planId + ".json");
	}

	/** Writes {@code o} at {@code path} durably: a temporary file, fsync, an atomic rename, the directory fsynced (as RP's records). */
	static void writeDurable(Path path, JsonObject o) throws IOException {
		Files.createDirectories(path.getParent());
		Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
		try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE)) {
			ch.write(java.nio.ByteBuffer.wrap(GSON.toJson(o).getBytes(StandardCharsets.UTF_8)));
			ch.force(true);
		}
		Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		try (FileChannel d = FileChannel.open(path.getParent(), StandardOpenOption.READ)) {
			d.force(true);
		} catch (IOException e) {
			// a directory can't be opened on every platform: the rename is atomic anyway
		}
	}

	static @Nullable JsonObject readRecord(Path p) {
		try {
			return com.google.gson.JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/** The plan ids of open records (a repair stopped part way). */
	static List<String> openRecords() {
		Path d = recordDir();
		List<String> out = new ArrayList<>();
		if (d == null || !Files.isDirectory(d)) {
			return out;
		}
		try (var s = Files.list(d)) {
			for (Path p : s.filter(f -> f.getFileName().toString().endsWith(".json")).sorted().toList()) {
				JsonObject o = readRecord(p);
				if (o != null && o.has("state") && "open".equals(o.get("state").getAsString())) {
					out.add(o.get("planId").getAsString());
				}
			}
		} catch (IOException e) {
			return out;
		}
		return out;
	}

	/** {@code /architect repair log [planId]}: the records, newest first (or one). */
	public static List<JsonObject> records(@Nullable String planId) {
		Path d = recordDir();
		List<JsonObject> out = new ArrayList<>();
		if (d == null || !Files.isDirectory(d)) {
			return out;
		}
		try (var s = Files.list(d)) {
			for (Path p : s.filter(f -> f.getFileName().toString().endsWith(".json")).toList()) {
				JsonObject o = readRecord(p);
				if (o != null && (planId == null || planId.equals(o.has("planId") ? o.get("planId").getAsString() : ""))) {
					out.add(o);
				}
			}
		} catch (IOException e) {
			return out;
		}
		out.sort((a, b) -> Long.compare(b.has("at") ? b.get("at").getAsLong() : 0, a.has("at") ? a.get("at").getAsLong() : 0));
		return out;
	}

	static JsonObject wantJson(RepairCore.Want w) {
		JsonObject o = new JsonObject();
		o.addProperty("dim", w.dim());
		o.addProperty("pos", w.pos());
		o.addProperty("x", Journal.x(w.pos()));
		o.addProperty("y", Journal.y(w.pos()));
		o.addProperty("z", Journal.z(w.pos()));
		o.addProperty("expected", w.expected().state().toString());
		if (w.expected().nbt() != null) {
			o.addProperty("expectedNbt", w.expected().nbt().toString());
		}
		o.addProperty("found", w.pre().state().toString());
		if (w.pre().nbt() != null) {
			o.addProperty("foundNbt", w.pre().nbt().toString());
		}
		o.addProperty("site", w.site());
		o.addProperty("entry", w.entry());
		o.addProperty("removal", w.removal());
		o.addProperty("at", w.at());
		o.addProperty("layer", w.layer());
		o.addProperty("flags", w.flags());
		if (w.pt() != null) { // (DR2, P1-4) a restored player's block keeps its record across a resume
			o.addProperty("ptPlacer", w.pt().placer().toString());
			if (w.pt().build() != null) {
				o.addProperty("ptBuild", w.pt().build());
			}
		}
		if (!w.morePre().isEmpty()) {
			JsonArray mp = new JsonArray();
			w.morePre().forEach(x -> mp.add(x.state().toString()));
			o.add("morePre", mp); // (F7) a higher removal's placed blocks (no block entity data)
		}
		return o;
	}

	static RepairCore.Want wantOf(JsonObject o) {
		try {
			Value exp = Value.of(TagParser.parseCompoundFully(o.get("expected").getAsString()), o.has("expectedNbt") ? TagParser.parseCompoundFully(o.get(
				"expectedNbt").getAsString()) : null);
			Value pre = Value.of(TagParser.parseCompoundFully(o.get("found").getAsString()), o.has("foundNbt") ? TagParser.parseCompoundFully(o.get(
				"foundNbt").getAsString()) : null);
			List<Value> more = new ArrayList<>();
			if (o.has("morePre")) {
				for (var e : o.getAsJsonArray("morePre")) {
					more.add(Value.of(TagParser.parseCompoundFully(e.getAsString()), null));
				}
			}
			dev.larattalabs.architect.journal.Pt pt = o.has("ptPlacer") ? new dev.larattalabs.architect.journal.Pt(java.util.UUID.fromString(o.get(
				"ptPlacer").getAsString()), o.has("ptBuild") ? o.get("ptBuild").getAsString() : null) : null;
			return new RepairCore.Want(o.get("dim").getAsString(), o.get("pos").getAsLong(), exp, pre, o.get("site").getAsString(), o.get("entry")
				.getAsString(), o.get("removal").getAsBoolean(), o.get("at").getAsLong(), o.get("layer").getAsLong(), pt, o.get("flags").getAsInt(), more);
		} catch (com.mojang.brigadier.exceptions.CommandSyntaxException | IllegalArgumentException e) {
			throw new IllegalStateException("a repair record's cell could not be read: " + e.getMessage(), e);
		}
	}

	// ------------------------------------------------------------------ suspects and the auto-diagnose

	public static List<RepairSuspect> suspects() {
		return suspects;
	}

	public static boolean suspectsPending() {
		return autoPending;
	}

	/** The last ops line of the auto-diagnose (null: none this start). */
	public static @Nullable String opsLine() {
		return lastOpsLine;
	}

	/**
	 * (§1) The auto-diagnose after an unclean start: the stuck records plus every entry committed after the previous run's last completed
	 * save (or with a job at it), at most {@link #AUTO_CHUNKS_PER_TICK} chunk loads a tick. (DR2) A site is read chunk by chunk, across
	 * ticks when it needs more (each chunk's cells classified in the tick that loads it: an unticketed chunk may unload by the next), so no
	 * tick loads more than the budget. A site whose journal can't be read is a suspect {@code unread}. Never repairs.
	 */
	static final class AutoRun {
		final List<String> todo;
		int next;
		final Set<String> stuck;
		final List<RepairSuspect> found = new ArrayList<>();
		final Set<String> regions = new LinkedHashSet<>();
		/** The site being read: its wants by chunk, how far, what it found so far. */
		@Nullable String cur;
		boolean curStuck;
		@Nullable String curGroup, curRegion;
		final List<Map.Entry<String, List<RepairCore.Want>>> chunks = new ArrayList<>();
		int chunkAt;
		int lagging;
		int unread;

		AutoRun(MinecraftServer srv) {
			stuck = stuckSites(srv);
			JournalStore js = WorldJournal.storeOrNull();
			Set<String> ids = new LinkedHashSet<>(stuck);
			if (js != null) {
				for (JournalStore.Meta m : js.index().entries().values()) {
					if (m.status() == Journal.Status.ACTIVE && mayLag(m) && !m.site().startsWith(SiteGroupRec.CRATE_PREFIX)) {
						ids.add(m.site());
					}
				}
			}
			todo = new ArrayList<>(ids);
			Architect.LOGGER.info("Repairs: unclean start; the auto-diagnose reads {} site(s) (stuck {}, committed after the save at {})", todo.size(),
				stuck.size(), prevSavedAt);
		}

		/** One tick; true when done. */
		boolean step(MinecraftServer srv) {
			JournalStore js = WorldJournal.storeOrNull();
			if (js == null) {
				return finish(srv);
			}
			int[] budget = {AUTO_CHUNKS_PER_TICK};
			Set<Long> loaded = new HashSet<>();
			try {
				while (true) {
					if (cur == null) {
						if (next >= todo.size()) {
							return finish(srv);
						}
						open(js, todo.get(next++));
						continue;
					}
					while (chunkAt < chunks.size()) {
						var e = chunks.get(chunkAt);
						String dim = e.getKey().substring(0, e.getKey().lastIndexOf('|'));
						long c = Long.parseLong(e.getKey().substring(e.getKey().lastIndexOf('|') + 1));
						ServerLevel l = Sites.levelOf(srv, dim);
						if (l == null) {
							unread += e.getValue().size();
							chunkAt++;
							continue;
						}
						LevelReader r = new LevelReader(l, budget, loaded);
						if (!r.ensure(net.minecraft.world.level.ChunkPos.getX(c), net.minecraft.world.level.ChunkPos.getZ(c))) {
							return false; // the budget is spent: this chunk next tick
						}
						Unit u = classify(cur, curRegion, curStuck, curGroup, e.getValue(), d -> r);
						lagging += u.lagging().size();
						unread += u.unread();
						chunkAt++;
					}
					close();
				}
			} finally {
				autoMaxLoads = Math.max(autoMaxLoads, loaded.size());
			}
		}

		/** Starts reading a site: its wants grouped by chunk (or, its journal unreadable, an {@code unread} suspect). */
		private void open(JournalStore js, String id) {
			chunks.clear();
			chunkAt = 0;
			lagging = 0;
			unread = 0;
			if (fed(id)) {
				return;
			}
			curStuck = stuck.contains(id);
			curGroup = curStuck ? SiteJournal.lastGroup(id) : null;
			curRegion = SiteJournal.entries(id).stream().map(Repairs::regionOf).filter(java.util.Objects::nonNull).findFirst().orElse(null);
			List<RepairCore.Want> wants;
			try {
				wants = wantsOf(js, id, curStuck, curGroup, m -> curStuck || mayLag(m));
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Repairs: the auto-diagnose could not read {}'s journal ({}): unread", id, e.getMessage());
				found.add(new RepairSuspect(id, curRegion, "unread"));
				return;
			}
			Map<String, List<RepairCore.Want>> by = new LinkedHashMap<>();
			for (RepairCore.Want w : wants) {
				by.computeIfAbsent(w.dim() + "|" + net.minecraft.world.level.ChunkPos.pack(Journal.x(w.pos()) >> 4, Journal.z(w.pos()) >> 4),
					k -> new ArrayList<>()).add(w);
			}
			chunks.addAll(by.entrySet());
			cur = id;
		}

		/** The site read: a suspect when stuck, lagging, or (not otherwise named) partly unread. */
		private void close() {
			String id = cur;
			cur = null;
			if (id == null) {
				return;
			}
			String reason = curStuck ? "stuck" : lagging > 0 ? "lagging" : unread > 0 ? "unread" : null;
			if (reason != null) {
				found.add(new RepairSuspect(id, curRegion, reason));
				if (curRegion != null && !reason.equals("unread")) {
					regions.add(curRegion);
				}
			}
		}

		private boolean finish(MinecraftServer srv) {
			for (Stockpiles.Pile p : Stockpiles.all()) {
				for (String key : p.ledger().custodyKeys()) {
					String id = idOfKey(key);
					if (id != null && Sites.get(id) == null && Sites.pendingRecord(id) == null && !Groups.removing(id) && !p.ledger().credited(key)) {
						found.add(new RepairSuspect(id, null, "custody"));
					}
				}
			}
			for (String open : openRecords()) {
				found.add(new RepairSuspect(open, null, "repair_open"));
			}
			suspects = List.copyOf(found);
			if (!found.isEmpty()) {
				Set<String> names = new LinkedHashSet<>();
				for (RepairSuspect s : found) {
					names.add(s.regionId() != null ? "region " + s.regionId() : s.siteId());
				}
				List<String> shown = new ArrayList<>(names);
				String list = String.join(", ", shown.subList(0, Math.min(6, shown.size()))) + (shown.size() > 6 ? ", +" + (shown.size() - 6) : "");
				String line = String.format(java.util.Locale.ROOT, "Architect: %d build%s lag the journal after an unclean stop (%s). "
					+ "/architect diagnose all for details.", found.size(), found.size() == 1 ? "" : "s", list);
				lastOpsLine = line;
				Architect.LOGGER.warn("{}", line);
				for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
					if (op(p)) {
						p.sendSystemMessage(Component.literal(line));
						opsLineSent = true;
					}
				}
			} else {
				Architect.LOGGER.info("Repairs: the auto-diagnose after the unclean stop found nothing lagging");
			}
			return true;
		}
	}

	// ------------------------------------------------------------------ TEST (slice DR-S, dev.repair snap/unwrite/ledger)

	private static final Map<String, Map<Long, Object[]>> SNAPS = new LinkedHashMap<>();

	/** (TEST) Keeps the block states and block entity data of a box under {@code id} (this session only). Returns the cell count. */
	public static int testSnap(ServerLevel level, String id, BlockPos min, BlockPos max) {
		Map<Long, Object[]> m = new LinkedHashMap<>();
		for (BlockPos p : BlockPos.betweenClosed(min, max)) {
			level.getChunk(p);
			m.put(p.asLong(), new Object[] {level.getBlockState(p), WorldJournal.beNbt(level, p)});
		}
		SNAPS.put(id, m);
		return m.size();
	}

	/**
	 * (TEST) The lost-writes fault, cell exact: each cell of snapshot {@code id} in {@code min..max} whose block differs from the snapshot
	 * gets the snapshot's block back (no neighbour updates, no drops, no player record), as if that cell's writes since the snapshot never
	 * reached the disk. Only cells whose snapshot block has no block entity (their data would not be the saved one). Returns how many.
	 */
	public static int testUnwrite(ServerLevel level, String id, BlockPos min, BlockPos max) {
		Map<Long, Object[]> m = SNAPS.get(id);
		if (m == null) {
			return -1;
		}
		int n = 0;
		for (BlockPos p : BlockPos.betweenClosed(min, max)) {
			Object[] v = m.get(p.asLong());
			if (v == null || v[1] != null) {
				continue;
			}
			BlockState was = (BlockState) v[0];
			if (!level.getBlockState(p).equals(was) && !was.hasBlockEntity()) {
				dev.larattalabs.architect.placed.Placed.set(level, p, was, net.minecraft.world.level.block.Block.UPDATE_CLIENTS | net.minecraft.world.level.block.Block.UPDATE_KNOWN_SHAPE
					| net.minecraft.world.level.block.Block.UPDATE_SUPPRESS_DROPS);
				n++;
			}
		}
		return n;
	}

	/**
	 * (TEST) A ledger fault: {@code paid} items paid under {@code key} and {@code custody} items taken into its custody, in {@code owner}'s
	 * stockpile, then saved with the world (the saved state the gate reads). A key naming no target makes PAID_ORPHAN; with custody, an
	 * unresolved CUSTODY. False without that stockpile.
	 */
	public static boolean testLedger(MinecraftServer srv, String owner, String key, Map<String, Integer> paid, Map<String, Integer> custody) {
		Stockpiles.Pile p = Stockpiles.get(owner);
		if (p == null) {
			return false;
		}
		paid.forEach((k, v) -> p.ledger().pay(key, k, v));
		if (!custody.isEmpty()) {
			p.ledger().holdCustody(key, custody);
		}
		Stockpiles.changed(p);
		Stockpiles.saveWithWorld(srv);
		return true;
	}

	/** Whether a player holds gamemaster permission (an op, or cheats on in single player). */
	static boolean op(@Nullable ServerPlayer p) {
		return p != null && p.createCommandSourceStack().permissions().hasPermission(net.minecraft.server.permissions.Permissions.COMMANDS_GAMEMASTER);
	}
}
