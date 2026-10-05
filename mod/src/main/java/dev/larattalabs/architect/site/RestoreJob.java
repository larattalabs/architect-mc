package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.UpdateMask;
import dev.larattalabs.architect.journal.WorldJournal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.templatesystem.StructureTemplate;
import org.jspecify.annotations.Nullable;

/**
 * A site's undo written over ticks (docs/CONTRACT.md phase 4d; phase 4e R1-R4): the same writes as the atomic restore (the
 * undo's {@code written} values as a structure template placed with {@link TemplateWriter}, under the hole mask when a site
 * that stays covers some of its cells), then its other cells, then the rest of a removal. Two purposes:
 * <ul>
 * <li>{@code rollback}: a site still placing is cancelled ({@code cancelBatch}, a broken job); this job plans and commits the
 * undo of its PLACING entries itself; it was never placed, so no SITE_REMOVED fires;</li>
 * <li>{@code remove}: a site of a group or stage being undone: the group's undo is already committed ({@link Groups}); this
 * job writes it; SITE_REMOVED fires.</li>
 * </ul>
 * Persisted by purpose, site and undo group: after a load it starts its writes over (writing the same values again is
 * idempotent; K7).
 */
final class RestoreJob implements Placement.Job {
	static final String ROLLBACK = "rollback";
	static final String REMOVE = "remove";
	static final int PLAN = 0;
	static final int COMMIT = 1;
	static final int WRITE = 2;
	static final int DONE = 3;

	final String siteId;
	final String purpose;
	final @Nullable String batchId;
	final @Nullable String itemKey;
	final List<TickDeferral.Held> held = new ArrayList<>();
	/** The undo group (null until a rollback planned it). */
	@Nullable String group;
	int phase = PLAN;
	transient @Nullable CompletableFuture<Void> commit;
	transient WorldJournal.@Nullable UndoWork work;
	transient WorldJournal.@Nullable UndoPlanner planner;
	transient boolean planned;
	transient @Nullable CompletableFuture<Object[]> txn;
	/** A restore's writer, prepared off the server thread for a large site (the template of 600k cells). */
	transient @Nullable CompletableFuture<Object[]> prepared;
	/** Undos over more sections than this commit in the tick after planning; restores of more cells prepare off-thread. */
	static final int SPLIT_SECTIONS = 24;
	static final int OFF_THREAD_CELLS = 100_000;
	@Nullable TemplateWriter writer;
	transient SiteJournal.@Nullable Restore restore;
	@Nullable List<String> dropsBefore;
	@Nullable String broken;
	boolean done;
	/** Why a rollback happens (the item's ITEM_FAILED message). */
	String why = "";
	/** A rollback after a crash: the item is queued again once its box is restored. */
	boolean requeue;
	/** What the finished removal gave back (a remove's refunds are empty: instant sites only). */
	Sites.@Nullable Removed result;
	/** A removal's hand-downs per site (for its RemoveResult). */
	Map<String, Integer> handed = Map.of();

	RestoreJob(String siteId, String purpose, @Nullable String batchId, @Nullable String itemKey) {
		this.siteId = siteId;
		this.purpose = purpose;
		this.batchId = batchId;
		this.itemKey = itemKey;
	}

	/** A removal's write job: its undo group is committed. */
	static RestoreJob writing(String siteId, String group, Map<String, Integer> handed) {
		RestoreJob j = new RestoreJob(siteId, REMOVE, null, null);
		j.group = group;
		j.phase = WRITE;
		j.handed = handed;
		return j;
	}

	@Override
	public String siteId() {
		return siteId;
	}

	@Override
	public @Nullable String batchId() {
		return batchId;
	}

	@Override
	public String kind() {
		return purpose;
	}

	/** The record: standing (a rollback before its undo) or pending (after R3). */
	private @Nullable Site record() {
		Site s = Sites.get(siteId);
		return s != null ? s : Sites.pendingRecord(siteId);
	}

	/** A road's or cell site's record (standing or pending). */
	private @Nullable Infra infra() {
		Infra i = Infras.get(siteId);
		return i != null ? i : Infras.pending(siteId);
	}

	/** The cell writes done so far (roads and cell sites are written over ticks too). */
	int cellCursor;
	/** Who waits for a removal of a road or cell site (the API). */
	transient final List<CompletableFuture<Sites.Removed>> futures = new ArrayList<>();
	/** The infra record as it was taken down. */
	transient @Nullable Infra infraDone;

