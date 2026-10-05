package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.apiimpl.ApiRules;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.StageRules;
import dev.larattalabs.architect.placement.Occupancy;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
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
		boolean started;
		@Nullable String current;
		long waited;
		long nextCheck;
		final Map<String, Integer> refund = new TreeMap<>();
		final List<CompletableFuture<Removed>> futures = new ArrayList<>();

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
			o.addProperty("started", started);
			if (current != null) {
				o.addProperty("current", current);
			}
			o.addProperty("waited", waited);
			JsonObject r = new JsonObject();
			refund.forEach(r::addProperty);
			o.add("refund", r);
			return o;
		}

		static Removal fromJson(JsonObject o) {
			Removal r = new Removal(o.get("group").getAsString(), o.has("stage") ? o.get("stage").getAsString() : null,
				o.has("requester") ? o.get("requester").getAsString() : null, o.get("force").getAsBoolean());
			o.getAsJsonArray("sites").forEach(e -> r.sites.add(e.getAsString()));
			r.started = o.get("started").getAsBoolean();
			r.current = o.has("current") ? o.get("current").getAsString() : null;
			r.waited = o.get("waited").getAsLong();
			o.getAsJsonObject("refund").entrySet().forEach(e -> r.refund.put(e.getKey(), e.getValue().getAsInt()));
			return r;
		}
	}

	/** What a removal ended with: removed, or stopped at a site with its blockers; every refund so far. */
	public record Removed(boolean removed, List<String> blockers, Map<String, Integer> refund) {
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
		CompletableFuture<Removed> f = new CompletableFuture<>();
		r.futures.add(f);
		REMOVALS.add(r);
		Placement.save(server, false);
		Architect.LOGGER.info("Removing group {} ({} site(s))", groupId, g.sites().size());
		return f;
	}

	/** Undoes a placed (or partial) stage: its sites, last placed first; then the stage is UNDONE. Server thread. */
	public static CompletableFuture<Removed> undoStage(MinecraftServer server, String groupId, String stage, boolean force) {
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

	private static void tick(MinecraftServer server, Removal r) {
		if (r.current != null) {
			if (Placement.job(r.current) != null) {
				return; // a restore job runs (Placement); removed() moves on
			}
			// its job is gone (a load that could not resume it): the site is down if its record is
			if (Sites.get(r.current) != null) {
				Placement.add(server, new RestoreJob(r.current, RestoreJob.REMOVE, null, null));
				return;
			}
			r.sites.remove(r.current);
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
		while (!r.sites.isEmpty() && Sites.get(r.sites.get(0)) == null) {
			r.sites.remove(0);
		}
		if (r.sites.isEmpty()) {
			end(server, r, new Removed(true, List.of(), Map.copyOf(r.refund)));
			return;
		}
		String id = r.sites.get(0);
		Site s = Sites.get(id);
		ServerLevel level = Sites.levelOf(server, s);
		if (level == null) {
			end(server, r, new Removed(false, List.of(s.dimension() + " is not loaded"), Map.copyOf(r.refund)));
			return;
		}
		boolean player = Occupancy.scan(level, s.restoreBox(), e -> false).stream().anyMatch(f -> f.kind() == Occupancy.Kind.PLAYER);
		if (player || s.placing()) {
			r.waited += Batches.RECHECK;
			r.nextCheck = tick + Batches.RECHECK;
			if (r.waited >= MAX_WAIT) {
				end(server, r, new Removed(false, List.of(player ? "a player stayed in " + id + " for 10 minutes" : id + " is still being placed"),
					Map.copyOf(r.refund)));
			}
			return;
		}
		r.waited = 0;
		List<String> blockers = Sites.removalBlockers(level, s);
		if (!blockers.isEmpty()) {
			end(server, r, new Removed(false, List.of(Sites.blockersMessage(id, blockers)), Map.copyOf(r.refund)));
			return;
		}
		if (s.construction() != null) {
			// a construction site deconstructs with refunds (atomic, one per tick)
			try {
				Sites.Removed done = Sites.removeDetailed(level, id, false);
				done.returned().forEach((k, v) -> r.refund.merge(k, v, Integer::sum));
				r.sites.remove(0);
			} catch (Sites.SiteException e) {
				end(server, r, new Removed(false, List.of(e.getMessage()), Map.copyOf(r.refund)));
			}
			Placement.save(server, false);
			return;
		}
		r.current = id;
		Placement.add(server, new RestoreJob(id, RestoreJob.REMOVE, null, null));
	}

	/** A restore job of a removal finished (Placement). */
	static void removed(MinecraftServer server, RestoreJob job) {
		for (Removal r : REMOVALS) {
			if (job.siteId.equals(r.current)) {
				r.current = null;
				r.sites.remove(job.siteId);
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
		REMOVALS.forEach(r -> r.futures.forEach(f -> f.completeExceptionally(new IllegalStateException("the world stopped"))));
		REMOVALS.clear();
		tick = 0;
	}
}
