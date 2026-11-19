package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.survival.SurvivalWorld;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.event.Event;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * The per-tick placement budget and the jobs that use it (docs/CONTRACT.md phase 4d): ticked instant placements
 * ({@link PlaceJob}) and snapshot restores ({@link RestoreJob}), the batch queue ({@link Batches}) and group removals
 * ({@link Groups}). Each server tick they share {@code placementBudgetMs} of server time (default 4, 1-20, in
 * {@code architect-world.json}); construction sites' builder gets what is left ({@link #remainingNanos}).
 *
 * <p>Everything in flight is persisted in {@code <world>/architect-queue.json}: on every change (an item starts or ends, a
 * job starts or ends) and at server stop with each job's cursor. A stop that wrote the file ({@code clean}) resumes every
 * job where it was. After a crash the chunks on disk may be older than the file, so a job that was placing is rolled back
 * from its snapshot and its item queued again.
 */
public final class Placement {
	public static final String FILE = "architect-queue.json";
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

	/** A ticked job: one site's cells written over ticks under the budget. Server thread. */
	interface Job {
		String siteId();

		@Nullable String batchId();

		/** {@code place}, {@code rollback} or {@code remove}. */
		String kind();

		/** Works until done or {@code deadline} ({@link System#nanoTime}); true when complete (or broken). */
		boolean step(MinecraftServer server, long deadline);

		/** Cells handled so far, and in all (for progress and throughput). */
		int progress();

		int total();

		/** It was taken out before it completed (a cancel): drop what it held back. */
		void aborted(MinecraftServer server);

		JsonObject toJson();
	}

	private static final RemovalSeal.Counted<Job> JOBS = new RemovalSeal.Counted<>();

	/** (slice LC3) The queue's structural changes so far (a job added or gone): the removal seal follows them. */
	static int jobMods() {
		return JOBS.mods();
	}
	private static long deadline;

	/** This tick's placement deadline ({@link System#nanoTime}). */
	static long deadline() {
		return deadline;
	}
	private static int rotate;
	private static @Nullable MinecraftServer server;
	private static final Stats STATS = new Stats();

	private Placement() {
	}