	@Override
	public boolean step(MinecraftServer server, long deadline) {
		long t0 = System.nanoTime();
		int p0 = phase;
		boolean r = step0(server, deadline);
		if (Sites.Trace.ON) {
			dev.larattalabs.architect.Architect.LOGGER.info("TRACE tick {} restore {} phase {} -> {} {} ms{}", server.getTickCount(), siteId, p0, phase,
				(System.nanoTime() - t0) / 1e6, r ? " done" : "");
		}
		return r;
	}

	private boolean step0(MinecraftServer server, long deadline) {
		// phases follow each other inside the budget (a commit is waited for there): no tick lost per phase
		while (true) {
			int was = phase;
			if (stepPhase(server, deadline)) {
				return true;
			}
			if (phase == was || System.nanoTime() >= deadline) {
				return false;
			}
		}
	}

	private boolean stepPhase(MinecraftServer server, long deadline) {
		Infra inf = Sites.get(siteId) == null && Sites.pendingRecord(siteId) == null ? infra() : null;
		if (inf != null) {
			return stepInfra(server, inf, deadline);
		}
		Site s = record();
		ServerLevel level = s == null ? null : Sites.levelOf(server, s);
		if (s == null || level == null) {
			broken = s == null ? "no site " + siteId : s.dimension() + " is not loaded";
			return true;
		}
		try {
			if (phase == PLAN) {
				// R1 sliced per section over ticks (a size-cap site plans 600k cells), then the one commit (R2)
				if (planner == null) {
					Sites.Trace tr = new Sites.Trace("restore plan start " + siteId);
					group = SiteJournal.group(purpose + "-" + siteId);
					planner = SiteJournal.undoPlanner(level, List.of(siteId), group);
					tr.mark("planner");
					planner.ready();
					tr.mark("warm");
					tr.done();
				}
				SiteJournal.Undone u = planned(deadline);
				if (u == null) {
					return broken != null;
				}
				planned = false;
				planner = null;
				work = u.work();
				commit = u.commit();
				if (REMOVE.equals(purpose)) {
					handed = Sites.handedBySite(u.work());
				}
				dropsBefore = Sites.Drops.before(level, s.restoreBox()).uuids();
				if (Sites.Trace.ON) {
					dev.larattalabs.architect.Architect.LOGGER.info("TRACE restore {} submitted", siteId);
				}
				phase = COMMIT;
				return false;
			}
			if (phase == COMMIT) {
				CompletableFuture<Void> f = commit;
				if (f != null && !PlaceJob.waitFor(f, deadline)) {
					return false;
				}
				if (f != null && f.isCompletedExceptionally()) {
					broken = "its undo could not be saved to the world journal";
					return true;
				}
				commit = null;
				WorldJournal.kill("K6");
				if (Sites.get(siteId) != null) {
					Sites.markPending(server, Sites.get(siteId), "removed"); // R3
				}
				phase = WRITE;
				return false;
			}
		} catch (Sites.SiteException e) {
			broken = e.getMessage();
			return true;
		}
		if (writer == null) {
			if (dropsBefore == null) {
				dropsBefore = Sites.Drops.before(level, s.restoreBox()).uuids();
			}
			String g = group;
			if (prepared == null) {
				java.util.function.Supplier<Object[]> prep = () -> {
					try {
						SiteJournal.Restore rs = SiteJournal.restore(level, siteId, g);
						TemplateWriter.Cells cs = null;
						if (rs.template() != null && rs.box() != null) {
							StructureTemplate t = new StructureTemplate();
							t.load(level.registryAccess().lookupOrThrow(Registries.BLOCK), rs.template());
							cs = TemplateWriter.cells(level, t, Sites.placeSettings(Rotation.NONE));
						}
						return new Object[] {rs, cs};
					} catch (Sites.SiteException e) {
						throw new java.util.concurrent.CompletionException(e);
					}
				};
				prepared = s.restoreBox().volume() > OFF_THREAD_CELLS ? CompletableFuture.supplyAsync(prep) : CompletableFuture.completedFuture(prep.get());
			}
			if (!prepared.isDone()) {
				return false;
			}
			Object[] ready;
			try {
				ready = prepared.join();
			} catch (java.util.concurrent.CompletionException e) {
				broken = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
				return true;
			} finally {
				prepared = null;
			}
			restore = (SiteJournal.Restore) ready[0];
			if (ready[1] != null) {
				BlockPos min = new BlockPos(restore.box().minX(), restore.box().minY(), restore.box().minZ());
				writer = new TemplateWriter((TemplateWriter.Cells) ready[1], min, Sites.FLAGS);
			} else {
				writer = new TemplateWriter(new TemplateWriter.Cells(new int[0], new net.minecraft.world.level.block.state.BlockState[0],
					new net.minecraft.nbt.CompoundTag[0]), BlockPos.ZERO, Sites.FLAGS);
			}
			if (System.nanoTime() >= deadline) {
				return false;
			}
		}
		TickDeferral.begin(level, held);
		if (restore != null && restore.mask() != null) {
			UpdateMask.begin(restore.mask());
		}
		try {
			writer.step(level, deadline);
			if (writer.progress() > 0) {
				WorldJournal.kill("K7");
			}
		} finally {
			UpdateMask.end();
			TickDeferral.end();
		}
		if (!writer.done()) {
			return false;
		}
		// as Sites.restoreQuietly: the leaf ticks the restore scheduled are dropped
		TickDeferral.release(level, TickDeferral.withoutLeaves(held));
		held.clear();
		SiteJournal.writeCells(level, restore.cells());
		Sites.Drops drops = Sites.Drops.of(level, s.restoreBox(), dropsBefore);
		Journal.Stats st = work != null ? Sites.statsOf(work, siteId) : new Journal.Stats(restore.cells().size(), 0, restore.holes());
		result = ROLLBACK.equals(purpose) ? Sites.finishRollback(server, level, s, drops, restore.ring(), st)
			: Sites.finishTickedRemove(server, level, s, drops, restore.ring(), st, handed);
		phase = DONE;
		done = true;
		futures.forEach(f -> f.complete(result));
		return true;
	}

