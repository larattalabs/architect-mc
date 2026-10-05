package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.StageRules;
import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * Site groups at run time (docs/CONTRACT.md phase 4d "Site groups and undo", "Stages"): approving, skipping and reordering
 * stages, and taking a group's (or one stage's) sites down in reverse placement order under the per-tick budget. Instant
 * sites are restored over ticks ({@link RestoreJob}); construction sites deconstruct with refunds, one per tick. A player in
 * a box is waited for (up to 10 min); the player's things in a box stop the removal with the blockers. Server thread.
 */
public final class Groups {
	/** How long a removal waits for a player to step out of a box, in ticks. */
	static final long MAX_WAIT = 12_000;

	/** A removal in progress: the sites still to take down, last placed first. */
	static final class Removal {
		final String group;
		final @Nullable String stage;
		final List<String> sites = new ArrayList<>();
		final @Nullable String requester;
		final boolean force;
		Sites.Covered covered = Sites.Covered.KEEP;
		final List<String> cascaded = new ArrayList<>();
		Map<String, Integer> handedAll = new TreeMap<>();
		boolean started;
		@Nullable String current;
		long waited;
		long nextCheck;
		final Map<String, Integer> refund = new TreeMap<>();
		final List<CompletableFuture<Removed>> futures = new ArrayList<>();
		/** Phase 4e: the undo group once planned (one undo over the sites), the sites it covers, and what it handed down. */
		@Nullable String undo;
		final List<String> undoSites = new ArrayList<>();
		Map<String, Integer> handed = new TreeMap<>();
		/** The cells the undo restores (its plan's stats). */
		int restoredCells;
		/** R1 in progress (not saved: a load plans again). */
		transient dev.larattalabs.architect.journal.WorldJournal.@Nullable UndoPlanner planner;
		transient List<String> planIds = List.of();
		transient @Nullable String planGroup;
		transient @Nullable CompletableFuture<Void> commit;
		/** Construction members' deconstruct items (computed before the undo is planned, rule 7) and where they drop. */
		final Map<String, Map<String, Integer>> decItems = new LinkedHashMap<>();
		final Map<String, long[]> decAt = new LinkedHashMap<>();

		Removal(String group, @Nullable String stage, @Nullable String requester, boolean force) {
			this.group = group;
			this.stage = stage;
			this.requester = requester;
			this.force = force;
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("group", group);
			if (stage != null) {
				o.addProperty("stage", stage);
			}
			JsonArray s = new JsonArray();
			sites.forEach(s::add);
			o.add("sites", s);
			if (requester != null) {
				o.addProperty("requester", requester);
			}
			o.addProperty("force", force);
			o.addProperty("covered", covered.name());
			o.addProperty("started", started);
			if (current != null) {
				o.addProperty("current", current);
			}
			o.addProperty("waited", waited);
			JsonObject r = new JsonObject();
			refund.forEach(r::addProperty);
			o.add("refund", r);
			if (undo != null) {
				o.addProperty("undo", undo);
				JsonArray us = new JsonArray();
				undoSites.forEach(us::add);
				o.add("undoSites", us);
				JsonObject h = new JsonObject();
				handed.forEach(h::addProperty);
				o.add("handed", h);
				o.addProperty("restoredCells", restoredCells);
			}
			if (!decItems.isEmpty()) {
				JsonObject d = new JsonObject();
				decItems.forEach((site, items) -> {
					JsonObject x = new JsonObject();
					JsonObject it = new JsonObject();
					items.forEach(it::addProperty);
					x.add("items", it);
					x.addProperty("at", decAt.get(site)[0]);
					d.add(site, x);
				});
				o.add("dec", d);
			}
			return o;
		}

