package dev.larattalabs.architect.site;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
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

	private static final List<Job> JOBS = new ArrayList<>();
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
		if (srv.getTickCount() < START_GRACE_TICKS) {
			return;
		}
		if (!SaveHold.jobsAdmitted(srv)) {
			return; // (slice SOFF) every job (placements, removals, restores, batches, groups) parks between steps while saving is off
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
			completedNow = false;
			t1 = System.nanoTime();
			runJobs(srv);
			lap("jobs", t1);
			// phase 4e: a job that finished leaves budget: its batch starts the next item in this tick, not the next one
			for (int again = 0; again < 4 && completedNow && !slow && System.nanoTime() < deadline; again++) {
				completedNow = false;
				Batches.startNext(srv, deadline);
				runJobs(srv);
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
			} else {
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
				ij.failed(ij.broken);
				RestoreJob rb = new RestoreJob(ij.siteId, RestoreJob.ROLLBACK, ij.batchId, ij.itemKey);
				rb.why = ij.broken;
				JOBS.add(rb);
			} else {
				Batches.infraPlaced(srv, ij);
			}
		} else if (j instanceof RestoreJob rj) {
			if (rj.infraDone != null && RestoreJob.REMOVE.equals(rj.purpose) && rj.group != null && !rj.group.startsWith("u:remove-")) {
				Groups.removed(srv, rj);
			} else if (rj.infraDone != null && RestoreJob.REMOVE.equals(rj.purpose)) {
				// a single road or cell site removal: its futures were completed
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

	/** Writes the queue file: batches, jobs with their cursors, group removals. {@code clean}: the server is stopping. */
	static void save(MinecraftServer srv, boolean clean) {
		if (loadFailed) {
			if (!refusedLogged) {
				refusedLogged = true;
				Architect.LOGGER.error("Placement: not saved: {} failed to load this session; the file is kept as it is", FILE);
			}
			return;
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
		// phase 4e: the file holds the queued cell sites' cells (a 256x256 pad is megabytes of JSON): it is written off the
		// server thread, the latest state winning; a clean stop waits for it and writes at once
		PENDING_SAVE.set(new Object[] {root, f});
		if (clean) {
			flushSaves();
			writeSave(root, f);
			return;
		}
		SAVER.execute(() -> {
			Object[] w = PENDING_SAVE.getAndSet(null);
			if (w != null) {
				writeSave((JsonObject) w[0], (Path) w[1]);
			}
		});
	}

	private static final java.util.concurrent.atomic.AtomicReference<Object[]> PENDING_SAVE = new java.util.concurrent.atomic.AtomicReference<>();
	private static final java.util.concurrent.ExecutorService SAVER = java.util.concurrent.Executors.newSingleThreadExecutor(r -> {
		Thread t = new Thread(r, "Architect queue save");
		t.setDaemon(true);
		return t;
	});

	/**
	 * (fix/drain-holders) Completes once every save queued so far is written (a failed write is logged): the saver is one thread and runs
	 * in order. Off the server thread, unlike {@link #flushSaves}.
	 */
	static java.util.concurrent.CompletableFuture<Void> saved() {
		return java.util.concurrent.CompletableFuture.runAsync(() -> { }, SAVER);
	}

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

	private static synchronized void writeSave(JsonObject root, Path f) {
		try {
			Path tmp = f.resolveSibling(FILE + ".tmp");
			Files.writeString(tmp, GSON.toJson(root), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	private static void load(MinecraftServer srv) {
		server = srv;
		JOBS.clear();
		devArm(srv); // (slice PLR2) TEST only
		loadFailed = false;
		refusedLogged = false;
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
		rollBackStrayInfras(srv); // (slice PLR) the same for a road or cell site
		if (root != null || !JOBS.isEmpty()) {
			Architect.LOGGER.info("Placement queue: {} batch(es) running, {} job(s) to resume{}", Batches.running(), JOBS.size(),
				clean || JOBS.isEmpty() ? "" : " (the last stop was not clean: placing jobs roll back and their items queue again)");
			save(srv, false); // not clean any more until the next stop
		}
		if (extrasSettled) {
			extrasSettled = false;
			if ("PLR2X".equals(WorldJournal.armed())) {
				// (slice PLR2) TEST: a second halt once the start's queue save (past the stale job) is written, a crash rollback's extra targets
				// just settled
				flushSaves();
				WorldJournal.kill("PLR2X");
			}
		}
	}

	/** (slice PLR2) This start's crash rollbacks settled a region tile's extra targets (the PLR2X kill point). */
	private static boolean extrasSettled;

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
			if (recordOutranQueue(ij.beforeRecord, clean, Infras.get(ij.siteId))) {
				// (slice PLR) its record reached the sites file placing (P4) after this job was last saved: queued again it left the record placing
				// for good. It rolls back, its item held PLACING until the restore ends, even when its entry is ACTIVE: a job saved before P4 can't
				// finish (its cells are not in it, and an ACTIVE commit does not say the world's chunks were saved; the undo restores only cells
				// that still hold its after)
				Architect.LOGGER.warn("Cell site {}'s record was saved placing after {} last saved its job; rolling it back", ij.siteId, FILE);
				rollBackAfterCrash(srv, ij);
				return;
			}
			if (ij.beforeRecord && !clean) {
				Batches.infraRequeue(srv, ij);
				return;
			}
			if (ij.beforeRecord && ij.phase == InfraJob.CAPTURE) {
				Batches.infraRequeue(srv, ij); // its capture was not saved: planned again
				return;
			}
			if (!ij.beforeRecord && !clean) {
				boolean active = SiteJournal.main(ij.siteId) != null && SiteJournal.main(ij.siteId).status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE;
				if (!active) {
					rollBackAfterCrash(srv, ij);
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
	 * A road's or cell site's job past its record after an unclean stop, its entry not placed: the extra targets wrote nothing (6c RS), their
	 * entries are released and their records dropped; the main rolls back and its item queues again once restored.
	 */
	private static void rollBackAfterCrash(MinecraftServer srv, InfraJob ij) {
		for (InfraJob.Extra e : ij.extras) {
			String xid = e.record.id();
			dev.larattalabs.architect.journal.JournalStore.Meta xm = SiteJournal.main(xid);
			if (extraRollsBack(xm == null ? null : xm.status(), Infras.get(xid) != null)) {
				// (slice PLR2) an ACTIVE extra target: rolled back by its own tracked job, its record kept until the undo is committed (R3), so a
				// second crash at any point resumes or replays it (a dropped record with an ACTIVE entry was rebuilt from the journal, untracked)
				Architect.LOGGER.warn("Region target {} of {} was committed in the world journal; rolling it back with it", xid, ij.siteId);
				RestoreJob xr = new RestoreJob(xid, RestoreJob.ROLLBACK, ij.batchId, ij.itemKey);
				xr.requeue = true;
				xr.why = "the game stopped without saving while it was being placed";
				JOBS.add(xr);
				continue;
			}
			try {
				SiteJournal.release(xid);
			} catch (Sites.SiteException x) {
				Architect.LOGGER.warn("Region target {}: its entry could not be released: {}", xid, x.getMessage());
			}
			Infras.drop(srv, xid);
		}
		extrasSettled |= !ij.extras.isEmpty();
		RestoreJob rb = new RestoreJob(ij.siteId, RestoreJob.ROLLBACK, ij.batchId, ij.itemKey);
		rb.requeue = true;
		rb.why = "the game stopped without saving while it was being placed";
		JOBS.add(rb);
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

	// ------------------------------------------------------------------ (slice PLR) a cell site's record saved placing past its job

	/**
	 * (slice PLR) Whether a road's or cell site's job read from an unclean stop's queue file is older than its record: the job was saved
	 * before its record ({@code beforeRecord}), but the sites file, written at once at P4, already holds the record placing (the queue file
	 * is written off the server thread, the latest state winning, so a halt right after P4 loses the save that cleared the flag). The record
	 * wins: the job rolls back (its item held until the restore ends), never queued again beside a record that would stay placing for good. A
	 * clean stop's file is current. Pure.
	 */
	static boolean recordOutranQueue(boolean beforeRecord, boolean clean, @Nullable Infra onDisk) {
		return beforeRecord && !clean && onDisk != null && onDisk.placing();
	}

	/**
	 * (slice PLR) The road and cell site records still placing that no job of the queue file covers ({@code covered}: every job's site and a
	 * region tile job's extra targets), in record order: their job was lost with the queue file's last save. Pure.
	 */
	static List<String> strayPlacing(java.util.Collection<Infra> records, java.util.Set<String> covered) {
		List<String> out = new ArrayList<>();
		for (Infra i : records) {
			if (i.placing() && !covered.contains(i.id())) {
				out.add(i.id());
			}
		}
		return out;
	}

	/**
	 * (slice PLR) Whether a rollback of {@code jobSite} may settle its item (queue it again or fail it): only while the item is not done and
	 * names that site or none. An item placed since by another site (a crash's stray record rolled back after its tile was placed again), or
	 * placing again as another site, is left as it is. Pure.
	 */
	static boolean rollbackOwnsItem(dev.larattalabs.architect.batch.QItem.Status status, @Nullable String itemSite, String jobSite) {
		return !status.terminal() && (itemSite == null || itemSite.equals(jobSite));
	}

	/** (slice PLR) The sites the queue's jobs write: every job's site and a region tile job's extra targets. */
	private static java.util.Set<String> jobCovered() {
		java.util.Set<String> out = new java.util.HashSet<>();
		for (Job j : JOBS) {
			out.add(j.siteId());
			if (j instanceof InfraJob ij) {
				out.addAll(ij.siteIds());
			}
		}
		return out;
	}

	/**
	 * (slice PLR) A road or cell site still marked placing with no job covering it (its job was lost with the queue file's last save; see
	 * {@link #recordOutranQueue}): rolled back from the world journal over ticks like a site's, its undo handing its befores down under a
	 * newer entry that placed the same tile again (nothing in the world changes there), its record pending until the next start settles it.
	 * Its item is held PLACING as this site's meanwhile ({@link Batches#holdForRollback}) and queues again only while it still names this site
	 * or none ({@link #rollbackOwnsItem}), after the attempt's last rollback ({@link #otherRollback}). With no active journal entry it wrote
	 * nothing (K2): the record goes. Not when the queue file or the journal could not be read (the record stays as it is). Server thread.
	 */
	private static void rollBackStrayInfras(MinecraftServer srv) {
		if (loadFailed || dev.larattalabs.architect.journal.WorldJournal.unavailable() != null) {
			return;
		}
		for (String id : strayPlacing(Infras.all(), jobCovered())) {
			Infra i = Infras.get(id);
			if (i == null) {
				continue;
			}
			if (SiteJournal.active(id).isEmpty()) {
				Architect.LOGGER.warn("Cell site {} was still being placed with no job in {} and no journal entry; nothing was written, its record is dropped", id, FILE);
				Infras.drop(srv, id);
				continue;
			}
			Site.Member m = i.member();
			Architect.LOGGER.warn("Cell site {} ({}) was still being placed and no job in {} covers it; rolling it back from the world journal", id,
				m == null ? "no item" : m.itemKey(), FILE);
			RestoreJob rb = new RestoreJob(id, RestoreJob.ROLLBACK, m == null ? null : m.batchId(), m == null ? null : m.itemKey());
			rb.requeue = true;
			rb.why = "the game stopped without saving while it was being placed";
			JOBS.add(rb);
			// its item (queued again from the last save) waits PLACING as this site's until the rollback ends: a retry checking the tile meanwhile
			// would read cells the restore then writes back
			Batches.holdForRollback(rb.batchId, rb.itemKey, id);
		}
	}

	/**
	 * (slice PLR) Another rollback of the same batch item still in the queue (a region tile's main and its extra targets), or null: the item
	 * stays held until the last of its attempt's rollbacks ends.
	 */
	static @Nullable String otherRollback(RestoreJob done) {
		if (done.batchId == null || done.itemKey == null) {
			return null;
		}
		for (Job j : JOBS) {
			if (j != done && j instanceof RestoreJob r && RestoreJob.ROLLBACK.equals(r.purpose) && done.batchId.equals(r.batchId) && done.itemKey.equals(r.itemKey)) {
				return r.siteId;
			}
		}
		return null;
	}

	// ------------------------------------------------------------------ (slice PLR2) a crash rollback's end, its extra targets

	/** (slice PLR2) How a rollback's end settles its batch item ({@link Batches#rolledBack}). */
	enum RollbackEnd {
		/** Left as it is (done, or another site's). */
		LEAVE,
		/** Held for another rollback of the same attempt still in the queue. */
		WAIT,
		/** Queued again (a crash rollback that restored its box). */
		REQUEUE,
		/** Failed. */
		FAIL
	}

	/**
	 * (slice PLR2) A rollback of {@code jobSite} ended ({@code broken}: why it stopped before its box was restored, or null): what becomes of
	 * its item ({@code status}, held as {@code itemSite}; {@code itemSiteLive}: a placement job of that site runs). {@code otherRollback}:
	 * another rollback of the same attempt is still queued; {@code batchOpen}: the batch runs and is not being cancelled. Pure.
	 */
	static RollbackEnd rollbackEnd(dev.larattalabs.architect.batch.QItem.Status status, @Nullable String itemSite, String jobSite, boolean itemSiteLive,
		@Nullable String broken, boolean otherRollback, boolean requeue, boolean batchOpen) {
		if (!rollbackOwnsItem(status, itemSite, jobSite)) {
			return RollbackEnd.LEAVE;
		}
		if (otherRollback && status == dev.larattalabs.architect.batch.QItem.Status.PLACING) {
			return RollbackEnd.WAIT;
		}
		if (requeue && batchOpen) {
			return RollbackEnd.REQUEUE;
		}
		return status == dev.larattalabs.architect.batch.QItem.Status.PLACING ? RollbackEnd.FAIL : RollbackEnd.LEAVE;
	}

	/**
	 * (slice PLR2) Whether a crash rollback's extra target (its main entry's status, null with none; {@code recordOnDisk}: its record is in the
	 * sites file) is rolled back by its own tracked job rather than released with its record dropped. Pure.
	 */
	static boolean extraRollsBack(dev.larattalabs.architect.journal.Journal.@Nullable Status entry, boolean recordOnDisk) {
		return false;
	}

	/** (slice PLR2) Whether a placement job (a site's or a road's or cell site's) of {@code siteId} runs. */
	static boolean placing(@Nullable String siteId) {
		Job j = siteId == null ? null : job(siteId);
		return j instanceof PlaceJob || j instanceof InfraJob;
	}

	/**
	 * (slice PLR2) TEST, dev only: {@code architect-dev-arm.json} in the world's folder, read once (and deleted) as the world starts, before
	 * the queue file is resumed, arms a fault for the start's own recovery (a kill point is in-JVM, and a crash test's restart is a new JVM):
	 * {@code killAt} ({@link WorldJournal#killAt}), {@code failRollback} ({@link RestoreJob#failRollback}). Read only on a dev or headless
	 * gate host (ARCHITECT_HEADLESS or ARCHITECT_DEV_TOKEN set).
	 */
	private static void devArm(MinecraftServer srv) {
		if (System.getenv("ARCHITECT_HEADLESS") == null && System.getenv("ARCHITECT_DEV_TOKEN") == null) {
			return;
		}
		Path f = srv.getWorldPath(LevelResource.ROOT).resolve("architect-dev-arm.json");
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			Files.delete(f);
			if (o.has("killAt")) {
				WorldJournal.killAt(o.get("killAt").getAsString());
			}
			if (o.has("failRollback")) {
				RestoreJob.failRollback = o.get("failRollback").getAsInt();
			}
			Architect.LOGGER.warn("TEST: armed from {}: {}", f.getFileName(), o);
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("TEST: could not read {}", f, e);
		}
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