	/**
	 * R1 sliced, then R2: null while planning (or while a large undo's commit is built off the server thread, or when it broke:
	 * {@link #broken}); the submitted undo once done.
	 */
	private SiteJournal.@Nullable Undone planned(long deadline) throws Sites.SiteException {
		try {
			if (!planned && !planner.step(deadline)) {
				return null;
			}
		} catch (java.io.IOException e) {
			throw new Sites.SiteException(Reason.JOURNAL_UNAVAILABLE, "the journal can't be read (" + e.getMessage() + ")");
		}
		SiteJournal.Undone u;
		if (planner.sections() > SPLIT_SECTIONS) {
			// a large undo: its commit is built off the server thread, then submitted
			if (txn == null) {
				WorldJournal.UndoWork w = planner.work();
				planned = true;
				txn = CompletableFuture.supplyAsync(() -> {
					try {
						return new Object[] {w, SiteJournal.undoTxn(w)};
					} catch (Sites.SiteException e) {
						throw new java.util.concurrent.CompletionException(e);
					}
				});
				return null;
			}
			if (!txn.isDone()) {
				return null;
			}
			Object[] built;
			try {
				built = txn.join();
			} catch (java.util.concurrent.CompletionException e) {
				broken = e.getCause() != null ? e.getCause().getMessage() : e.getMessage();
				return null;
			} finally {
				txn = null;
			}
			WorldJournal.kill("K5");
			u = SiteJournal.submitUndo((WorldJournal.UndoWork) built[0], (dev.larattalabs.architect.journal.JournalStore.Txn) built[1]);
		} else {
			WorldJournal.kill("K5");
			u = SiteJournal.submitUndo(planner.work());
		}
		return u;
	}

	/** A road's or cell site's undo: plan and commit (when this job planned it), the record pending, the cells lowest first over ticks. */
	private boolean stepInfra(MinecraftServer server, Infra inf, long deadline) {
		ServerLevel level = Sites.levelOf(server, inf.dimension());
		if (level == null) {
			broken = inf.dimension() + " is not loaded";
			return true;
		}
		try {
			if (phase == PLAN) {
				if (planner == null) {
					group = SiteJournal.group(purpose + "-" + siteId);
					planner = SiteJournal.undoPlanner(level, List.of(siteId), group);
				}
				SiteJournal.Undone u = planned(deadline);
				if (u == null) {
					return broken != null;
				}
				planned = false;
				planner = null;
				work = u.work();
				commit = u.commit();
				handed = Sites.handedBySite(u.work());
				phase = COMMIT;
				return false;
			}
			if (phase == COMMIT) {
				CompletableFuture<Void> f = commit;
				if (f != null && !PlaceJob.waitFor(f, deadline)) {
					return false;
				}
				if (f != null && f.isCompletedExceptionally()) {
					broken = "its undo could not be saved to the world journal";
					return true;
				}
				commit = null;
				WorldJournal.kill("K6");
				Infras.markPending(server, siteId);
				phase = WRITE;
				return false;
			}
			if (restore == null) {
				restore = SiteJournal.restore(level, siteId, group);
				cellCursor = 0;
			}
		} catch (Sites.SiteException e) {
			broken = e.getMessage();
			return true;
		}
		List<SiteJournal.CellWrite> cells = restore.cells();
		int from = cellCursor;
		while (cellCursor < cells.size()) {
			int to = Math.min(cells.size(), cellCursor + 64);
			SiteJournal.writeCells(level, cells.subList(cellCursor, to));
			cellCursor = to;
			if (cellCursor > from) {
				WorldJournal.kill("K7");
			}
			if (System.nanoTime() >= deadline && cellCursor < cells.size()) {
				return false;
			}
		}
		Journal.Stats st = work != null ? Sites.statsOf(work, siteId) : new Journal.Stats(cells.size(), 0, restore.holes());
		infraDone = inf;
		result = new Sites.Removed(null, Map.of(), st.restored(), st.changed(), handed, List.of(), List.of());
		if (!ROLLBACK.equals(purpose)) {
			dev.larattalabs.architect.apiimpl.ApiEvents.removedInfra(server, inf, st.restored());
		}
		dev.larattalabs.architect.Architect.LOGGER.info("Removed {}: {} cells restored, {} kept (changed since), {} handed down", inf.describe(), st.restored(),
			st.changed(), handed);
		if (inf.road()) {
			dev.larattalabs.architect.site.roads.RoadSync.changed(server, inf.dimension(), inf.box());
		}
		phase = DONE;
		done = true;
		futures.forEach(f -> f.complete(result));
		return true;
	}