		static Removal fromJson(JsonObject o) {
			Removal r = new Removal(o.get("group").getAsString(), o.has("stage") ? o.get("stage").getAsString() : null,
				o.has("requester") ? o.get("requester").getAsString() : null, o.get("force").getAsBoolean());
			o.getAsJsonArray("sites").forEach(e -> r.sites.add(e.getAsString()));
			r.started = o.get("started").getAsBoolean();
			r.covered = o.has("covered") ? Sites.Covered.valueOf(o.get("covered").getAsString()) : Sites.Covered.KEEP;
			r.current = o.has("current") ? o.get("current").getAsString() : null;
			r.waited = o.get("waited").getAsLong();
			o.getAsJsonObject("refund").entrySet().forEach(e -> r.refund.put(e.getKey(), e.getValue().getAsInt()));
			if (o.has("undo")) {
				r.undo = o.get("undo").getAsString();
				o.getAsJsonArray("undoSites").forEach(e -> r.undoSites.add(e.getAsString()));
				o.getAsJsonObject("handed").entrySet().forEach(e -> r.handed.put(e.getKey(), e.getValue().getAsInt()));
				r.restoredCells = o.has("restoredCells") ? o.get("restoredCells").getAsInt() : 0;
			}
			if (o.has("dec")) {
				o.getAsJsonObject("dec").entrySet().forEach(e -> {
					JsonObject x = e.getValue().getAsJsonObject();
					Map<String, Integer> items = new TreeMap<>();
					x.getAsJsonObject("items").entrySet().forEach(i -> items.put(i.getKey(), i.getValue().getAsInt()));
					r.decItems.put(e.getKey(), items);
					r.decAt.put(e.getKey(), new long[] {x.get("at").getAsLong()});
				});
			}
			return r;
		}
	}

	/** What a removal ended with: removed, or stopped at a site with its blockers; every refund so far. */
	public record Removed(boolean removed, List<String> blockers, Map<String, Integer> refund, int restored, Map<String, Integer> handedDown,
		List<String> cascaded) {
		public Removed(boolean removed, List<String> blockers, Map<String, Integer> refund) {
			this(removed, blockers, refund, 0, Map.of(), List.of());
		}
	}

	private static final List<Removal> REMOVALS = new ArrayList<>();
	private static long tick;

	private Groups() {
	}

	static boolean anyRemoving() {
		return !REMOVALS.isEmpty();
	}

	// ------------------------------------------------------------------ stages