	static void init() {
		Batches.init(); // registers the chunk ticket type now, while the registries are open
		ServerLifecycleEvents.SERVER_STARTED.register(Placement::load);
		ServerTickEvents.START_SERVER_TICK.register(s -> {
			STATS.startTick(s, active());
			traceStart = System.nanoTime();
			traceWork = 0;
			traceCpu = 0;
		});
		ServerTickEvents.END_SERVER_TICK.register(Placement::tick);
		// the tick's full time is measured from its start to after every other end-of-tick handler (Fabric runs END_SERVER_TICK
		// after the server tallied its own tick time, so the server's MSPT leaves those handlers out)
		Identifier last = Identifier.fromNamespaceAndPath(Architect.MOD_ID, "tick_stats");
		ServerTickEvents.END_SERVER_TICK.addPhaseOrdering(Event.DEFAULT_PHASE, last);
		ServerTickEvents.END_SERVER_TICK.register(last, s -> {
			STATS.endTick(s);
			dev.larattalabs.architect.region.MsptTrace.tick(System.nanoTime() - traceStart, traceWork, traceCpu);
		});
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> save(s, true));
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			JOBS.clear();
			FluidRearm.clear();
			Batches.reset();
			Groups.reset(s);
			STATS.reset();
			server = null;
		});
	}

	// ------------------------------------------------------------------ the tick

	static long budgetNanos() {
		return SurvivalWorld.placementBudgetMs() * 1_000_000L;
	}

	static @Nullable MinecraftServer server() {
		return server;
	}

	/** What is left of this tick's budget for the construction builder (at least nothing). */
	public static long remainingNanos() {
		return Math.max(0, deadline - System.nanoTime());
	}

	/** Whether anything uses the budget now (a job, a running batch or a removal). Any thread. */
	public static boolean active() {
		return !JOBS.isEmpty() || Batches.anyRunning() || Groups.anyRemoving() || Builder.anyBuilding();
	}

	/**
	 * Ticks after a world start in which placement waits (phase 4e): the server's own first ticks load chunks and warm up
	 * (measured up to 45 ms), and resumed jobs and queued items would add to them.
	 */
	static final int START_GRACE_TICKS = 40;

	private static void tick(MinecraftServer srv) {
		server = srv;
		RemovalSeal.observe(); // (LC3 fix 2) what ended since the last check lingers sealed until its generation is written
		saveIfDue(srv); // (slice PSV) a failed queue write's retry; an undo waiting on its pre-save, and (LC3 fix 2) a lingering seal, wait on it
		if (srv.getTickCount() < START_GRACE_TICKS) {
			return;
		}
		long start = System.nanoTime();
		long cpu0 = cpuNow();
		deadline = start + budgetNanos();
		int before = workDone();
		SLOW.setLength(0);
		try {
			Batches.tick(srv, deadline);
			lap("batches", start);
			long t1 = System.nanoTime();
			Groups.tick(srv, deadline);
			lap("groups", t1);
			RemovalSeal.observe(); // (LC3 fix 2) a member's job added here and done in runJobs is seen before it ends
			completedNow = false;
			t1 = System.nanoTime();
			runJobs(srv);
			lap("jobs", t1);
			RemovalSeal.observe();
			// phase 4e: a job that finished leaves budget: its batch starts the next item in this tick, not the next one
			for (int again = 0; again < 4 && completedNow && !slow && System.nanoTime() < deadline; again++) {
				completedNow = false;
				Batches.startNext(srv, deadline);
				runJobs(srv);
				RemovalSeal.observe();
			}
			syncGhosts(srv);
			// (relief falling water) a restore's flowing fluid gets its tick once nothing is restoring any more
			FluidRearm.tick(srv, Groups.removing() || JOBS.stream().anyMatch(j -> j instanceof RestoreJob || j instanceof DeltaJob));
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Placement tick failed", e);
		}
		if (TRACE && System.nanoTime() - start > 25_000_000L) {
			Architect.LOGGER.info("TRACE slow placement tick {} {} ms:{}", srv.getTickCount(), (System.nanoTime() - start) / 1e6, SLOW);
		}
		if (!JOBS.isEmpty() || STATS.tickActive) {
			STATS.work(System.nanoTime() - start, Math.max(0, workDone() - before) + finishedWork);
			long cpu = cpu0 < 0 ? -1 : cpuNow() - cpu0;
			STATS.workCpu(cpu);
			traceWork += System.nanoTime() - start;
			traceCpu = cpu < 0 || traceCpu < 0 ? -1 : traceCpu + cpu; // (6c 0a) the same work in CPU time; -1: the JVM can't tell
		}
		finishedWork = 0;
	}

	private static int finishedWork;
	private static boolean completedNow;

	private static int workDone() {
		int n = 0;
		for (Job j : JOBS) {
			n += j.progress();
		}
		return n;
	}

	/** Test hook ({@code dev.placement.slow}): jobs write about 16 cells per tick, so a gate can act in the middle of an item. */
	private static volatile boolean slow;

	public static void setSlow(boolean on) {
		slow = on;
	}

	public static boolean slow() {
		return slow;
	}

	private static void runJobs(MinecraftServer srv) {
		if (JOBS.isEmpty()) {
			return;
		}
		if (slow) {
			deadline = System.nanoTime(); // every step stops after its first few cells
		}
		int n = JOBS.size();
		int first = Math.floorMod(rotate++, n);
		List<Job> order = new ArrayList<>(n);
		for (int i = 0; i < n; i++) {
			order.add(JOBS.get((first + i) % n));
		}
		for (Job j : order) {
			if (System.nanoTime() >= deadline && j != order.get(0)) {
				break; // the first job always gets a step: every tick makes progress
			}
			int was = j.progress();
			boolean complete;
			long tj = System.nanoTime();
			try {
				complete = j.step(srv, deadline);
				if (TRACE) {
					lap("step:" + j, tj);
				}
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Placement job {} failed", j, e);
				complete = true;
				if (j instanceof PlaceJob pj) {
					pj.broken = "it failed (" + e + ")";
				} else if (j instanceof InfraJob ij) {
					ij.broken = "it failed (" + e + ")"; // (slice T4a, finding 4) rolled back, its futures failed: never reported placed
				} else if (j instanceof RestoreJob rj) {
					rj.broken = "it failed (" + e + ")";
				}
			}
			if (complete) {
				completedNow = true;
				JOBS.remove(j);
				finishedWork += Math.max(0, j.total() - was);
				long tc = System.nanoTime();
				completed(srv, j);
				if (TRACE) {
					lap("completed:" + j, tc);
				}
			}
		}
	}

	/**
	 * While an instant placement writes, players within range see its ghost fill in (the construction ghost's payloads: the
	 * whole ghost once, then the cells written each tick); it is cleared when the placement ends.
	 */
	private static void syncGhosts(MinecraftServer srv) {
		for (Job j : JOBS) {
			if (!(j instanceof PlaceJob pj)) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, pj.dimension);
			if (level == null) {
				continue;
			}
			int[] newly = null;
			for (net.minecraft.server.level.ServerPlayer p : srv.getPlayerList().getPlayers()) {
				boolean in = p.level() == level && Builder.near(p, pj.snapBox, Builder.RANGE);
				boolean had = pj.ghostTo.contains(p.getUUID());
				if (!in) {
					if (had) {
						pj.ghostTo.remove(p.getUUID());
						Builder.send(p, new dev.larattalabs.architect.survival.SiteNet.SiteClear(pj.siteId, false, pj.blueprint));
					}
					continue;
				}
				if (!had) {
					var g = pj.ghost();
					if (g != null) {
						Builder.send(p, g);
						pj.ghostTo.add(p.getUUID());
					}
					continue;
				}
				if (newly == null) {
					newly = pj.ghostNewly();
				}
				if (newly.length > 0) {
					Builder.send(p, new dev.larattalabs.architect.survival.SiteNet.SiteProgress(pj.siteId,
						dev.larattalabs.architect.survival.CellBits.encodeInts(newly)));
				}
			}
		}
	}

	private static void clearGhost(MinecraftServer srv, Job j, boolean finished) {
		if (!(j instanceof PlaceJob pj)) {
			return;
		}
		for (java.util.UUID u : pj.ghostTo) {
			net.minecraft.server.level.ServerPlayer p = srv.getPlayerList().getPlayer(u);
			if (p != null) {
				Builder.send(p, new dev.larattalabs.architect.survival.SiteNet.SiteClear(pj.siteId, finished, pj.blueprint));
			}
		}
		pj.ghostTo.clear();
	}

	/** A job ended: placed, rolled back, removed, or broken (a broken placement rolls back). */
	private static void completed(MinecraftServer srv, Job j) {
		clearGhost(srv, j, false);
		if (j instanceof PlaceJob pj) {
			if (pj.broken != null && pj.beforeRecord) {
				// nothing written and no record (P1-P3 failed): the item fails; entries that did reach the journal are released
				Architect.LOGGER.warn("Placing {} failed before its first block ({})", pj.siteId, pj.broken);
				pj.aborted(srv);
				SiteJournal.releaseGroup(SiteJournal.entries(pj.siteId).stream().filter(m -> m.status() == dev.larattalabs.architect.journal.Journal.Status.PLACING)
					.map(dev.larattalabs.architect.journal.JournalStore.Meta::id).toList());
				Batches.failedBeforeRecord(srv, pj, pj.broken);
			} else if (pj.broken != null) {
				Architect.LOGGER.warn("Placing {} can't go on ({}); rolling it back", pj.siteId, pj.broken);
				pj.aborted(srv);
				RestoreJob rb = new RestoreJob(pj.siteId, RestoreJob.ROLLBACK, pj.batchId, pj.itemKey);
				rb.why = pj.broken;
				JOBS.add(rb);
			} else if (!pj.placedReported) {
				Batches.placed(srv, pj);
			}
		} else if (j instanceof InfraJob ij) {
			if (ij.broken != null && ij.beforeRecord) {
				Architect.LOGGER.warn("Placing {} failed before its first cell ({})", ij.siteId, ij.broken);
				ij.aborted(srv);
				SiteJournal.releaseGroup(SiteJournal.entries(ij.siteId).stream().filter(m -> m.status() == dev.larattalabs.architect.journal.Journal.Status.PLACING)
					.map(dev.larattalabs.architect.journal.JournalStore.Meta::id).toList());
				ij.failed(ij.broken);
				Batches.infraFailed(srv, ij, ij.broken);
			} else if (ij.broken != null) {
				Architect.LOGGER.warn("Placing {} can't go on ({}); rolling it back", ij.siteId, ij.broken);
				// (T4a fix round, P2 finding 6) its extra targets wrote nothing: their entries released and their records dropped, as the unclean
				// start does (else they stay placing with no job)
				for (InfraJob.Extra e : ij.extras) {
					try {
						SiteJournal.release(e.record.id());
					} catch (Sites.SiteException x) {
						Architect.LOGGER.warn("Region target {}: its entry could not be released: {}", e.record.id(), x.getMessage());
					}
					Infras.drop(srv, e.record.id());
				}
				ij.failed(ij.broken);
				RestoreJob rb = new RestoreJob(ij.siteId, RestoreJob.ROLLBACK, ij.batchId, ij.itemKey);
				rb.why = ij.broken;
				JOBS.add(rb);
			} else if (!ij.placedReported) {
				Batches.infraPlaced(srv, ij);
			}
		} else if (j instanceof RestoreJob rj) {
			if (rj.infraDone != null && RestoreJob.REMOVE.equals(rj.purpose) && rj.group != null && !rj.group.startsWith("u:remove-")) {
				Groups.removed(srv, rj);
			} else if (rj.infraDone != null && RestoreJob.REMOVE.equals(rj.purpose)) {
				// a single road or cell site removal: its futures were completed, unless it broke after its restore (T4b, finding 6: a refused
				// credit save threw past infraDone): then they fail, never left pending
				if (rj.broken != null) {
					rj.futures.forEach(f -> f.completeExceptionally(new IllegalStateException(rj.broken)));
				}
			} else if (RestoreJob.ROLLBACK.equals(rj.purpose)) {
				Batches.rolledBack(srv, rj);
			} else if (rj.group != null && rj.group.startsWith("u:remove-")) {
				// a single site removed over ticks (a large one): its futures were completed
				if (rj.broken != null) {
					rj.futures.forEach(f -> f.completeExceptionally(new IllegalStateException(rj.broken)));
				}
			} else {
				Groups.removed(srv, rj);
			}
		}
		save(srv, false);
	}

	/** Starts a job (it gets budget from this tick on). */
	static void add(MinecraftServer srv, Job j) {
		JOBS.add(j);
		save(srv, false);
	}

	/** The job writing {@code siteId}, or null. */
	static @Nullable Job job(String siteId) {
		for (Job j : JOBS) {
			if (j.siteId().equals(siteId)) {
				return j;
			}
		}
		return null;
	}

	/** {done, total} of a placing site's job; null when none runs. */
	public static int @Nullable [] progress(String siteId) {
		Job j = job(siteId);
		return j == null ? null : new int[] {j.progress(), j.total()};
	}

	/**
	 * Takes a placing site's job out (Remove during placing, a cancel): it never writes again and its held-back ticks are
	 * dropped. The batch learns its item failed. The caller restores the box. Server thread.
	 */
	static void abort(MinecraftServer srv, String siteId, String why) {
		Job j = job(siteId);
		if (j == null) {
			return;
		}
		JOBS.remove(j);
		j.aborted(srv);
		clearGhost(srv, j, false);
		if (j instanceof PlaceJob pj) {
			Batches.aborted(srv, pj, why);
		}
		save(srv, false);
	}

	/** Cancels a placing job by rolling its site back over ticks ({@code cancelBatch}). Server thread. */
	static void rollBack(MinecraftServer srv, String siteId, String why) {
		Job j = job(siteId);
		if (!(j instanceof PlaceJob pj)) {
			return;
		}
		if (pj.phase == PlaceJob.TAKE_UP) {
			// (T4a fix round, finding 4.1) placed, its take-ups booking: past the point of no rollback (a cancel finds it done)
			Architect.LOGGER.info("Placing {}: not rolled back ({}): it is placed, only its take-ups are being booked", siteId, why);
			return;
		}
		JOBS.remove(j);
		pj.aborted(srv);
		clearGhost(srv, j, false);
		RestoreJob rb = new RestoreJob(siteId, RestoreJob.ROLLBACK, pj.batchId, pj.itemKey);
		rb.why = why;
		JOBS.add(rb);
		save(srv, false);
	}

	static List<Job> jobs() {
		return List.copyOf(JOBS);
	}

	/** The jobs as JSON (DevBridge {@code dev.placement.jobs}). Server thread. */
	public static JsonArray jobsJson() {
		JsonArray a = new JsonArray();
		for (Job j : JOBS) {
			JsonObject o = new JsonObject();
			o.addProperty("site", j.siteId());
			o.addProperty("kind", j.kind());
			if (j.batchId() != null) {
				o.addProperty("batch", j.batchId());
			}
			o.addProperty("progress", j.progress());
			o.addProperty("total", j.total());
			if (j instanceof PlaceJob pj) {
				o.addProperty("phase", pj.phase);
				o.addProperty("item", pj.itemKey);
				o.addProperty("held", pj.held.size());
				o.addProperty("takeUp", pj.phase == PlaceJob.TAKE_UP); // (T4a fix round) placed, its take-ups booking
			} else if (j instanceof InfraJob ij) {
				o.addProperty("takeUp", ij.phase == InfraJob.TAKE_UP);
			}
			a.add(o);
		}
		return a;
	}

	// ------------------------------------------------------------------ persistence

	private static Path file(MinecraftServer srv) {
		return srv.getWorldPath(LevelResource.ROOT).resolve(FILE);
	}

	/**
	 * (Slice PS, audit F6) The queue file could not be read at this world's start: the queue started empty, and nothing is saved over the
	 * file this session (it holds in-flight removals' refund credits); {@code architect-queue.json.bak} is the last file that loaded.
	 */
	private static volatile boolean loadFailed;
	private static boolean refusedLogged;

	/** (PS) Whether the queue file failed to load this session. */
	public static boolean loadFailed() {
		return loadFailed;
	}

	/**
	 * Writes the queue file: batches, jobs with their cursors, group removals. {@code clean}: the server is stopping. Answers this save's
	 * generation (slice PSV; {@link #written}), or {@link #NOT_SAVED} when nothing is saved this session ({@link #loadFailed}).
	 */
	static long save(MinecraftServer srv, boolean clean) {
		if (loadFailed) {
			if (!refusedLogged) {
				refusedLogged = true;
				Architect.LOGGER.error("Placement: not saved: {} failed to load this session; the file is kept as it is", FILE);
			}
			return NOT_SAVED;
		}
		JsonObject root = new JsonObject();
		root.addProperty("version", 1);
		root.addProperty("clean", clean);
		root.add("batches", Batches.toJson());
		root.addProperty("nextBatch", Batches.nextNumber());
		JsonArray jobs = new JsonArray();
		JOBS.forEach(j -> jobs.add(j.toJson()));
		root.add("jobs", jobs);
		root.add("removals", Groups.toJson());
		Path f = file(srv);
		long gen = durable(f).request(); // (slice PSV) this save's generation: the state as it is now (slice PSVLC3: T0's DurableFile numbers it)
		requestedGen = gen;
		saveWanted = false; // (LC3 fix 2)
		// phase 4e: the file holds the queued cell sites' cells (a 256x256 pad is megabytes of JSON): it is written off the
		// server thread, the latest state winning; a clean stop waits for it and writes at once
		PENDING_SAVE.set(new Object[] {root, f, gen});
		if (clean) {
			flushSaves();
			writeSave(root, f, gen);
			return gen;
		}
		SAVER.execute(() -> {
			Object[] w = PENDING_SAVE.getAndSet(null);
			if (w != null) {
				writeSave((JsonObject) w[0], (Path) w[1], (Long) w[2]);
			}
		});
		return gen;
	}

	/** (slice PSV) {@link #save}'s answer when nothing is saved this session (the file failed to load): never {@link #written}. */
	static final long NOT_SAVED = -1;

	/**
	 * (slice PSV, lifted from LC3 fix 2) Queue file generations: every {@link #save} takes the next number ({@link #requestedGen}, server
	 * thread); a write that completed (written, forced to disk, renamed; no exception) raises {@link #writtenGen} to its number. The saves
	 * coalesce (the latest state wins), and a generation's file holds every change made before it was requested, so {@code writtenGen >= g}
	 * means the state as of generation {@code g}'s request is on disk. A failed write raises nothing and asks for a retry ({@link #failedGen},
	 * every 5 s from the tick). An undo's pre-save (Groups' preSaved, RestoreJob's groupSaved) waits until its generation is written.
	 */
	private static long requestedGen;
	private static final java.util.concurrent.atomic.AtomicLong WRITTEN_GEN = new java.util.concurrent.atomic.AtomicLong();
	private static volatile long failedGen;
	/** (LC3 fix 2) A save asked for outside a save point (the seal's linger); the tick saves. */
	private static boolean saveWanted;
	private static long retryAt;
	private static boolean failLogged;
	/** (TEST, units and the dev hook {@code dev.queue.failWrites}) The next writes that fail before writing: a full disk, a read-only world folder. */
	static final java.util.concurrent.atomic.AtomicInteger FAIL_WRITES = new java.util.concurrent.atomic.AtomicInteger();

	/**
	 * (PSV fix round, TEST: the dev hook's {@code failAtPreSave}) Armed (> 0): the next undo pre-save (Groups' preSaved, RestoreJob's
	 * groupSaved) sets {@link #FAIL_WRITES} to this many, so the failure starts after R1 (the preflight already written): the replan path.
	 */
	static final java.util.concurrent.atomic.AtomicInteger FAIL_AT_PRESAVE = new java.util.concurrent.atomic.AtomicInteger();

	/**
	 * (slice PSVLC3) The queue file's durable writer: T0's {@link DurableFile} (temp file forced, atomic rename, the folder forced; generations
	 * persisted in the file), which lifted PSV's own writer out. One per queue file path, made fresh when a world loads. IN_DOUBT (the rename
	 * done, a later force failed) is not written here: no commit and no unseal waits on it, and the retry writes again.
	 */
	private static volatile @Nullable DurableFile queueFile;
	private static final Object QUEUE_FILE_LOCK = new Object();

	static DurableFile durable(Path f) {
		DurableFile d = queueFile;
		if (d == null || !d.file().equals(f)) {
			synchronized (QUEUE_FILE_LOCK) {
				d = queueFile;
				if (d == null || !d.file().equals(f)) {
					d = new DurableFile("queue", f);
					queueFile = d;
				}
			}
		}
		return d;
	}

	/**
	 * (PSV fix round; v0.77.0 fix a1) Whether a write at or after generation {@code gen} failed. Sticky: a later write that succeeds does not
	 * clear it (before, it did, so an undo whose pre-save failed and whose look came after the retry committed the tally made before the
	 * failure: a block mined meanwhile paid out twice). The holder replans, which takes a new generation (above {@link #failedGen}).
	 * Conservative: a write failing after {@code gen} was written counts too (a replan, never a stale commit).
	 */
	static boolean failed(long gen) {
		return gen > 0 && failedGen >= gen;
	}

	/**
	 * (PSV fix round, GPT P1 3) A removal's preflight: before it touches anything (fluids, custody, crate stock, refund tallies), a queue save
	 * it asked for is confirmed written and no write has failed since. {@link #ready} answers false while one is pending or writes fail (then it
	 * asks again once Placement's retry wrote the file); the caller checks {@link #loadFailed} first. Server thread; not saved.
	 */
	static final class Preflight {
		long gen;

		boolean ready(java.util.function.LongSupplier save) {
			if (gen > 0) {
				if (written(gen)) {
					if (!writeFailing()) {
						return true;
					}
					gen = 0; // a later write failed: wait for the retry, then ask again
					return false;
				}
				if (!failed(gen)) {
					return false; // pending (the saver is off the server thread)
				}
				gen = 0;
			}
			if (writeFailing()) {
				return false;
			}
			gen = save.getAsLong();
			return false;
		}
	}

	/**
	 * (PSV fix round) An undo's pre-save: {@link #save}, with the TEST arm {@link #FAIL_AT_PRESAVE} applied first (its failures start with this
	 * write). Server thread.
	 */
	static long preSave(MinecraftServer srv) {
		int n = FAIL_AT_PRESAVE.getAndSet(0);
		if (n > 0) {
			FAIL_WRITES.set(n);
			Architect.LOGGER.info("Placement: TEST: the undo pre-save's write and the next {} fail", n - 1);
		}
		return save(srv, false);
	}

	/** (PSV) The last generation requested (server thread). */
	static long requestedGen() {
		return requestedGen;
	}

	/** (PSV) The highest generation whose write completed. Any thread. */
	static long writtenGen() {
		return WRITTEN_GEN.get();
	}

	/** (PSV) Whether generation {@code gen} (a {@link #save}'s answer) is on disk: a later completed write counts. {@link #NOT_SAVED} never is. */
	static boolean written(long gen) {
		return gen != NOT_SAVED && WRITTEN_GEN.get() >= gen;
	}

	/**
	 * (slice PSV, TEST: the dev hook {@code dev.queue.writes}) Sets the next queue writes to fail ({@code fail} >= 0; null leaves it) and
	 * answers the generations: requested, written, whether a write is failing, the injected failures left. Server thread.
	 */
	public static JsonObject devWrites(@Nullable Integer fail) {
		return devWrites(fail, null);
	}

	/** {@link #devWrites}; {@code failAtPreSave} (PSV fix round, TEST: >= 0; 0 disarms): the next undo pre-save arms that many failures. */
	public static JsonObject devWrites(@Nullable Integer fail, @Nullable Integer failAtPreSave) {
		if (fail != null) {
			FAIL_WRITES.set(Math.max(0, fail));
		}
		if (failAtPreSave != null) {
			FAIL_AT_PRESAVE.set(Math.max(0, failAtPreSave));
		}
		JsonObject o = new JsonObject();
		o.addProperty("requestedGen", requestedGen);
		o.addProperty("writtenGen", writtenGen());
		o.addProperty("writeFailing", writeFailing());
		o.addProperty("failWrites", Math.max(0, FAIL_WRITES.get()));
		o.addProperty("loadFailed", loadFailed);
		o.addProperty("failAtPreSave", Math.max(0, FAIL_AT_PRESAVE.get()));
		return o;
	}

	/** (PSV) Whether the latest write failed and no later one has completed (a retry is due). */
	static boolean writeFailing() {
		return failedGen > WRITTEN_GEN.get();
	}

	/** (LC3 fix 2) A save at the next tick (the caller may be in the middle of a change: the seal check runs from mixins). */
	static void wantSave() {
		saveWanted = true;
	}

	/** (PSV) The tick's save point: a failed write's retry, every 5 s while it fails; (LC3 fix 2) a wanted save. Server thread. */
	private static void saveIfDue(MinecraftServer srv) {
		if (loadFailed) {
			return;
		}
		if (writeFailing()) {
			if (!failLogged) {
				failLogged = true;
				Architect.LOGGER.error("Placement: the queue file could not be written (generation {}); retrying every 5 s; an undo waiting on it "
					+ "is not committed, and boxes whose removal ended stay sealed, until it is written", failedGen);
			}
			if (srv.getTickCount() >= retryAt) {
				retryAt = srv.getTickCount() + 100;
				save(srv, false);
			}
			return;
		}
		if (failLogged) {
			failLogged = false;
			Architect.LOGGER.info("Placement: the queue file is written again (generation {})", writtenGen());
		}
		if (saveWanted) {
			save(srv, false);
		}
	}

	private static final java.util.concurrent.atomic.AtomicReference<Object[]> PENDING_SAVE = new java.util.concurrent.atomic.AtomicReference<>();
	private static final java.util.concurrent.ExecutorService SAVER = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect queue save");
		t.setDaemon(true);
		return t;
	});

	/** Waits until the queued saves are written. */
	static void flushSaves() {
		try {
			SAVER.submit(() -> { }).get();
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
		} catch (java.util.concurrent.ExecutionException e) {
			// a failed write was logged
		}
		PENDING_SAVE.set(null);
	}

	/** (T2b last round, TEST dev.stockpile.ps failQueueWrites) the queue file's writes fail (as a full disk) while true. */
	static volatile boolean TEST_FAIL_WRITES;

	/**
	 * Writes one generation of the queue file: a temporary file forced to disk, renamed over the file, then the folder forced (slice PSV and
	 * its fix round: the generation counts as written only once all three are done). Answers whether it was written.
	 */
	static synchronized boolean writeSave(JsonObject root, Path f, long gen) {
		if (FAIL_WRITES.get() > 0 && FAIL_WRITES.getAndDecrement() > 0) {
			failedGen = Math.max(failedGen, gen);
			Architect.LOGGER.warn("Could not save {} (generation {}): injected queue write failure (TEST)", f, gen);
			return false;
		}
		if (TEST_FAIL_WRITES) {
			failedGen = Math.max(failedGen, gen);
			Architect.LOGGER.warn("Could not save {} (generation {}): injected queue write failure (TEST dev.stockpile.ps failQueueWrites)", f, gen);
			return false;
		}
		DurableFile.Result r = durable(f).write(root, gen);
		if (!r.ok()) {
			// REFUSED (the file on disk is the previous one) or IN_DOUBT (it may or may not survive a power loss): neither counts as written
			failedGen = Math.max(failedGen, gen);
			Architect.LOGGER.warn("Could not save {} (generation {}): {} {}", f, gen, r.outcome(), r.reason());
			return false;
		}
		WRITTEN_GEN.accumulateAndGet(gen, Math::max);
		return true;
	}

	private static void load(MinecraftServer srv) {
		server = srv;
		JOBS.clear();
		loadFailed = false;
		refusedLogged = false;
		saveWanted = false; // (LC3 fix 2) a new world: no retry carried over
		failedGen = 0; // (PSV) a new world: no retry carried over
		failLogged = false;
		retryAt = 0;
		{
			// (slice PSVLC3) the world's queue file numbers its generations on from the one it carries (DurableFile, confirmed at load)
			DurableFile d = new DurableFile("queue", file(srv));
			queueFile = d;
			requestedGen = d.writtenGen();
			WRITTEN_GEN.set(d.writtenGen());
		}
		Path f = file(srv);
		JsonObject root = null;
		if (Files.exists(f)) {
			try {
				root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			} catch (IOException | RuntimeException e) {
				// (PS, F6) the file is kept as it is: no save this session (before PS the next save wrote an empty queue over it)
				loadFailed = true;
				String why = "unreadable: " + e.getClass().getSimpleName() + (e.getMessage() == null ? "" : ": " + e.getMessage());
				Architect.LOGGER.error("Could not read {} ({}); the queue starts empty and is not saved this session, so the file is kept as it is; fix it or "
					+ "restore {} and reopen the world", f, why, FILE + ".bak", e);
				SaveGuards.failed(FILE, why);
			}
			if (root != null) {
				try {
					Files.copy(f, f.resolveSibling(FILE + ".bak"), StandardCopyOption.REPLACE_EXISTING); // (PS, F6) the last file that loaded
				} catch (IOException e) {
					Architect.LOGGER.warn("Could not keep {}.bak", f, e);
				}
			}
		}
		boolean clean = root != null && root.has("clean") && root.get("clean").getAsBoolean();
		if (root != null) {
			Batches.load(root.has("batches") ? root.getAsJsonArray("batches") : new JsonArray(), root.has("nextBatch") ? root.get("nextBatch").getAsInt() : 1);
			Groups.load(root.has("removals") ? root.getAsJsonArray("removals") : new JsonArray());
			for (JsonElement e : root.has("jobs") ? root.getAsJsonArray("jobs") : new JsonArray()) {
				try {
					resume(srv, e.getAsJsonObject(), clean);
				} catch (RuntimeException ex) {
					Architect.LOGGER.warn("Could not resume a placement job {}", e, ex);
				}
			}
		}
		// a site still marked placing without a job (its queue entry was lost): put its terrain back
		for (Site s : Sites.all()) {
			if (s.placing() && job(s.id()) == null) {
				dev.larattalabs.architect.journal.JournalStore.Meta main = SiteJournal.main(s.id());
				if (main != null && main.status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE && s.construction() == null) {
					// K4: the ACTIVE commit (P7) reached the journal before the record was placed (P8): the journal wins
					Architect.LOGGER.warn("Site {} was placed in the world journal but its record was still placing; it is placed", s.id());
					Sites.putRecord(srv, s.withPlacing(false));
					continue;
				}
				Architect.LOGGER.warn("Site {} was still being placed and has no job in {}; rolling it back from its snapshot", s.id(), FILE);
				Site.Member m = s.member();
				RestoreJob rb = new RestoreJob(s.id(), RestoreJob.ROLLBACK, m == null ? null : m.batchId(), m == null ? null : m.itemKey());
				rb.requeue = true;
				JOBS.add(rb);
			}
		}
		if (root != null || !JOBS.isEmpty()) {
			Architect.LOGGER.info("Placement queue: {} batch(es) running, {} job(s) to resume{}", Batches.running(), JOBS.size(),
				clean || JOBS.isEmpty() ? "" : " (the last stop was not clean: placing jobs roll back and their items queue again)");
			save(srv, false); // not clean any more until the next stop
		}
	}

	private static void resume(MinecraftServer srv, JsonObject o, boolean clean) {
		String kind = o.get("kind").getAsString();
		if ("place".equals(kind)) {
			PlaceJob pj = PlaceJob.fromJson(o);
			ServerLevel level = Sites.levelOf(srv, pj.dimension);
			if (pj.beforeRecord) {
				// stopped before its record (P1-P3): a clean stop resumes (the commit was flushed); after a crash its entries were
				// released at the world start (K2) and its item queues again
				if (clean && level != null) {
					if (pj.phase == PlaceJob.CAPTURE || pj.siteEntry == null) {
						try {
							pj.startCapture(level);
						} catch (Sites.SiteException e) {
							Batches.requeue(srv, pj, "it could not resume (" + e.getMessage() + ")");
							return;
						}
					} else {
						pj.phase = PlaceJob.COMMIT;
					}
					JOBS.add(pj);
					Architect.LOGGER.info("Resuming the placement of {} ({}) before its first block", pj.siteId, pj.blueprint);
				} else {
					Batches.requeue(srv, pj, "the game stopped without saving before it was placed");
				}
				return;
			}
			Site s = Sites.get(pj.siteId);
			if (s == null) {
				Architect.LOGGER.warn("Placement job for {} has no site record; dropped", pj.siteId);
				return;
			}
			if (pj.phase == PlaceJob.TAKE_UP && level != null) {
				// (T4a fix round, finding 4.1) placed (its record and its journal entry), only its take-ups left: never rolled back, clean or not
				JOBS.add(pj);
				Architect.LOGGER.info("Finishing the take-ups of {} ({}) (it is placed)", pj.siteId, pj.blueprint);
				return;
			}
			boolean active = SiteJournal.main(pj.siteId) != null && SiteJournal.main(pj.siteId).status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE;
			if ((pj.phase == PlaceJob.AFTER_COMMIT || pj.phase == PlaceJob.CONSTRUCTION_CLEAR) && active && level != null) {
				// K4: the journal wins (its ACTIVE commit is durable); a construction site's clearing starts over
				if (pj.phase == PlaceJob.CONSTRUCTION_CLEAR) {
					pj.clearCursor = 0;
				}
				JOBS.add(pj);
				Architect.LOGGER.info("Finishing the placement of {} ({}) (its journal entry is placed)", pj.siteId, pj.blueprint);
				return;
			}
			if (pj.phase == PlaceJob.AFTER) {
				pj.captureCursor = 0;
			}
			if (!clean || level == null || !pj.resume(level)) {
				RestoreJob rb = new RestoreJob(pj.siteId, RestoreJob.ROLLBACK, pj.batchId, pj.itemKey);
				rb.requeue = !clean;
				rb.why = !clean ? "the game stopped without saving while it was being placed" : "it could not resume";
				JOBS.add(rb);
				return;
			}
			JOBS.add(pj);
			Architect.LOGGER.info("Resuming the placement of {} ({}) at phase {}", pj.siteId, pj.blueprint, pj.phase);
		} else if ("infra".equals(kind)) {
			InfraJob ij = InfraJob.fromJson(o);
			if (ij.beforeRecord && !clean) {
				Batches.infraRequeue(srv, ij);
				return;
			}
			if (ij.beforeRecord && ij.phase == InfraJob.CAPTURE) {
				Batches.infraRequeue(srv, ij); // its capture was not saved: planned again
				return;
			}
			if (!ij.beforeRecord && !clean && ij.phase != InfraJob.TAKE_UP) { // (T4a fix round) a placed road's take-ups only: resumed as they are
				boolean active = SiteJournal.main(ij.siteId) != null && SiteJournal.main(ij.siteId).status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE;
				if (!active) {
					// (6c RS) the extra targets wrote nothing: their entries are released and their records dropped (the main rolls back)
					for (InfraJob.Extra e : ij.extras) {
						try {
							SiteJournal.release(e.record.id());
						} catch (Sites.SiteException x) {
							Architect.LOGGER.warn("Region target {}: its entry could not be released: {}", e.record.id(), x.getMessage());
						}
						Infras.drop(srv, e.record.id());
					}
					RestoreJob rb = new RestoreJob(ij.siteId, RestoreJob.ROLLBACK, ij.batchId, ij.itemKey);
					rb.requeue = true;
					rb.why = "the game stopped without saving while it was being placed";
					JOBS.add(rb);
					return;
				}
				ij.phase = InfraJob.AFTER_COMMIT;
			}
			JOBS.add(ij);
		} else {
			RestoreJob rj = RestoreJob.fromJson(o);
			if (Sites.get(rj.siteId) != null || Sites.pendingRecord(rj.siteId) != null || Infras.get(rj.siteId) != null || Infras.pending(rj.siteId) != null) {
				JOBS.add(rj);
			}
		}
	}

	/**
	 * The sites whose undo groups and PLACING entries the world-start settle must leave alone: those with a job in the queue
	 * file that resumes or rolls back (after a crash, a placement that never got its record is not one: K2 releases it).
	 */
	static java.util.Set<String> jobSites(MinecraftServer srv) {
		java.util.Set<String> out = new java.util.HashSet<>();
		Path f = file(srv);
		if (!Files.exists(f)) {
			return out;
		}
		try {
			JsonObject root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			boolean clean = root.has("clean") && root.get("clean").getAsBoolean();
			for (JsonElement e : root.has("jobs") ? root.getAsJsonArray("jobs") : new JsonArray()) {
				JsonObject o = e.getAsJsonObject();
				String k = o.get("kind").getAsString();
				boolean before = ("place".equals(k) || "infra".equals(k)) && o.has("beforeRecord") && o.get("beforeRecord").getAsBoolean();
				if (clean || !before) {
					out.add(o.get("siteId").getAsString());
					// (6c RS) a region tile's extra targets: placed by the same job
					if (o.get("extras") instanceof JsonArray x) {
						x.forEach(xe -> out.add(xe.getAsJsonObject().getAsJsonObject("record").get("id").getAsString()));
					}
				}
			}
			for (JsonElement e : root.has("removals") ? root.getAsJsonArray("removals") : new JsonArray()) {
				JsonObject o = e.getAsJsonObject();
				if (o.has("sites")) {
					o.getAsJsonArray("sites").forEach(x -> out.add(x.getAsString()));
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {} for the sites check", f, e);
		}
		return out;
	}

	// ------------------------------------------------------------------ stats (the gate's MSPT and throughput)

	/** Server tick times and the budget's use while placement is active; {@code dev.placement.stats}. */
	/** Phase 6a, dev.mspt.trace: this tick's start and Architect's write time in it. */
	/** ARCHITECT_TRACE_JOBS: the parts of a placement tick over 25 ms (phase 6a, MSPT). */
	static final boolean TRACE = System.getenv("ARCHITECT_TRACE_JOBS") != null;
	private static final StringBuilder SLOW = new StringBuilder();

	/** Notes a part of this tick that took 2 ms or more (traced only). */
	static void lap(String what, long since) {
		if (TRACE) {
			long ns = System.nanoTime() - since;
			if (ns >= 2_000_000L) {
				SLOW.append(' ').append(what).append('=').append(String.format(java.util.Locale.ROOT, "%.1f", ns / 1e6));
			}
		}
	}

	private static long traceStart;
	private static long traceWork;
	/** (6c 0a) Architect's work in this tick in the server thread's CPU time (ns; -1 when the JVM can't tell). */
	private static long traceCpu;

	private static final java.lang.management.ThreadMXBean THREADS = java.lang.management.ManagementFactory.getThreadMXBean();
	private static final boolean CPU = THREADS.isCurrentThreadCpuTimeSupported();

	/**
	 * (6b) The server thread's CPU time (ns), or -1 when the JVM can't tell. Architect's own per-tick time for the MSPT bars: the
	 * wall time of a placement tick also counts the thread being descheduled on a busy machine and GC pauses, which are not ours.
	 */
	static long cpuNow() {
		return CPU ? THREADS.getCurrentThreadCpuTime() : -1;
	}

	static final class Stats {
		long cpuTicks;
		long cpuSum;
		long cpuMax;

		void workCpu(long nanos) {
			if (nanos < 0) {
				return;
			}
			cpuTicks++;
			cpuSum += nanos;
			cpuMax = Math.max(cpuMax, nanos);
		}

		long ticks;
		long tickSum;
		long tickMax;
		int over50;
		long workTicks;
		long workSum;
		long workMax;
		long cells;
		long firstWorkAt;
		long lastWorkAt;

		/** Starts timing a tick (the server's tick, then every end-of-tick handler). */
		void startTick(MinecraftServer s, boolean activeNow) {
			tickStart = System.nanoTime();
			tickActive = activeNow;
		}

		/** After every other end-of-tick handler: records the tick's full time when placement was active in it. */
		void endTick(MinecraftServer s) {
			if (!tickActive || tickStart == 0) {
				return;
			}
			long t = System.nanoTime() - tickStart;
			ticks++;
			tickSum += t;
			tickMax = Math.max(tickMax, t);
			if (t > 50_000_000L) {
				over50++;
			}
			// the server's own measure (without end-of-tick handlers), for reference
			long v = s.getTickTimesNanos()[s.getTickCount() % 100];
			serverMax = Math.max(serverMax, v);
		}

		long tickStart;
		long startMax;
		long convertMax;
		boolean tickActive;
		long serverMax;

		void work(long nanos, int handled) {
			tickActive = true;
			workTicks++;
			workSum += nanos;
			workMax = Math.max(workMax, nanos);
			cells += handled;
			long now = System.nanoTime();
			if (handled > 0) {
				if (firstWorkAt == 0) {
					firstWorkAt = now;
				}
				lastWorkAt = now;
			}
		}

		void reset() {
			tickActive = false;
			ticks = tickSum = tickMax = serverMax = startMax = convertMax = workTicks = workSum = workMax = cells = firstWorkAt = lastWorkAt = 0;
			cpuTicks = cpuSum = cpuMax = 0;
			over50 = 0;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("budgetMs", SurvivalWorld.placementBudgetMs());
			o.addProperty("ticks", ticks);
			o.addProperty("msptMax", tickMax / 1e6);
			o.addProperty("msptMean", ticks == 0 ? 0 : tickSum / 1e6 / ticks);
			o.addProperty("ticksOver50ms", over50);
			o.addProperty("serverMsptMax", serverMax / 1e6);
			o.addProperty("jobStartMsMax", startMax / 1e6);
			o.addProperty("convertMsMax", convertMax / 1e6);
			o.addProperty("placementTicks", workTicks);
			o.addProperty("placementMsMax", workMax / 1e6);
			o.addProperty("placementMsMean", workTicks == 0 ? 0 : workSum / 1e6 / workTicks);
			// (6b) the same ticks in the server thread's CPU time (descheduling and GC pauses excluded); absent when unsupported
			if (cpuTicks > 0) {
				o.addProperty("placementCpuMsMax", cpuMax / 1e6);
				o.addProperty("placementCpuMsMean", cpuSum / 1e6 / cpuTicks);
			}
			o.addProperty("cells", cells);
			double secs = (lastWorkAt - firstWorkAt) / 1e9;
			o.addProperty("workSeconds", secs);
			o.addProperty("cellsPerSecond", secs <= 0 ? 0 : cells / secs);
			o.addProperty("active", active());
			o.addProperty("jobs", JOBS.size());
			return o;
		}
	}

	/** A job's start (checks, snapshot capture and write, leaf hold), timed: the unsliced part of a placement. */
	static void noteStart(String siteId, long nanos) {
		STATS.startMax = Math.max(STATS.startMax, nanos);
		Architect.LOGGER.info("Placement of {} started in {} ms (checks, snapshot, leaf ring and hold)", siteId, String.format("%.2f", nanos / 1e6));
	}

	/** A construction site's conversion (target capture and write, clearing its cells, the crate), timed. */
	static void noteConvert(String siteId, long nanos) {
		STATS.convertMax = Math.max(STATS.convertMax, nanos);
		Architect.LOGGER.info("Construction site {} converted in {} ms", siteId, String.format("%.2f", nanos / 1e6));
	}

	/** The stats as JSON ({@code reset}: start over after reading). Server thread. */
	public static JsonObject stats(boolean reset) {
		JsonObject o = STATS.toJson();
		if (reset) {
			STATS.reset();
		}
		return o;
	}
}