	@Override
	public int progress() {
		return writer == null ? cellCursor : writer.progress();
	}

	@Override
	public int total() {
		if (restore != null && writer == null) {
			return Math.max(1, restore.cells().size());
		}
		return writer == null ? 1 : writer.done() ? writer.total() : writer.cells.size() * 2;
	}

	@Override
	public void aborted(MinecraftServer server) {
		held.clear();
	}

	@Override
	public JsonObject toJson() {
		JsonObject o = new JsonObject();
		o.addProperty("kind", purpose);
		o.addProperty("siteId", siteId);
		if (batchId != null) {
			o.addProperty("batchId", batchId);
		}
		if (itemKey != null) {
			o.addProperty("itemKey", itemKey);
		}
		if (group != null) {
			o.addProperty("group", group);
		}
		o.addProperty("phase", phase == DONE ? WRITE : phase);
		if (!why.isEmpty()) {
			o.addProperty("why", why);
		}
		if (requeue) {
			o.addProperty("requeue", true);
		}
		if (dropsBefore != null) {
			JsonArray d = new JsonArray();
			dropsBefore.forEach(d::add);
			o.add("dropsBefore", d);
		}
		if (!handed.isEmpty()) {
			JsonObject h = new JsonObject();
			handed.forEach(h::addProperty);
			o.add("handed", h);
		}
		return o;
	}

	static RestoreJob fromJson(JsonObject o) {
		RestoreJob j = new RestoreJob(o.get("siteId").getAsString(), o.get("kind").getAsString(), o.has("batchId") ? o.get("batchId").getAsString() : null,
			o.has("itemKey") ? o.get("itemKey").getAsString() : null);
		j.why = o.has("why") ? o.get("why").getAsString() : "";
		j.requeue = o.has("requeue") && o.get("requeue").getAsBoolean();
		j.group = o.has("group") ? o.get("group").getAsString() : null;
		j.phase = o.has("phase") ? o.get("phase").getAsInt() : j.group == null ? PLAN : WRITE;
		if (j.group == null) {
			j.phase = PLAN;
		} else if (j.phase == COMMIT || j.phase == PLAN) {
			// the undo was submitted: committed (written again from the start) or not (planned again)
			String g = j.group;
			boolean undone = SiteJournal.entries(j.siteId).stream().anyMatch(m -> m.status() == Journal.Status.UNDONE && g.equals(m.undoGroup()));
			j.phase = undone ? WRITE : PLAN;
			if (undone && Sites.get(j.siteId) != null) {
				j.phase = COMMIT; // R3 not done yet: the record goes pending first
			}
		}
		if (o.has("dropsBefore")) {
			List<String> d = new ArrayList<>();
			o.getAsJsonArray("dropsBefore").forEach(e -> d.add(e.getAsString()));
			j.dropsBefore = d;
		}
		if (o.has("handed")) {
			Map<String, Integer> h = new java.util.TreeMap<>();
			o.getAsJsonObject("handed").entrySet().forEach(e -> h.put(e.getKey(), e.getValue().getAsInt()));
			j.handed = h;
		}
		return j;
	}

	@Override
	public String toString() {
		return "RestoreJob[" + purpose + " " + siteId + (group == null ? "" : " " + group) + "]";
	}

	/** Unused helper kept for the store import (entries of a group). */
	static List<String> entryIds(String siteId, String group) {
		return SiteJournal.undone(siteId, group).stream().map(JournalStore.Meta::id).toList();
	}
}