	private static SiteGroupRec require(String groupId) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			throw new IllegalArgumentException("no site group " + groupId);
		}
		return g;
	}

	private static SiteGroupRec.StageRec requireStage(SiteGroupRec g, String stage) {
		SiteGroupRec.StageRec st = g.stage(stage);
		if (st == null) {
			throw new IllegalArgumentException("group " + g.id() + " has no stage " + stage + " (it has " + g.stageNames() + ")");
		}
		return st;
	}

	/** Approves a planned stage. Server thread. */
	public static SiteGroupRec.StageRec approve(MinecraftServer server, String groupId, String stage) {
		SiteGroupRec g = require(groupId);
		SiteGroupRec.StageRec st = requireStage(g, stage);
		Batches.setStage(server, g, stage, StageRules.approve(st.state()));
		return Sites.group(groupId).stage(stage);
	}

	/** Skips a stage that has not started placing: its items fail CANCELLED. Server thread. */
	public static SiteGroupRec.StageRec skip(MinecraftServer server, String groupId, String stage) {
		SiteGroupRec g = require(groupId);
		SiteGroupRec.StageRec st = requireStage(g, stage);
		Batches.setStage(server, g, stage, StageRules.skip(st.state()));
		Batches.skipped(server, st.batchId(), stage);
		return Sites.group(groupId).stage(stage);
	}

	/** Reorders the planned stages (see {@link StageRules#reorder}). Server thread. */
	public static SiteGroupRec reorder(MinecraftServer server, String groupId, List<String> planned) {
		SiteGroupRec g = require(groupId);
		List<String> order = StageRules.reorder(g.stageNames(), g.stageStates(), planned);
		Map<String, SiteGroupRec.StageRec> by = new LinkedHashMap<>();
		g.stages().forEach(s -> by.put(s.name(), s));
		SiteGroupRec n = g.withStages(order.stream().map(by::get).toList());
		Sites.putGroup(server, n);
		Architect.LOGGER.info("Group {}: stages reordered to {}", groupId, order);
		return n;
	}

	// ------------------------------------------------------------------ removal

	/**
	 * Takes a whole group down (its running batches cancelled first), last placed first. The owner rule: another owner's
	 * group needs {@code force}. Server thread.
	 */
	public static CompletableFuture<Removed> removeGroup(MinecraftServer server, String groupId, @Nullable String requester, boolean force) {
		return removeGroup(server, groupId, requester, force, Sites.Covered.KEEP);
	}

	/** {@link #removeGroup} with a covered policy for cells of its sites that sites outside the group cover (phase 4e). */
	public static CompletableFuture<Removed> removeGroup(MinecraftServer server, String groupId, @Nullable String requester, boolean force,
		Sites.Covered covered) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no site group " + groupId));
		}
		String owner = ApiRules.removeRefusal(groupId, g.owner(), requester, force);
		if (owner != null) {
			return CompletableFuture.completedFuture(new Removed(false, List.of(owner), Map.of()));
		}
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId) && r.stage == null) {
				CompletableFuture<Removed> f = new CompletableFuture<>();
				r.futures.add(f);
				return f;
			}
		}
		for (QBatch b : Batches.all()) {
			if (b.group.equals(groupId) && b.running()) {
				Batches.cancel(server, b.id);
			}
		}
		Sites.putGroup(server, g.withState(SiteGroupRec.REMOVING));
		Removal r = new Removal(groupId, null, requester, force);
		r.covered = covered;
		CompletableFuture<Removed> f = new CompletableFuture<>();
		r.futures.add(f);
		REMOVALS.add(r);
		Placement.save(server, false);
		Architect.LOGGER.info("Removing group {} ({} site(s))", groupId, g.sites().size());
		return f;
	}

	/** Undoes a placed (or partial) stage: its sites, last placed first; then the stage is UNDONE. Server thread. */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force) {
		return undoStage(server, groupId, stage, force, Sites.Covered.KEEP);
	}

	/** {@link #undoStage} with a covered policy (phase 4e). */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force, Sites.Covered covered) {
		SiteGroupRec g = Sites.group(groupId);
		if (g == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no site group " + groupId));
		}
		int i = g.stageIndex(stage);
		if (i < 0) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("group " + groupId + " has no stage " + stage));
		}
		String no = StageRules.undoRefusal(g.stageNames(), g.stageStates(), i, force);
		if (no != null) {
			return CompletableFuture.failedFuture(new IllegalStateException(no));
		}
		for (Removal r : REMOVALS) {
			if (r.group.equals(groupId)) {
				return CompletableFuture.failedFuture(new IllegalStateException("group " + groupId + " is already being taken down"));
			}
		}
		Removal r = new Removal(groupId, stage, null, true);
		r.covered = covered;
		r.started = true;
		List<String> sites = new ArrayList<>(g.stages().get(i).sites());
		java.util.Collections.reverse(sites);
		r.sites.addAll(sites);
		CompletableFuture<Removed> f = new CompletableFuture<>();
		r.futures.add(f);
		REMOVALS.add(r);
		Placement.save(server, false);
		Architect.LOGGER.info("Undoing stage {} of group {} ({} site(s)){}", stage, groupId, sites.size(), force ? " (forced)" : "");
		return f;
	}

	static void tick(MinecraftServer server, long deadline) {
		tick++;
		for (Removal r : List.copyOf(REMOVALS)) {
			if (System.nanoTime() >= deadline && r != REMOVALS.get(0)) {
				break;
			}
			try {
				tick(server, r);
			} catch (RuntimeException e) {
				Architect.LOGGER.error("Removing group {} failed", r.group, e);
				end(server, r, new Removed(false, List.of("it failed: " + e), Map.copyOf(r.refund)));
			}
		}
	}

	/**
	 * One removal's tick (docs/CONTRACT.md phase 4e "Groups, stages and the queue"): the group's (or stage's) standing sites
	 * become <b>one undo</b>, planned per section and committed once (hand-downs between members cancel out); then the writes
	 * go site by site in reverse placement order (instant sites over ticks, {@link RestoreJob}; construction sites at once,
	 * with the refunds computed before the undo was planned). A player in a box is waited for (up to 10 min); the player's
	 * things in a box stop the removal before anything is written.
	 */
	private static void tick(MinecraftServer server, Removal r) {
		if (r.current != null) {
			if (Placement.job(r.current) != null) {
				return; // a restore job runs (Placement); removed() moves on
			}
			// its job is gone (a load that could not resume it): write it again if it is still pending
			if (r.undo != null && Sites.pendingRecord(r.current) != null && !written(r.current)) {
				Placement.add(server, RestoreJob.writing(r.current, r.undo, r.current.equals(r.undoSites.isEmpty() ? null : r.undoSites.get(r.undoSites
					.size() - 1)) ? r.handed : Map.of()));
				return;
			}
			r.sites.remove(r.current);
			written.add(r.current);
			r.current = null;
		}
		if (!r.started) {
			// the group's running batches are cancelled first (their placing items roll back)
			for (QBatch b : Batches.all()) {
				if (b.group.equals(r.group) && b.running()) {
					return;
				}
			}
			SiteGroupRec g = Sites.group(r.group);
			List<String> sites = new ArrayList<>(g == null ? List.of() : g.sites());
			java.util.Collections.reverse(sites);
			r.sites.addAll(sites);
			r.started = true;
		}
		if (r.nextCheck > tick) {
			return;
		}
		if (r.undo == null) {
			plan(server, r);
			return;
		}
		if (r.commit != null) {
			if (!r.commit.isDone()) {
				return;
			}
			if (r.commit.isCompletedExceptionally()) {
				r.undo = null;
				r.commit = null;
				end(server, r, new Removed(false, List.of("the undo could not be saved to the world journal"), Map.copyOf(r.refund)));
				return;
			}
			r.commit = null;
			dev.larattalabs.architect.journal.WorldJournal.kill("K6");
			pendAll(server, r);
		} else {
			pendAll(server, r); // after a load: the records go pending if they did not yet (R3)
		}
		// R4: the writes, last placed first
		while (!r.sites.isEmpty() && (!r.undoSites.contains(r.sites.get(0)) || Sites.pendingRecord(r.sites.get(0)) == null && Sites.get(r.sites.get(0)) == null
			&& Infras.pending(r.sites.get(0)) == null)) {
			r.sites.remove(0);
		}
		if (r.sites.isEmpty()) {
			end(server, r, new Removed(true, List.of(), Map.copyOf(r.refund), r.restoredCells, Map.copyOf(r.handedAll), List.copyOf(r.cascaded)));
			return;
		}
		String id = r.sites.get(0);
		Site s = Sites.pendingRecord(id);
		if (s == null && Infras.pending(id) != null) {
			// a road or cell site of the group: its cells over ticks
			r.current = id;
			Placement.add(server, RestoreJob.writing(id, r.undo, Map.of()));
			return;
		}
		ServerLevel level = s == null ? null : Sites.levelOf(server, s);
		if (s == null || level == null) {
			r.sites.remove(0);
			return;
		}
		Map<String, Integer> handedHere = r.handed;
		r.handed = Map.of();
		if (s.construction() != null) {
			// a construction site deconstructs at once (its refunds were tallied before the undo, rule 7), one per tick
			Map<String, Integer> items = r.decItems.getOrDefault(id, Map.of());
			long[] at = r.decAt.get(id);
			try {
				Sites.Removed done = Sites.finishGroupDeconstruct(level, s, r.undo, items, at == null ? null : BlockPos.of(at[0]), handedHere);
				done.returned().forEach((k, v) -> r.refund.merge(k, v, Integer::sum));
			} catch (Sites.SiteException e) {
				end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
				return;
			}
			r.sites.remove(0);
			written.add(id);
			Placement.save(server, false);
			return;
		}
		r.current = id;
		Placement.add(server, RestoreJob.writing(id, r.undo, handedHere));
	}

	/** Sites whose undo writes were done in this session (a reload writes again only those not done). */
	private static final java.util.Set<String> written = new java.util.HashSet<>();

	private static boolean written(String id) {
		return written.contains(id);
	}

	/** R3 of a group undo: every member's record goes pending (once). */
	private static void pendAll(MinecraftServer server, Removal r) {
		for (String id : r.undoSites) {
			Site s = Sites.get(id);
			if (s != null) {
				Sites.markPending(server, s, "removed");
			}
			if (Infras.get(id) != null) {
				Infras.markPending(server, id);
			}
		}
	}

	/** R1-R2 of a group undo: checks every member, tallies construction refunds, plans and submits one commit. */
	private static void plan(MinecraftServer server, Removal r) {
		if (r.planner != null) {
			// R1 over ticks (a large group plans per section; phase 4e budget)
			try {
				if (!r.planner.step(Placement.deadline())) {
					return;
				}
				dev.larattalabs.architect.journal.WorldJournal.kill("K5");
				SiteJournal.Undone u = SiteJournal.submitUndo(r.planner.work());
				r.planner = null;
				committed(server, r, u);
			} catch (java.io.IOException | Sites.SiteException e) {
				r.planner = null;
				end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
			}
			return;
		}
		while (!r.sites.isEmpty() && Sites.get(r.sites.get(0)) == null && Infras.get(r.sites.get(0)) == null) {
			r.sites.remove(0);
		}
		if (r.sites.isEmpty()) {
			end(server, r, new Removed(true, List.of(), Map.copyOf(r.refund)));
			return;
		}
		String dim = dimensionOf(r.sites.get(0));
		List<String> ids = new ArrayList<>();
		for (String id : r.sites) {
			if (dim.equals(dimensionOf(id))) {
				ids.add(id);
			}
		}
		ServerLevel level = Sites.levelOf(server, dim);
		if (level == null) {
			end(server, r, new Removed(false, List.of(dim + " is not loaded"), Map.copyOf(r.refund)));
			return;
		}
		for (String id : ids) {
			Site s = Sites.get(id);
			Infra inf = Infras.get(id);
			boolean placing = s != null ? s.placing() : inf != null && inf.placing();
			dev.larattalabs.architect.placement.Anchors.Bounds box = s != null ? s.restoreBox() : inf.box();
			boolean player = Occupancy.scan(level, box, e -> false).stream().anyMatch(f -> f.kind() == Occupancy.Kind.PLAYER);
			if (player || placing) {
				r.waited += Batches.RECHECK;
				r.nextCheck = tick + Batches.RECHECK;
				if (r.waited >= MAX_WAIT) {
					end(server, r, new Removed(false, List.of(player ? "a player stayed in " + id + " for 10 minutes" : id + " is still being placed"),
						Map.copyOf(r.refund)));
				}
				return;
			}
		}
		r.waited = 0;
		// sites outside the removal covering its cells (phase 4e): KEEP hands down, REFUSE refuses, CASCADE takes them first
		java.util.LinkedHashSet<String> outside = new java.util.LinkedHashSet<>();
		java.util.ArrayDeque<String> todo = new java.util.ArrayDeque<>(ids);
		while (!todo.isEmpty()) {
			for (String c : SiteJournal.coveringSites(todo.poll())) {
				if (!ids.contains(c) && outside.add(c) && r.covered == Sites.Covered.CASCADE) {
					todo.add(c);
				}
			}
		}
		if (!outside.isEmpty() && r.covered == Sites.Covered.REFUSE) {
			end(server, r, new Removed(false, List.of("COVERED: " + String.join(", ", outside) + " cover cells of the sites"), Map.copyOf(r.refund)));
			return;
		}
		if (!outside.isEmpty() && r.covered == Sites.Covered.CASCADE) {
			List<String> top = new ArrayList<>(outside);
			java.util.Collections.reverse(top);
			ids.addAll(0, top);
			r.sites.addAll(0, top);
			r.cascaded.addAll(top);
		}
		for (String id : ids) {
			Site s = Sites.get(id);
			if (s == null) {
				continue;
			}
			List<String> blockers = Sites.removalBlockers(level, s);
			if (!blockers.isEmpty()) {
				end(server, r, new Removed(false, List.of(Sites.blockersMessage(id, blockers)), Map.copyOf(r.refund)));
				return;
			}
		}
		// refunds against the stacks before the undo is planned (rule 7)
		for (String id : ids) {
			Site s = Sites.get(id);
			if (s != null && s.construction() != null) {
				Builder.Deconstruction d = Builder.prepareDeconstruct(level, s);
				r.decItems.put(id, Map.copyOf(d.all()));
				r.decAt.put(id, new long[] {d.at().asLong()});
			}
		}
		String group = dev.larattalabs.architect.site.SiteJournal.group(r.stage == null ? "group-" + r.group : "stage-" + r.group + "-" + r.stage);
		List<String> withCrate = new ArrayList<>(ids);
		if (r.stage == null) {
			withCrate.add(SiteGroupRec.CRATE_PREFIX + r.group); // the group's shared crate goes with the group
		}
		try {
			List<String> entries = new ArrayList<>();
			for (String id : withCrate) {
				SiteJournal.active(id).forEach(m -> entries.add(m.id()));
			}
			if (entries.isEmpty()) {
				end(server, r, new Removed(false, List.of("nothing of group " + r.group + " is in the world journal"), Map.copyOf(r.refund)));
				return;
			}
			r.planIds = List.copyOf(ids);
			r.planGroup = group;
			try {
				r.planner = new dev.larattalabs.architect.journal.WorldJournal.UndoPlanner(level, entries, group);
			} catch (java.io.IOException e) {
				throw new Sites.SiteException(dev.larattalabs.architect.api.Reason.JOURNAL_UNAVAILABLE, "the journal can't be read (" + e.getMessage() + ")");
			}
			plan(server, r); // as far as this tick's budget goes
		} catch (Sites.SiteException e) {
			end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
		}
	}

	/** R2 submitted: the removal waits for its commit, then marks the records pending and writes. */
	private static void committed(MinecraftServer server, Removal r, SiteJournal.Undone u) {
		r.undo = r.planGroup;
		r.undoSites.clear();
		r.undoSites.addAll(r.planIds);
		r.handed = new TreeMap<>(Sites.handedBySite(u.work()));
		r.handedAll = new TreeMap<>(r.handed);
		r.restoredCells = u.work().plan().stats().values().stream().mapToInt(Journal.Stats::restored).sum();
		r.commit = u.commit();
		Placement.save(server, false);
	}

	private static String dimensionOf(String id) {
		Site s = Sites.get(id);
		if (s != null) {
			return s.dimension();
		}
		Infra i = Infras.get(id);
		return i != null ? i.dimension() : Site.OVERWORLD;
	}

	/** Whether a removal in progress takes this site down (it can't be layered over meanwhile). */
	static boolean removing(String siteId) {
		for (Removal r : REMOVALS) {
			if (r.sites.contains(siteId) || r.undoSites.contains(siteId)) {
				return true;
			}
		}
		return false;
	}

	/** A restore job of a removal finished (Placement). */
	static void removed(MinecraftServer server, RestoreJob job) {
		for (Removal r : REMOVALS) {
			if (job.siteId.equals(r.current)) {
				r.current = null;
				r.sites.remove(job.siteId);
				written.add(job.siteId);
				if (job.broken != null) {
					end(server, r, new Removed(false, List.of(job.siteId + ": " + job.broken), Map.copyOf(r.refund)));
				}
				return;
			}
		}
	}

	private static void end(MinecraftServer server, Removal r, Removed result) {
		REMOVALS.remove(r);
		SiteGroupRec g = Sites.group(r.group);
		if (g != null) {
			if (r.stage != null) {
				if (result.removed()) {
					Batches.setStage(server, g, r.stage, Stage.State.UNDONE);
				}
			} else {
				Sites.putGroup(server, g.withState(result.removed() ? SiteGroupRec.REMOVED : SiteGroupRec.ACTIVE));
				if (result.removed()) {
					// stages that never placed are skipped; placed ones are undone
					SiteGroupRec n = Sites.group(r.group);
					for (SiteGroupRec.StageRec st : n.stages()) {
						if (st.state() == Stage.State.PLACED || st.state() == Stage.State.PARTIAL) {
							Batches.setStage(server, Sites.group(r.group), st.name(), Stage.State.UNDONE);
						} else if (!st.state().terminal()) {
							Batches.setStage(server, Sites.group(r.group), st.name(), Stage.State.SKIPPED);
						}
					}
				}
			}
		}
		Placement.save(server, false);
		Architect.LOGGER.info("{} {} of group {}: {}{}", r.stage == null ? "Removal" : "Undo of stage " + r.stage, result.removed() ? "done" : "stopped",
			r.group, result.removed() ? "all sites restored" : String.join("; ", result.blockers()), result.refund().isEmpty() ? "" : "; refund "
				+ result.refund());
		r.futures.forEach(f -> f.complete(result));
	}

	// ------------------------------------------------------------------ persistence

	static JsonArray toJson() {
		JsonArray a = new JsonArray();
		REMOVALS.forEach(r -> a.add(r.toJson()));
		return a;
	}

	static void load(JsonArray a) {
		REMOVALS.clear();
		for (JsonElement e : a) {
			try {
				REMOVALS.add(Removal.fromJson(e.getAsJsonObject()));
			} catch (RuntimeException ex) {
				Architect.LOGGER.warn("Could not read a group removal {}", e, ex);
			}
		}
	}

	static void reset(MinecraftServer server) {
		written.clear();
		REMOVALS.forEach(r -> r.futures.forEach(f -> f.completeExceptionally(new IllegalStateException("the world stopped"))));
		REMOVALS.clear();
		tick = 0;
	}
}
