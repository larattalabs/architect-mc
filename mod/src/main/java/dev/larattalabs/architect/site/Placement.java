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

	private static final List<Job> JOBS = new ArrayList<>();
	private static long deadline;
	private static int rotate;
	private static @Nullable MinecraftServer server;
	private static final Stats STATS = new Stats();

	private Placement() {
	}

	static void init() {
		Batches.init(); // registers the chunk ticket type now, while the registries are open
		ServerLifecycleEvents.SERVER_STARTED.register(Placement::load);
		ServerTickEvents.START_SERVER_TICK.register(s -> STATS.startTick(s, active()));
		ServerTickEvents.END_SERVER_TICK.register(Placement::tick);
		// the tick's full time is measured from its start to after every other end-of-tick handler (Fabric runs END_SERVER_TICK
		// after the server tallied its own tick time, so the server's MSPT leaves those handlers out)
		Identifier last = Identifier.fromNamespaceAndPath(Architect.MOD_ID, "tick_stats");
		ServerTickEvents.END_SERVER_TICK.addPhaseOrdering(Event.DEFAULT_PHASE, last);
		ServerTickEvents.END_SERVER_TICK.register(last, s -> STATS.endTick(s));
		ServerLifecycleEvents.SERVER_STOPPING.register(s -> save(s, true));
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			JOBS.clear();
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

	private static void tick(MinecraftServer srv) {
		server = srv;
		long start = System.nanoTime();
		deadline = start + budgetNanos();
		int before = workDone();
		try {
			Batches.tick(srv, deadline);
			Groups.tick(srv, deadline);
			runJobs(srv);
			syncGhosts(srv);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Placement tick failed", e);
		}
		if (!JOBS.isEmpty() || STATS.tickActive) {
			STATS.work(System.nanoTime() - start, Math.max(0, workDone() - before) + finishedWork);
		}
		finishedWork = 0;
	}

	private static int finishedWork;

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
			try {
				complete = j.step(srv, deadline);
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
				JOBS.remove(j);
				finishedWork += Math.max(0, j.total() - was);
				completed(srv, j);
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

	/** Writes the queue file: batches, jobs with their cursors, group removals. {@code clean}: the server is stopping. */
	static void save(MinecraftServer srv, boolean clean) {
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
		Path f = file(srv);
		JsonObject root = null;
		if (Files.exists(f)) {
			try {
				root = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Could not read {}; the queue starts empty (the file is left as is)", f, e);
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
			if (!ij.beforeRecord && !clean) {
				boolean active = SiteJournal.main(ij.siteId) != null && SiteJournal.main(ij.siteId).status() == dev.larattalabs.architect.journal.Journal.Status.ACTIVE;
				if (!active) {
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
	static final class Stats {
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
