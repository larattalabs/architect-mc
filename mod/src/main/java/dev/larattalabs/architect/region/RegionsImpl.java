package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.LotSpec;
import dev.larattalabs.architect.api.LotState;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PrepareRequest;
import dev.larattalabs.architect.api.PrepareView;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RegionBudget;
import dev.larattalabs.architect.api.RegionPlan;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.api.RegionView;
import dev.larattalabs.architect.api.Regions;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.api.StageProgress;
import dev.larattalabs.architect.batch.LotFitting;
import dev.larattalabs.architect.batch.QBatch;
import dev.larattalabs.architect.batch.QItem;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Adopt;
import dev.larattalabs.architect.site.Batches;
import dev.larattalabs.architect.site.RegionItems;
import dev.larattalabs.architect.site.SiteGroupRec;
import dev.larattalabs.architect.site.Sites;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * {@link Regions} (phase 6a): plans (survey -> sidecar -> IR, kept in the world), prepare ({@link Prepare}), realise (the
 * region's batch of tile, road and lot items in a new site group, {@link Batches#queueRegion}), undo (the group's undo) and the
 * region records. Server thread unless noted.
 */
public final class RegionsImpl implements Regions {
	public static final RegionsImpl INSTANCE = new RegionsImpl();
	/** The streaming window W (config {@code regionWindow}, 1-16). */
	static int window = Integer.getInteger("architect.regionWindow", 4);

	/** A plan the mod holds: the IR, its survey, the sidecar's answer. */
	public record PlanRec(String planId, String programId, String programSha, String irSha, String surveySha, long seed, String dimension, int[] claim,
		@Nullable String owner, JsonObject ext, JsonObject planned, Ir ir, int chunks, int chunksToGenerate, @Nullable String opKey, @Nullable String opHash) {
	}

	/** A region in memory: its record, IR and world. */
	public record Live(RegionRec rec, Ir ir, Path world, int rid, @Nullable String revPlanId, @Nullable String revIrSha) {
		public Live(RegionRec rec, Ir ir, Path world) {
			this(rec, ir, world, 0, null, null);
		}

		/** (6d RV) The plan id and IR sha a tile request names: a revision's own (its IR), else the region's. */
		public String planIdForTiles() {
			return revPlanId != null ? revPlanId : rec.planId;
		}

		public String irShaForTiles() {
			return revIrSha != null ? revIrSha : rec.irSha;
		}

		public @Nullable ServerLevel level(MinecraftServer server) {
			return Sites.levelOf(server, rec.dimension);
		}

		public JsonObject irJson() {
			return ir.json();
		}
	}

	/** (6c RS) Whether a region realises in survival. */
	public static boolean survival(Live l) {
		return l.rec().survival();
	}

	/** (6c RS) A survival region's target groups (its IR's {@code survival.groups}, ARTL v2's group indexes). */
	public static List<String> survivalGroups(Live l) {
		return RegionSurvival.groups(l.ir().json());
	}

	/** (6c RS) A tile's free-pass cells per part, counted into the region's record (RegionView.build's freeCells). */
	public static void freeCells(Live l, Map<String, Long> freeOf) {
		JsonObject sv = l.rec().survival;
		if (sv == null || freeOf.isEmpty()) {
			return;
		}
		JsonObject f = sv.get("freeCells") instanceof JsonObject o ? o : new JsonObject();
		freeOf.forEach((k, v) -> f.addProperty(k, (f.has(k) ? f.get(k).getAsLong() : 0L) + v));
		sv.add("freeCells", f);
	}

	private static final Map<String, PlanRec> PLANS = new ConcurrentHashMap<>();
	private static final Map<String, Live> REGIONS = new LinkedHashMap<>();
	private static final Map<String, CompletableFuture<JsonObject>> PLANNING = new ConcurrentHashMap<>();
	/** (6b) The server a plan was asked on (its region.progress lands there). */
	private static final Map<String, MinecraftServer> PLAN_SERVER = new ConcurrentHashMap<>();
	/** (6b) Per plan: the phases it went through (planning, checking, rendering, accepted), for RegionPlan.notes and DevBridge. */
	private static final Map<String, List<String>> PROGRESS = new ConcurrentHashMap<>();
	/** (6b) Regions whose IR is stale (PLAN_STALE at resume): region -> the message. */
	private static final Map<String, String> STALE_LOGGED = new ConcurrentHashMap<>();
	/** (6b) The last actions each region showed (REGION_STATE fires when they change). Server thread. */
	private static final Map<String, List<dev.larattalabs.architect.api.WaitAction>> LAST_ACTIONS = new HashMap<>();
	/** (6c X, C20) A plan's operation key in the registry: its body hash, the plan once accepted, the future while it plans. */
	private record KeyedPlan(String hash, @Nullable String planId, @Nullable CompletableFuture<RegionPlan> future) {
	}

	/** (6c X, C20) A realise that has not written its region record yet. */
	private record KeyedRealise(String hash, CompletableFuture<String> future) {
	}

	/** (6c X, C20) {@link RegionKeys#scope} of (owner, "region.plan", key) -> the plan (loaded from the plans' key files at world start). */
	/** (6c X, C22) Removed regions (removed.json): their tombstones, loaded at world start. */
	private static final Map<String, RegionRec> TOMBS = new ConcurrentHashMap<>();
	private static final Map<String, KeyedPlan> PLAN_KEYS = new ConcurrentHashMap<>();
	/** (6c X, C20) Realises starting with a key (before their region exists; after that REGIONS holds the key). Server thread. */
	private static final Map<String, KeyedRealise> REALISE_KEYS = new HashMap<>();
	/** DevBridge {@code dev.region.holdRealise} (gate item 3): the next keyed realise's future stays pending after its region record is saved. */
	private static volatile boolean holdNextRealise;
	private static volatile @Nullable String lastKitWarning;
	/** Per-stage drift checks running ({@code region/stage}). Server thread. */
	private static final Map<String, CompletableFuture<Drift.Result>> STAGE_CHECKS = new HashMap<>();
	private static @Nullable MinecraftServer server;
	private static long lastProgress;
	private static int nextRegion = 1;
	private static volatile boolean revisionsPending;

	private RegionsImpl() {
	}

	public static int window() {
		return Math.max(1, Math.min(16, window));
	}

	public static void init() {
		dev.larattalabs.architect.site.Groups.GROUP_ENDED = RegionsImpl::groupEnded;
		SiteEvents.SITE_REMOVED.register(Revisions::siteRemoved); // (6d RV, §4.6) a region's lot removed alone reads `removed`
		DamageLog.init(); // (6c H) dev.entity.damage (a villager stand's drowning)
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTED.register(RegionsImpl::started);
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(s -> Heights.flush());
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			REGIONS.clear();
			PLANS.clear();
			PLAN_KEYS.clear();
			REALISE_KEYS.clear();
			TOMBS.clear();
			Heights.forget(null);
			TileStream.forgetRegion(null);
			Prepare.stopAll();
			STAGE_CHECKS.clear();
			GENERATED.clear();
			RegionFluids.forget(null);
			GenCounter.realising(false);
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(s -> {
			if (reconcilePending) {
				reconcilePending = false;
				reconcileRemovals();
			}
			if (revisionsPending) {
				revisionsPending = false;
				Revisions.recover(s); // (6d RV, §4.3) revisions accepted before a stop: installed or ended
			}
			Revisions.undoTick(s); // (6d RV, §4.4) running undos take their next step
			RegionSurvey.tick(s);
			Prepare.tick(s);
			RegionHash.tick(s);
			generatedDuringRealise(s);
			actionsTick(s);
			Brushes.tick(s);
			RegionFluids.tick(s); // (6c H) the fluids stage: forced ticks, settle and census, the escape guard
			PlanRetention.replaySidecar(s, false); // (6c close-out A) discarded plans' helper dirs, once per helper link
		});
	}

	private static void started(MinecraftServer s) {
		server = s;
		REGIONS.clear();
		Path w = s.getWorldPath(LevelResource.ROOT);
		Path root = RegionStore.root(w);
		PLAN_KEYS.clear();
		REALISE_KEYS.clear();
		TOMBS.clear();
		PlanRetention.loadTombstones(w); // (6c close-out A) discarded keyed plans
		if (!Files.isDirectory(root)) {
			return;
		}
		loadPlanKeys(root.resolve("plans"));
		try (var st = Files.list(root)) {
			for (Path d : st.toList()) {
				Path f = d.resolve("region.json");
				if (!Files.isRegularFile(f)) {
					Path rm = d.resolve("removed.json");
					if (Files.isRegularFile(rm)) {
						try {
							RegionRec t = RegionRec.fromJson(RegionStore.readJson(rm));
							if (t.removedAt <= 0) {
								t.removedAt = Files.getLastModifiedTime(rm).toMillis(); // a record written before 6c X: its file's time
							}
							t.state = RegionState.REMOVED;
							TOMBS.put(t.id, t);
						} catch (IOException | RuntimeException e) {
							Architect.LOGGER.warn("Removed region {} unreadable: {}", d.getFileName(), e.toString());
						}
					}
					continue;
				}
				try {
					RegionRec r = RegionRec.fromJson(RegionStore.readJson(f));
					JsonObject irJson = RegionStore.readJson(d.resolve("ir.json"));
					// (6b) read leniently: a region whose IR this mod can't evaluate still loads (it waits PLAN_STALE and can be removed)
					Ir ir = Ir.lenient(irJson, r.claim);
					Live live = new Live(r, ir, w);
					REGIONS.put(r.id, live);
					nextRegion = Math.max(nextRegion, num(r.id) + 1);
					String stale = staleReason(irJson);
					if (stale != null && r.state != RegionState.PLACED) {
						STALE_LOGGED.put(r.id, stale);
						Architect.LOGGER.warn("Region {} resumes stale (PLAN_STALE): {}; nothing of it is requested or written (it can be removed)", r.id, stale);
					}
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Region {} unreadable: {}", d.getFileName(), e.toString());
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Regions unreadable: {}", e.toString());
		}
		Prepare.resumeAll(s);
		PlanChecks.started(s); // (6c P0) check keys, artifacts, pins and tombstones
		TOMBS.values().forEach(t -> PlanChecks.regionRemoved(t, true)); // (C36) a REMOVED region whose artifact is still held, unpinned
		// (6c close-out A, §2, §3, §14) keyed pins past their last use (or whose key has its region), then unrealised plans past theirs
		PlanChecks.sweepKeyedPins(s);
		PlanRetention.sweep(s);
		reconcilePending = true;
		Revisions.started(); // (6d RV) caches; the manifests resume at the first tick (the batches load at SERVER_STARTED too)
		revisionsPending = true;
		Architect.LOGGER.info("Regions: {} loaded", REGIONS.size());
	}

	/** (6c X, C20) The plans' key files ({@code plans/<id>.key.json}: {owner?, opKey, opHash, planId}) into the registry. */
	private static void loadPlanKeys(Path plans) {
		if (!Files.isDirectory(plans)) {
			return;
		}
		try (var st = Files.list(plans)) {
			for (Path f : st.filter(x -> x.getFileName().toString().endsWith(".key.json")).toList()) {
				try {
					JsonObject o = RegionStore.readJson(f);
					if (o != null && o.has("opKey") && o.has("opHash") && o.has("planId")) {
						PLAN_KEYS.put(RegionKeys.scope(o.has("owner") ? o.get("owner").getAsString() : null, "region.plan", o.get("opKey").getAsString()),
							new KeyedPlan(o.get("opHash").getAsString(), o.get("planId").getAsString(), null));
					}
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Region plan key {} unreadable: {}", f.getFileName(), e.toString());
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plan keys unreadable: {}", e.toString());
		}
	}

	/** (6c B) The running server (null with no world). */
	static @Nullable MinecraftServer server() {
		return server;
	}

	/** (6c B) A region id's number (rg12 -> 12), for ordering. */
	static int order(String id) {
		return num(id);
	}

	private static int num(String id) {
		try {
			return Integer.parseInt(id.replaceAll("\\D", ""));
		} catch (NumberFormatException e) {
			return 0;
		}
	}

	public static @Nullable Live live(String regionId) {
		return REGIONS.get(regionId);
	}

	public static List<Live> all() {
		return List.copyOf(REGIONS.values());
	}

	/** (6c close-out A) A discarded plan leaves the plan cache. */
	static void forgetPlan(String planId) {
		PLANS.remove(planId);
	}

	/** (6c close-out A) A discarded keyed plan's key leaves the registry (its tombstone answers it: {@link PlanRetention#DISCARDED_KEYS}). */
	static void dropPlanKey(String scope) {
		PLAN_KEYS.remove(scope);
	}

	/** (6c close-out A) The latest removal of a REMOVED region realised from the plan (the sweep's clock), else 0. */
	static long removedAtOfPlan(String planId) {
		long t = 0;
		for (RegionRec r : TOMBS.values()) {
			if (planId.equals(r.planId)) {
				t = Math.max(t, r.removedAt);
			}
		}
		return t;
	}

	static @Nullable PlanRec planRec(String planId) {
		PlanRec p = PLANS.get(planId);
		if (p != null || server == null) {
			return p;
		}
		try {
			JsonObject o = RegionStore.readJson(RegionStore.plan(server.getWorldPath(LevelResource.ROOT), planId));
			if (o == null) {
				return null;
			}
			p = planFromJson(o);
			PLANS.put(planId, p);
			return p;
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Region plan {} unreadable: {}", planId, e.toString());
			return null;
		}
	}

	// ------------------------------------------------------------------ plan

	@Override
	public CompletableFuture<RegionPlan> plan(RegionPlanRequest r) {
		MinecraftServer s = r.level().getServer();
		server = s;
		// (6c X, C19) a lot's ext out of bounds: FIELD_LIMIT with the path, nothing sent
		String limit = dev.larattalabs.architect.apiimpl.FieldLimits.lotExt(r.params());
		if (limit != null) {
			return failed(Reason.FIELD_LIMIT, limit);
		}
		// (6c X, C20) an operation key: the same (owner, key) and body returns the existing plan (also while it plans); another body refuses
		String key;
		try {
			key = dev.larattalabs.architect.apiimpl.Wire0a.opKey(r.opKey());
		} catch (IllegalArgumentException e) {
			return CompletableFuture.failedFuture(e);
		}
		if (key == null) {
			return plan0(r, s, null, null);
		}
		String hash = RegionKeys.hash(RegionKeys.planBody(r));
		String scope = RegionKeys.scope(r.owner(), "region.plan", key);
		// (6c close-out A, §3) a discarded keyed plan: the same body refuses PLAN_STALE (never planned again silently); another, OP_KEY_CONFLICT
		String[] gone = PlanRetention.DISCARDED_KEYS.get(scope);
		if (gone != null && !PLAN_KEYS.containsKey(scope)) {
			return CompletableFuture.failedFuture(gone[1].equals(hash) ? new RegionException(Reason.PLAN_STALE, "plan " + gone[0] + " of opKey \"" + key
				+ "\" was discarded", PlanRetention.DISCARDED) : new dev.larattalabs.architect.api.ArchitectRefused(Reason.OP_KEY_CONFLICT, "opKey \"" + key
					+ "\" (region.plan" + (r.owner() == null ? "" : ", " + r.owner()) + ") was used for another plan (" + gone[0] + ", discarded)"));
		}
		CompletableFuture<RegionPlan> mine = new CompletableFuture<>();
		KeyedPlan[] prior = {null};
		PLAN_KEYS.compute(scope, (k, old) -> {
			if (old != null && old.planId() != null && planRec(old.planId()) == null) {
				old = null; // its plan file is gone: the key is too
			}
			prior[0] = old;
			return old != null ? old : new KeyedPlan(hash, null, mine);
		});
		KeyedPlan kp = prior[0];
		if (kp != null) {
			if (!kp.hash().equals(hash)) {
				return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.ArchitectRefused(Reason.OP_KEY_CONFLICT, "opKey \"" + key
					+ "\" (region.plan" + (r.owner() == null ? "" : ", " + r.owner()) + ") was used for another plan" + (kp.planId() != null ? " (" + kp.planId() + ")" : "")));
			}
			if (kp.planId() != null) {
				PlanRec pr = planRec(kp.planId());
				PlanRetention.touch(kp.planId()); // (6c close-out A) adopted by its key: a use
				Architect.LOGGER.info("Region plan {}: adopted by opKey {}", kp.planId(), key);
				return CompletableFuture.completedFuture(view(pr));
			}
			Architect.LOGGER.info("Region plan: adopted by opKey {} (still planning)", key);
			return kp.future();
		}
		CompletableFuture<RegionPlan> out = plan0(r, s, key, hash);
		out.whenComplete((v, e) -> {
			if (e != null) {
				PLAN_KEYS.remove(scope); // nothing was kept: the key can be used again
				mine.completeExceptionally(e);
			} else {
				PLAN_KEYS.put(scope, new KeyedPlan(hash, v.planId(), null));
				mine.complete(v);
			}
		});
		return mine;
	}

	// ------------------------------------------------------------------ (6c P0) plan check v0 ({@link PlanChecks})

	@Override
	public CompletableFuture<RegionPlan> planRevision(String regionId, dev.larattalabs.architect.api.RevisionRequest r) {
		return Revisions.plan(regionId, r); // (6d RV)
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.RemoveResult> undoRevision(String regionId, int toPosition, String actor) {
		return Revisions.undo(regionId, toPosition, actor); // (6d RV, §4.4)
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.PlanCheck> checkPlan(dev.larattalabs.architect.api.PlanRequest r) {
		return PlanChecks.check(r);
	}

	@Override
	public com.google.gson.JsonObject planCatalogue() {
		return PlanCatalogue.get(); // (C38) the mod jar's own catalogue: synchronous, no helper
	}

	@Override
	public boolean cancelCheck(@Nullable String owner, String opKey) {
		return PlanChecks.cancel(owner, opKey);
	}

	@Override
	public Optional<dev.larattalabs.architect.api.PlanCheck> checkByKey(@Nullable String owner, String opKey) {
		return PlanChecks.byKey(owner, opKey);
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.RegionPreviews> planImages(String checkId, java.util.Set<dev.larattalabs.architect.api.PreviewView> views) {
		return PlanChecks.images(checkId, views);
	}

	@Override
	public Optional<dev.larattalabs.architect.api.PlanArtifact> artifact(String artifactSha) {
		return PlanChecks.artifact(artifactSha);
	}

	@Override
	public CompletableFuture<String> realiseApproved(dev.larattalabs.architect.api.ApprovedRealise r) {
		return PlanChecks.realiseApproved(r);
	}

	@Override
	public Optional<dev.larattalabs.architect.api.PaletteCheck> checkPalette(String artifactSha, java.util.Map<String, String> lotEntries) {
		return PaletteRules.check(artifactSha, lotEntries);
	}

	@Override
	public void pinArtifact(String artifactSha, String owner) {
		PlanChecks.pin(artifactSha, owner, true);
	}

	@Override
	public void unpinArtifact(String artifactSha, String owner) {
		PlanChecks.pin(artifactSha, owner, false);
	}

	/** (6c close-out A, §2) A keyed pin ({@link PlanChecks#pinKeyed}). */
	@Override
	public void pinArtifact(String artifactSha, String owner, String opKey) {
		PlanChecks.pinKeyed(artifactSha, owner, opKey);
	}

	/** (6c close-out A, §3) {@link PlanRetention#discard}. */
	@Override
	public CompletableFuture<Boolean> discardPlan(String planId) {
		return PlanRetention.discard(planId);
	}

	/** (6c B) One brush stroke as a region ({@link Brushes}). */
	@Override
	public CompletableFuture<RegionView> brush(dev.larattalabs.architect.api.BrushRequest r) {
		return Brushes.stroke(r, false);
	}

	/** (6c X, C20) The plan of an owner's operation key, in any state, after a restart too; empty while it still plans. */
	@Override
	public Optional<RegionPlan> planByKey(@Nullable String owner, String opKey) {
		String key = java.util.Objects.requireNonNull(dev.larattalabs.architect.apiimpl.Wire0a.opKey(opKey), "opKey");
		KeyedPlan kp = PLAN_KEYS.get(RegionKeys.scope(owner, "region.plan", key));
		PlanRec p = kp == null || kp.planId() == null ? null : planRec(kp.planId());
		if (p != null) {
			PlanRetention.touch(p.planId()); // (6c close-out A) a lookup by key is a use
		}
		return p == null ? Optional.empty() : Optional.of(view(p));
	}

	/** (6c X, C20) The region an owner realised with this operation key (the plan's owner), in any state; empty once it was removed. */
	@Override
	public Optional<RegionView> realiseByKey(@Nullable String owner, String opKey) {
		String key = java.util.Objects.requireNonNull(dev.larattalabs.architect.apiimpl.Wire0a.opKey(opKey), "opKey");
		Live l = regionByKey(owner, key);
		if (l == null) {
			Object[] rv = revisionByKey(owner, key); // (6d GR, S-GR-3) a revision realised under the key: its region (RegionView.revisions names it)
			l = rv == null ? null : (Live) rv[0];
		}
		return l == null ? Optional.empty() : Optional.of(view(l));
	}

	/**
	 * (6d GR, S-GR-3) The standing revision realised under {@code key} by {@code owner}'s region ({@code [Live, Revisions.Rev]}), or null: a
	 * growth is an ordinary keyed build (Steward's {@code steward.<buildId>.vrealise}); an undone revision frees its key, as a removed region.
	 */
	static Object @Nullable [] revisionByKey(@Nullable String owner, String key) {
		for (Live l : REGIONS.values()) {
			if (!java.util.Objects.equals(owner, l.rec().owner)) {
				continue;
			}
			for (Revisions.Rev r : l.rec().revisions) {
				if (key.equals(r.opKey) && r.standing()) {
					return new Object[] {l, r};
				}
			}
		}
		return null;
	}

	private static @Nullable Live regionByKey(@Nullable String owner, String key) {
		for (Live l : REGIONS.values()) {
			if (key.equals(l.rec().opKey) && java.util.Objects.equals(owner, l.rec().owner)) {
				return l;
			}
		}
		return null;
	}

	private CompletableFuture<RegionPlan> plan0(RegionPlanRequest r, MinecraftServer s, @Nullable String opKey, @Nullable String opHash) {
		return plan0raw(r, s).thenCompose(o -> onServer(s, () -> finishPlan(r, (JsonObject) o[0], (JsonObject) o[1], (byte[]) o[2], opKey, opHash))).thenCompose(
			f -> f);
	}

	/** {@link #plan0} up to the planned message: {planned, ir, survey} (a dry plan stops here: nothing is kept). */
	private CompletableFuture<Object[]> plan0raw(RegionPlanRequest r, MinecraftServer s) {
		// (6d RV) a revision's plan: the region's standing rules, its rid and its revision input (Revisions.prepare)
		String revRegion = Revisions.regionOf(r);
		if (revRegion != null) {
			String[] no = Revisions.prepare(r, s);
			if (no != null) {
				return failedRaw(Reason.valueOf(no[0]), no[1]);
			}
		}
		if (r.level().dimension() != Level.OVERWORLD) {
			return failedRaw(Reason.NOT_ALLOWED, "regions are Overworld only in this version");
		}
		BoundingBox c = r.claim();
		int big = Boolean.getBoolean("architect.dev.bigRegions") ? 2048 : 1024;
		if (c.getXSpan() > big || c.getZSpan() > big) {
			return failedRaw(Reason.REGION_LIMIT, "the claim is " + c.getXSpan() + "x" + c.getZSpan() + " columns (at most " + big + "x" + big + ")");
		}
		// 6c V: the owner's protected areas that meet the claim go to the plan as keepOut (a program that honours them records them
		// in its IR); the claim is judged against them at accept and at realise (protectedClaim with the IR's honoured set). 0c refused
		// here at once; a program that reads no keepOut is now refused at accept, with the same reason.
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return failedRaw(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		// (6c D1) beside a standing region: it must stand (same dimension, same owner), and the claim may overlap it only in a seam of at
		// most 16 columns, never over its lots, roads or paths (OVERLAP, nothing planned); the plan reads its footprint and graph
		CompletableFuture<@Nullable Void> reachReady = CompletableFuture.completedFuture(null);
		if (r.beside() != null) {
			Live st = REGIONS.get(r.beside());
			if (st == null || st.rec().state == RegionState.REMOVED) {
				return failedRaw(Reason.OTHER, "beside: no standing region " + r.beside());
			}
			// (6c D3, Steward's finding) a town in flight is busy (PREPARING, PLACING, REMOVING); PLACED, PARTIAL and FAILED with cells
			// standing are valid beside towns, at plan, at checkBeside and at realise
			String busy = besideBusy(st);
			if (busy != null) {
				return failedRaw(Reason.OVERLAP_BUSY, "beside: region " + r.beside() + " is " + busy);
			}
			if (!st.rec().dimension.equals(Sites.dimensionId(r.level()))) {
				return failedRaw(Reason.NOT_ALLOWED, "beside: region " + r.beside() + " is in " + st.rec().dimension);
			}
			if (!java.util.Objects.equals(st.rec().owner, r.owner())) {
				return failedRaw(Reason.OVERLAP_OWNED, "beside: region " + r.beside() + " is " + (st.rec().owner == null ? "the player's" : st.rec().owner + "'s"));
			}
			int[] sc = st.rec().claim; // [x0, y0, z0, x1, y1, z1]
			int[] standing = {sc[0], sc[2], sc[3], sc[5]}, mine = {c.minX(), c.minZ(), c.maxX(), c.maxZ()};
			String seam = BesideCheck.seamProblem(standing, Revisions.effective(st), mine); // (6d RV, §4.5) the effective IR
			if (seam != null) {
				return failedRaw(Reason.OVERLAP, "beside " + r.beside() + ": " + seam);
			}
			BESIDE.put(r, BesideCheck.besideData(r.beside(), standing, Revisions.effective(st), mine));
			// (6c D3, §2.4) the reach inputs: the town claim's survey (resolution 1, loaded chunks only), the held columns over its claim
			// (the journal now) and its standing data; the plan reads them only when its seam step finds no join
			// ((7a GJ, §4) and a wall region round the town (its own claim's survey, held columns, standing data and gates): the reach inputs
			// then travel as a map {town, wall region}; the plan reads the wall region's only where D3 would answer NO_JOIN [wall])
			Live wr = GateJoin.wallRegionRound(st);
			if (wr == null) {
				reachReady = reachInputs(r, st, standing);
			} else {
				int[] wc = wr.rec().claim;
				int[] wrc = {wc[0], wc[2], wc[3], wc[5]};
				reachReady = reachInputs(r, st, standing, true).thenCompose(v -> reachInputs(r, wr, wrc, true));
			}
		}
		// (6c D2) the claim's biome grid (4x4, loaded chunks): a program following a biome edge reads it (ctx.biomes)
		BIOMES.put(r, BiomeGrid.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ()));
		warnKitMismatch();
		int res = (long) c.getXSpan() * c.getZSpan() <= 256L * 256 ? 1 : 4;
		progress(s, null, "planning");
		CompletableFuture<Object[]> out = reachReady.thenCompose(rv -> RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), res, r.surveyLoad())).thenCompose(cols -> {
			if (revRegion != null) {
				Revisions.overlayFrozen(cols, s.getWorldPath(LevelResource.ROOT), revRegion); // (6d RV) the region's frozen heights where it froze them
			}
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> planOnce(link, r, blobId, surveySha, survey, null).thenCompose(o -> {
				JsonObject planned = (JsonObject) o[0];
				JsonArray need = planned.has("needVolumes") && planned.get("needVolumes").isJsonArray() ? planned.getAsJsonArray("needVolumes")
					: new JsonArray();
				// (6c T1) a program that declares passes (the kit's word in region.planned) gets its second plan over a resolution-1
				// survey up to 1024x1024 columns; past that the passes run coarse
				boolean passes = planned.get("passes") instanceof JsonArray pa && !pa.isEmpty();
				int res2 = secondSurveyRes(passes, res, c.getXSpan(), c.getZSpan());
				if (passes && res2 == 4) {
					addNote(planned, "the passes ran on the resolution-4 survey (coarse): the claim is over 1024 columns on a side");
				}
				if (res2 != res) {
					return RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), res2, r.surveyLoad()).thenCompose(cols2 -> {
						byte[] survey2 = cols2.encode();
						String sha2 = Packed.sha256(survey2);
						return BlobPut.put(link, survey2, "survey").thenCompose(blob2 -> {
							CompletableFuture<@Nullable JsonArray> vols = need.isEmpty() || r.ext().has(EXT_NO_VOLUMES) ? CompletableFuture.completedFuture(null)
								: volumesFor(r.level(), need);
							return vols.thenCompose(v -> planOnce(link, r, blob2, sha2, survey2, v).thenApply(o2 -> {
								JsonObject p2 = (JsonObject) o2[0];
								addNote(p2, "second plan: a resolution-1 survey for the passes (" + cols2.width + "x" + cols2.depth + " columns, "
									+ survey2.length + " bytes)");
								if (v != null) {
									addNote(p2, "read " + v.size() + " frozen volume" + (v.size() == 1 ? "" : "s") + " (two-plan flow)");
									p2.add("volumes", v);
								} else if (!need.isEmpty() && !r.ext().has(EXT_NO_VOLUMES)) {
									addNote(p2, "the program asked for " + need.size() + " volume" + (need.size() == 1 ? "" : "s")
										+ " over chunks not generated yet: prepare, then plan again to read them");
								}
								return o2;
							}));
						});
					});
				}
				if (need.isEmpty() || r.ext().has(EXT_NO_VOLUMES)) {
					return CompletableFuture.completedFuture(o);
				}
				// (6b) the two-plan flow: the program asked for volumes (r.needVolume); sample them where their chunks are
				// generated, then plan again with them. Otherwise the first plan stands, with a note to prepare and plan again.
				return volumesFor(r.level(), need).thenCompose(vols -> {
					if (vols == null) {
						addNote(planned, "the program asked for " + need.size() + " volume" + (need.size() == 1 ? "" : "s")
							+ " over chunks not generated yet: prepare, then plan again to read them");
						return CompletableFuture.completedFuture(o);
					}
					return planOnce(link, r, blobId, surveySha, survey, vols).thenApply(o2 -> {
						addNote((JsonObject) o2[0], "read " + vols.size() + " frozen volume" + (vols.size() == 1 ? "" : "s") + " (two-plan flow)");
						((JsonObject) o2[0]).add("volumes", vols);
						return o2;
					});
				});
			}));
		});
		out.whenComplete((p, e) -> {
			Revisions.INPUT.remove(r);
			Revisions.CANDIDATE.remove(r);
			BESIDE.remove(r);
			REACH.remove(r);
			REACH_SURVEY.remove(r);
			BIOMES.remove(r);
			if (e != null) {
				progress(s, null, "failed");
			}
		});
		return out;
	}

	private static CompletableFuture<Object[]> failedRaw(Reason reason, String message) {
		return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.ArchitectRefused(reason, message));
	}

	/** (6c D3, §7) Dry plans in flight (by request identity): planOnce sends {@code dry: true}; nothing is kept. */
	private static final java.util.Set<RegionPlanRequest> DRY = java.util.Collections.synchronizedSet(java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>()));

	/**
	 * (6c D3, D-S4, §7) The dry beside check: exactly {@link #plan}'s path (the beside checks, both surveys, the held set, the kit's plan
	 * and check) with {@code dry: true}; nothing is kept (no plan id, record, file, opKey entry, blob, write, ticket or prepare). The
	 * verdict: fits with the join and the land, or the reason and message the plan would have failed with and the kit's named code.
	 */
	@Override
	public CompletableFuture<dev.larattalabs.architect.api.BesideVerdict> checkBeside(RegionPlanRequest r) {
		if (r.beside() == null) {
			return CompletableFuture.failedFuture(new dev.larattalabs.architect.api.ArchitectRefused(Reason.NOT_ALLOWED,
				"checkBeside needs a request beside a standing region (RegionPlanRequest.beside)"));
		}
		MinecraftServer s = r.level().getServer();
		server = s;
		long t0 = System.nanoTime();
		String limit = dev.larattalabs.architect.apiimpl.FieldLimits.lotExt(r.params());
		if (limit != null) {
			return CompletableFuture.completedFuture(BesideVerdicts.failed(Reason.FIELD_LIMIT, limit, t0));
		}
		DRY.add(r);
		String keyNote = r.opKey() != null ? " (the request's opKey is ignored: a dry check keeps nothing)" : "";
		CompletableFuture<dev.larattalabs.architect.api.BesideVerdict> out = plan0raw(r, s).handle((o, e) -> {
			if (e != null) {
				Throwable t = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
				Reason reason = t instanceof dev.larattalabs.architect.api.ArchitectRefused ar ? ar.reason() : null;
				return BesideVerdicts.failed(reason, String.valueOf(t.getMessage()) + keyNote, t0);
			}
			Live st = REGIONS.get(r.beside());
			int[] tc = st == null ? null : st.rec().claim;
			JsonObject town = st == null ? null : Revisions.effective(st);
			return BesideVerdicts.fits(r.beside(), (JsonObject) o[1], tc == null ? null : new int[] {tc[0], tc[2], tc[3], tc[5]}, town, keyNote, t0);
		});
		out.whenComplete((v, e) -> DRY.remove(r));
		return out;
	}

	/** (6c D1) The beside data of a plan in flight (by request identity), read by planOnce for its region.plan message. */
	private static final Map<RegionPlanRequest, JsonObject> BESIDE = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());
	/**
	 * (6c D3) The reach inputs of a plan in flight (by request identity): {@code {surveyBlobId, held, standing}} for the region.plan message's
	 * {@code besideReach}, and the survey bytes ({@code _survey}, kept with the plan when its IR has a reach). A plan check's map
	 * {regionId: inputs} for its endpoint.region regions.
	 */
	static final Map<RegionPlanRequest, JsonObject> REACH = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());
	static final Map<RegionPlanRequest, Map<String, byte[]>> REACH_SURVEY = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());

	/** (6c D3, Steward's finding) Why a standing region is no beside town now (in flight), or null: PLACED, PARTIAL and FAILED are. */
	static @Nullable String besideBusy(Live st) {
		RegionState s = st.rec().state;
		return s == RegionState.PREPARING || s == RegionState.PLACING || s == RegionState.REMOVING ? s.name() : null;
	}

	/**
	 * (6c D3, §2.4) One standing region's reach inputs for a plan over {@code r}'s claim: its claim's survey (resolution 1, loaded chunks
	 * only) uploaded as a blob, the held columns over its claim from the journal (by owner: its own group's, its terrain's) and its
	 * standing data. Put in {@link #REACH} (keyed by the region id when {@code map}).
	 */
	static CompletableFuture<@Nullable Void> reachInputs(RegionPlanRequest r, Live st, int[] standing) {
		return reachInputs(r, st, standing, false);
	}

	static CompletableFuture<@Nullable Void> reachInputs(RegionPlanRequest r, Live st, int[] standing, boolean map) {
		TileStream.Link link = TileStream.link;
		ServerLevel level = r.level();
		JsonObject held;
		try {
			held = BesideReach.held(Sites.dimensionId(level), standing, st.rec().groupId, BesideReach.propsStages(Revisions.effective(st)), null);
		} catch (IOException e) {
			return CompletableFuture.failedFuture(refusal(Reason.JOURNAL_UNAVAILABLE, "beside: the held columns could not be read (" + e.getMessage() + ")"));
		}
		JsonObject std = BesideReach.standing(st.rec().id, standing, Revisions.effective(st));
		// ((7a GJ, §2) its walls' gates as the world holds them now; only when it has any: never in `standing`, whose sha a reach IR records)
		JsonArray gates = GateJoin.gates(st.rec().id, Revisions.effective(st));
		GateJoin.standsCheck(level, gates);
		return RegionSurvey.sample(level, standing[0], standing[1], standing[2], standing[3], 1, LoadPolicy.LOADED_ONLY).thenCompose(cols -> {
			byte[] bytes = cols.encode();
			return BlobPut.put(link, bytes, "survey").thenAccept(blobId -> {
				JsonObject o = new JsonObject();
				o.addProperty("surveyBlobId", blobId);
				o.addProperty("surveySha", Packed.sha256(bytes));
				o.add("held", held);
				o.add("standing", std);
				if (!gates.isEmpty()) {
					o.add("gates", gates);
				}
				if (map) {
					REACH.computeIfAbsent(r, k -> new JsonObject()).add(st.rec().id, o);
				} else {
					REACH.put(r, o);
				}
				REACH_SURVEY.computeIfAbsent(r, k -> new java.util.concurrent.ConcurrentHashMap<>()).put(st.rec().id, bytes);
			});
		});
	}
	/** (6c D2) The biome grid of a plan in flight (by request identity), read by planOnce. */
	private static final Map<RegionPlanRequest, JsonObject> BIOMES = java.util.Collections.synchronizedMap(new java.util.IdentityHashMap<>());

	/**
	 * (6c B) A brush stroke's plan ({@link Brushes}): one {@code region.plan} over a resolution-1 survey of the claim (the brush box
	 * plus 8, LOADED_ONLY) with the stroke's frozen volume already given (no two-plan flow), no checker, then the plan record.
	 */
	CompletableFuture<RegionPlan> planStroke(RegionPlanRequest r, @Nullable JsonArray volumes) {
		MinecraftServer s = r.level().getServer();
		server = s;
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return failed(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		BoundingBox c = r.claim();
		return RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), 1, LoadPolicy.LOADED_ONLY).thenCompose(cols -> {
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> planOnce(link, r, blobId, surveySha, survey, volumes, true));
		}).thenCompose(o -> {
			if (volumes != null) {
				((JsonObject) o[0]).add("volumes", volumes);
			}
			return onServer(s, () -> finishPlan(r, (JsonObject) o[0], (JsonObject) o[1], (byte[]) o[2], null, null));
		}).thenCompose(f -> f);
	}

	/**
	 * (6c T1, CONTRACT T1 §3) The second plan's survey resolution: 1 for a program that declares passes on a claim up to 1024 columns
	 * a side (its first plan's survey was resolution 4 past 256x256), else the first plan's.
	 */
	static int secondSurveyRes(boolean passes, int firstRes, int xSpan, int zSpan) {
		return passes && firstRes != 1 && xSpan <= 1024 && zSpan <= 1024 ? 1 : firstRes;
	}

	/** DevBridge test hook (gate item 10(b)): members merged into the next accepted plan's IR before the PLAN_STALE gate. */
	public static volatile @Nullable JsonObject DOCTOR_NEXT_PLAN;

	/** RegionPlanRequest ext: {@code false} skips the checker and the previews (the sidecar gets {@code check: false}). */
	public static final String EXT_CHECK = "architect_mc:check";
	/** RegionPlanRequest ext (any value): the first plan stands even when the program asks for volumes (no two-plan flow). */
	public static final String EXT_NO_VOLUMES = "architect_mc:noVolumes";

	static boolean checkOf(RegionPlanRequest r) {
		JsonElement e = r.ext().get(EXT_CHECK);
		return e == null || !e.isJsonPrimitive() || !(e.getAsJsonPrimitive().isBoolean() && !e.getAsBoolean());
	}

	/** One {@code region.plan} round: send, wait for {@code region.planned}, read the IR, PLAN_STALE gate (a). {planned, ir, survey}. */
	private static CompletableFuture<Object[]> planOnce(TileStream.Link link, RegionPlanRequest r, String blobId, String surveySha, byte[] survey,
		@Nullable JsonArray volumes) {
		return planOnce(link, r, blobId, surveySha, survey, volumes, false);
	}

	/**
	 * (6c B) {@code stroke}: a brush stroke's plan. Its claim is the brush box plus the survey margin, so the owner's protected areas
	 * are judged by {@link Brushes} against the brush box itself (before the plan and at realise), not here, and none go as keepOut.
	 */
	static CompletableFuture<Object[]> planOnce(TileStream.Link link, RegionPlanRequest r, String blobId, String surveySha, byte[] survey,
		@Nullable JsonArray volumes, boolean stroke) {
		return planOnce(link, r, blobId, surveySha, survey, volumes, stroke, null);
	}

	/** (6c P0) {@code extra}: members added to the {@code region.plan} message (a plan check's planCache, previewViews, timeoutMs, heapMb). */
	static CompletableFuture<Object[]> planOnce(TileStream.Link link, RegionPlanRequest r, String blobId, String surveySha, byte[] survey,
		@Nullable JsonArray volumes, boolean stroke, @Nullable JsonObject extra) {
		BoundingBox c = r.claim();
		JsonObject m = new JsonObject();
		if (extra != null) {
			extra.entrySet().forEach(e -> m.add(e.getKey(), e.getValue().deepCopy()));
		}
		m.addProperty("type", "region.plan");
		m.addProperty("program", r.program());
		// (6c RS) plans in the world's mode: a survival plan's IR carries the free marks and the target groups
		if (RegionSurvival.on(r.level().getServer())) {
			m.addProperty("survival", true);
		}
		m.add("params", r.params().deepCopy());
		if (r.seed() != null) {
			m.addProperty("seed", Long.toUnsignedString(r.seed()));
		}
		JsonObject cl = new JsonObject();
		cl.addProperty("minX", c.minX());
		cl.addProperty("minZ", c.minZ());
		cl.addProperty("maxX", c.maxX());
		cl.addProperty("maxZ", c.maxZ());
		cl.addProperty("minY", r.level().getMinY());
		cl.addProperty("maxY", r.level().getMaxY());
		m.add("claim", cl);
		m.addProperty("surveyBlobId", blobId);
		if (r.bible() != null) {
			m.addProperty("bible", r.bible());
		}
		if (r.bibleVersion() != null) {
			m.addProperty("bibleVersion", r.bibleVersion());
		}
		if (!checkOf(r)) {
			m.addProperty("check", false);
		}
		if (volumes != null) {
			m.add("volumes", volumes);
		}
		// 6c V: the owner's protected areas that meet the claim (an older helper ignores the member)
		// (6c PT) a plan check (plan_v0) gets the builds themselves in its params (its compiler keeps them out of zones and routes and
		// lets a road end on a door's apron), so its keepOut holds only the protected areas
		JsonArray keepOut = stroke ? new JsonArray() : keepOutOf(Sites.dimensionId(r.level()), r.owner(), new int[] {c.minX(), c.minY(), c.minZ(), c.maxX(),
			c.maxY(), c.maxZ()}, !PlanChecks.PROGRAM.equals(r.program()));
		if (!keepOut.isEmpty()) {
			m.add("keepOut", keepOut);
		}
		// (6c D1) the standing region beside the claim (an older helper ignores the member; its plan then reads no beside)
		JsonObject bd = r.beside() != null ? BESIDE.get(r) : null;
		if (bd != null) {
			m.add("beside", bd.deepCopy());
		}
		// (6c D3, §7) a dry plan (checkBeside): the helper keeps nothing
		if (DRY.contains(r)) {
			m.addProperty("dry", true);
		}
		// (6c D3, §2.4) the reach inputs (an older helper ignores the member; its plan then fails NO_JOIN as D1's did)
		JsonObject reach = REACH.get(r);
		if (reach != null) {
			m.add("besideReach", reach.deepCopy());
		}
		JsonObject bg = BIOMES.get(r);
		if (bg != null) {
			m.add("biomes", bg); // (6c D2) read-only after sampling
		}
		// (6d RV) a revision's inputs (the kit's --revision) and the base IR's roles (the revision IR's are the base's, §2.3)
		JsonObject rvIn = Revisions.INPUT.get(r);
		if (rvIn != null) {
			m.add("revision", rvIn);
			if (rvIn.get("effective") instanceof JsonObject eff && eff.get("roles") instanceof JsonObject roles) {
				m.add("roles", roles.deepCopy());
			}
		}
		MinecraftServer s = r.level().getServer();
		return link.send(m).thenCompose(ack -> {
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				return CompletableFuture.failedFuture(new IllegalStateException("the helper refused the plan: " + str(ack, "error")));
			}
			String planId = ack.getAsJsonObject("result").get("planId").getAsString();
			PLAN_SERVER.put(planId, s);
			CompletableFuture<JsonObject> done = PLANNING.computeIfAbsent(planId, k -> new CompletableFuture<>());
			// the checker and the renders: mega_bench full resolution up to 120 s + 30 s; (6c T1) a plan with passes may take 120 s alone
			long timeout = checkOf(r) ? 600 : 300;
			return done.orTimeout(timeout, java.util.concurrent.TimeUnit.SECONDS).thenCompose(planned -> irOf(link, planned).thenApply(irJson -> {
				JsonObject doctor = DOCTOR_NEXT_PLAN;
				if (doctor != null) {
					DOCTOR_NEXT_PLAN = null; // DevBridge dev.region.planStale {at: accept}: the gate's 10(b), a newer IR at accept
					doctor.entrySet().forEach(e -> irJson.add(e.getKey(), e.getValue().deepCopy()));
				}
				// (6b, §2.4 (a)) a plan this kit can't evaluate is refused at accept: nothing is kept or requested
				String stale = staleReason(irJson);
				if (stale != null) {
					throw refusal(Reason.PLAN_STALE, stale);
				}
				// 6c 0c (C17): the claim against the owner's protected areas at accept (an area marked while it planned); 6c V: except the
				// areas the program honoured (the IR's keepOut)
				String prot = stroke ? null : protectedClaim(Sites.dimensionId(r.level()), r.owner(), new int[] {c.minX(), c.minY(), c.minZ(), c.maxX(), c.maxY(),
					c.maxZ()}, honoured(irJson));
				if (prot != null) {
					throw refusal(Reason.PROTECTED, prot);
				}
				planned.addProperty("planId", planId);
				planned.addProperty("surveySha", surveySha);
				Revisions.annotate(r, planned, irJson); // (6d RV) a candidate's revisionOf
				return new Object[] {planned, irJson, survey};
			}));
		});
	}

	static void addNote(JsonObject planned, String note) {
		JsonArray n = planned.has("notes") && planned.get("notes").isJsonArray() ? planned.getAsJsonArray("notes") : new JsonArray();
		n.add(note);
		planned.add("notes", n);
	}

	/**
	 * (6b) The volumes a program asked for ({@code region.planned.needVolumes} boxes), sampled under GENERATED_ONLY when every
	 * chunk of every box is generated (else null: prepare first), frozen to the standalone dir and uploaded:
	 * {@code [{sha, blobId, box}]} for the second {@code region.plan}. Over the per-region cell limit fails REGION_LIMIT.
	 */
	private static CompletableFuture<@Nullable JsonArray> volumesFor(ServerLevel level, JsonArray need) {
		return volumesFor(level, need, null);
	}

	/**
	 * (6c T3) {@code load}: null keeps 6b's rule (every chunk of every box generated, else null). A policy that loads (a plan check's
	 * {@code load: "generate"}) skips that test and samples each box under {@link LoadPolicy#LOAD_BOUNDED} (generating the chunks
	 * never generated) or, for a policy that never generates, {@link LoadPolicy#GENERATED_ONLY} (a chunk never generated is
	 * MISSING in the volume), bounded by the boxes' own chunks.
	 */
	static CompletableFuture<@Nullable JsonArray> volumesFor(ServerLevel level, JsonArray need, @Nullable LoadPolicy load) {
		MinecraftServer s = level.getServer();
		return onServer(s, () -> {
			long cells = 0;
			List<BoundingBox> boxes = new ArrayList<>();
			java.util.Set<BoundingBox> withBlocks = new java.util.HashSet<>();
			java.util.Set<BoundingBox> withFluids = new java.util.HashSet<>();
			for (JsonElement e : need) {
				JsonObject b = e.getAsJsonObject();
				BoundingBox bb = new BoundingBox(b.get("minX").getAsInt(), b.get("minY").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get(
					"maxY").getAsInt(), b.get("maxZ").getAsInt());
				boxes.add(bb);
				if (b.get("blocks") instanceof JsonElement bl && bl.isJsonPrimitive() && bl.getAsBoolean()) {
					withBlocks.add(bb); // (6c B) r.needVolume(box, {blocks: true}): ARVX version 2
				}
				if (b.get("fluids") instanceof JsonElement fl && fl.isJsonPrimitive() && fl.getAsBoolean()) {
					withFluids.add(bb); // (6c H) r.needVolume(box, {fluids: true}): ARVX version 3
				}
				cells += dev.larattalabs.architect.region.volume.VolumeSurvey.cells(bb);
			}
			if (cells > dev.larattalabs.architect.region.volume.VolumeSurvey.MAX_CELLS) {
				throw refusal(Reason.REGION_LIMIT, "the program's volumes are " + cells + " cells (at most "
					+ dev.larattalabs.architect.region.volume.VolumeSurvey.MAX_CELLS + " per region)");
			}
			List<CompletableFuture<Boolean>> qs = new ArrayList<>();
			int chunks = 0;
			for (BoundingBox bb : boxes) {
				for (int cx = bb.minX() >> 4; cx <= bb.maxX() >> 4; cx++) {
					for (int cz = bb.minZ() >> 4; cz <= bb.maxZ() >> 4; cz++) {
						qs.add(ChunkStatusQ.of(level, net.minecraft.world.level.ChunkPos.pack(cx, cz)).future);
						chunks++;
					}
				}
			}
			int bound = chunks + 8;
			boolean loads = load != null && load.loads();
			LoadPolicy policy = loads && load.generate() ? LoadPolicy.LOAD_BOUNDED(bound) : LoadPolicy.GENERATED_ONLY(bound);
			return CompletableFuture.allOf(qs.toArray(new CompletableFuture[0])).thenCompose(v -> {
				if (!loads && qs.stream().anyMatch(q -> !q.join())) {
					return CompletableFuture.<@Nullable JsonArray>completedFuture(null);
				}
				CompletableFuture<JsonArray> chain = CompletableFuture.completedFuture(new JsonArray());
				for (BoundingBox bb : boxes) {
					chain = chain.thenCompose(arr -> dev.larattalabs.architect.region.volume.VolumeSurvey.start(level, bb,
						policy, null, withBlocks.contains(bb), withFluids.contains(bb)).thenCompose(
							dev.larattalabs.architect.apiimpl.SurveyImpl::upload).thenApply(vol -> {
								JsonObject o = new JsonObject();
								o.addProperty("sha", vol.sha());
								o.addProperty("blobId", vol.blobId());
								JsonObject b = new JsonObject();
								b.addProperty("minX", bb.minX());
								b.addProperty("minY", bb.minY());
								b.addProperty("minZ", bb.minZ());
								b.addProperty("maxX", bb.maxX());
								b.addProperty("maxY", bb.maxY());
								b.addProperty("maxZ", bb.maxZ());
								o.add("box", b);
								arr.add(o);
								return arr;
							}));
				}
				return chain.thenApply(a -> (@Nullable JsonArray) a);
			});
		}).thenCompose(f -> f);
	}

	private static CompletableFuture<JsonObject> irOf(TileStream.Link link, JsonObject planned) {
		if (planned.has("ir") && planned.get("ir").isJsonObject()) {
			return CompletableFuture.completedFuture(planned.getAsJsonObject("ir"));
		}
		if (planned.has("ir") && planned.get("ir").isJsonPrimitive()) {
			// the sidecar sends ir.json's exact text (its sha is irSha)
			return CompletableFuture.completedFuture(JsonParser.parseString(planned.get("ir").getAsString()).getAsJsonObject());
		}
		if (planned.has("irBlobId")) {
			return BlobPut.read(planned.get("irBlobId").getAsString()).thenApply(b -> JsonParser.parseString(new String(b, StandardCharsets.UTF_8))
				.getAsJsonObject());
		}
		return CompletableFuture.failedFuture(new IllegalStateException("the plan came without its IR"));
	}

	/** Server thread: the chunks of claim + 2 chunks and which were never generated (the prepare estimate), then the plan. */
	CompletableFuture<RegionPlan> finishPlan(RegionPlanRequest r, JsonObject planned, JsonObject irJson, byte[] survey, @Nullable String opKey,
		@Nullable String opHash) {
		Ir ir = Ir.of(irJson);
		String planId = planned.get("planId").getAsString();
		List<Long> chunks = Prepare.chunksOf(ir); // (6c D3) and a reach plan's reach
		ServerLevel level = r.level();
		List<CompletableFuture<Boolean>> qs = new ArrayList<>();
		for (long ck : chunks) {
			ChunkStatusQ q = ChunkStatusQ.of(level, ck);
			qs.add(q.future);
		}
		return CompletableFuture.allOf(qs.toArray(new CompletableFuture[0])).thenCompose(v -> onServer(level.getServer(), () -> {
			int missing = 0;
			for (CompletableFuture<Boolean> q : qs) {
				missing += q.join() ? 0 : 1;
			}
			long seed = Long.parseUnsignedLong(ir.seed());
			Revisions.recordHistory(planned); // (6d RV, §3.4) a candidate's history at its dirty tiles, at the plan
			PlanRec p = new PlanRec(planId, str(planned, "programId", ir.id()), str(irJson, "programSha"), planned.get("irSha").getAsString(), planned.get(
				"surveySha").getAsString(), seed, Sites.dimensionId(level), ir.claim(), r.owner(), r.ext(), planned, ir, chunks.size(), missing, opKey, opHash);
			PLANS.put(planId, p);
			try {
				Path w = level.getServer().getWorldPath(LevelResource.ROOT);
				RegionStore.writeJson(RegionStore.plan(w, planId), planToJson(p));
				RegionStore.write(RegionStore.plan(w, planId).resolveSibling(planId + ".survey.bin"), survey);
				// (6c D3, §2.4, §4.4) a reach plan keeps its reach inputs: the held columns and standing data it was planned on, and the
				// town claim's survey (the realise re-checks the held set and drifts the reach columns against them)
				saveReach(w, planId, r, irJson);
				if (opKey != null) {
					// (6c X, C20) the key file (small, so a world start finds every key without reading the IRs)
					JsonObject k = new JsonObject();
					k.addProperty("planId", planId);
					if (r.owner() != null) {
						k.addProperty("owner", r.owner());
					}
					k.addProperty("opKey", opKey);
					k.addProperty("opHash", opHash);
					RegionStore.writeJson(RegionStore.plan(w, planId).resolveSibling(planId + ".key.json"), k);
				}
			} catch (IOException e) {
				Architect.LOGGER.warn("Region plan {} could not be saved: {}", planId, e.toString());
			}
			return view(p);
		}));
	}

	/** (6c D3) {@code <planId>.reach.json} ({held, standing, surveySha}) and {@code <planId>.reach-survey.bin}, when the IR has a reach. */
	static void saveReach(Path w, String planId, RegionPlanRequest r, JsonObject irJson) throws IOException {
		if (!(irJson.get("reach") instanceof JsonObject rc) || !(rc.get("standing") instanceof JsonElement se)) {
			return;
		}
		String town = se.getAsString();
		JsonObject in = REACH.get(r);
		if (in != null && !in.has("held") && in.get(town) instanceof JsonObject one) {
			in = one; // a plan check's map
		}
		Map<String, byte[]> sv = REACH_SURVEY.get(r);
		if (in == null || sv == null || sv.get(town) == null) {
			return;
		}
		JsonObject o = new JsonObject();
		o.addProperty("standing", town);
		o.add("held", in.get("held").deepCopy());
		o.add("standingData", in.get("standing").deepCopy());
		o.addProperty("surveySha", str(in, "surveySha"));
		// ((7a GJ, §4) a gate join through a wall region round the town: that region's inputs and survey too, kept with the plan)
		JsonObject all = REACH.get(r);
		String around = rc.get("gate") instanceof JsonObject gt ? str(gt, "region") : null;
		if (around != null && !around.equals(town) && all != null && !all.has("held") && all.get(around) instanceof JsonObject ar && sv.get(around) != null) {
			JsonObject a = new JsonObject();
			a.addProperty("standing", around);
			a.add("held", ar.get("held").deepCopy());
			a.add("standingData", ar.get("standing").deepCopy());
			a.addProperty("surveySha", str(ar, "surveySha"));
			o.add("around", a);
			RegionStore.write(RegionStore.plan(w, planId).resolveSibling(planId + ".reach-around-survey.bin"), sv.get(around));
		}
		RegionStore.writeJson(RegionStore.plan(w, planId).resolveSibling(planId + ".reach.json"), o);
		RegionStore.write(RegionStore.plan(w, planId).resolveSibling(planId + ".reach-survey.bin"), sv.get(town));
	}

	/** (6c D3) A plan's kept reach inputs ({held, standingData, surveySha, standing}), or null. */
	static @Nullable JsonObject reachOf(Path w, String planId) {
		try {
			Path f = RegionStore.plan(w, planId).resolveSibling(planId + ".reach.json");
			return java.nio.file.Files.exists(f) ? RegionStore.readJson(f) : null;
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	static RegionPlan view(PlanRec p) {
		List<LotSpec> lots = new ArrayList<>();
		JsonArray irLots = p.ir().json().get("lots") instanceof JsonArray a ? a : new JsonArray();
		int li = 0;
		for (Ir.Lot l : p.ir().lots()) {
			int[] b = l.box();
			JsonObject ext = new JsonObject();
			if (l.part() != null) {
				ext.addProperty("part", l.part());
			}
			// 6c V: the program's lot data (e.g. "architect_mc:village" = {role, type, villager, entrance, lane, water, bellDistance})
			if (li < irLots.size() && irLots.get(li) instanceof JsonObject lo && lo.get("ext") instanceof JsonObject le) {
				le.entrySet().forEach(e -> ext.add(e.getKey(), e.getValue().deepCopy()));
			}
			li++;
			lots.add(new LotSpec(l.id(), l.stage(), new BoundingBox(b[0], b[1], b[2], b[3], b[4], b[5]), l.floorY(), dir(l.front()), l.brief(), new BlockSize(
				l.max()[0], l.max()[1], l.max()[2]), ext));
		}
		Map<String, BlockPos> anchors = new LinkedHashMap<>();
		p.ir().anchors().forEach((k, v) -> anchors.put(k, new BlockPos(v[0], v[1], v[2])));
		int tiles = p.ir().tileItems().size();
		List<String> notes = new ArrayList<>();
		if (p.planned().has("notes") && p.planned().get("notes").isJsonArray()) {
			p.planned().getAsJsonArray("notes").forEach(e -> notes.add(e.isJsonPrimitive() ? e.getAsString() : e.toString()));
		}
		long[] b = p.ir().budget();
		JsonObject pl = p.planned();
		List<String> phases = PROGRESS.get(p.planId());
		if (phases != null) {
			notes.add("progress: " + String.join(", ", phases));
		}
		if (pl.has("checkMs")) {
			notes.add("checked in " + pl.get("checkMs").getAsLong() + " ms");
		}
		if (pl.has("renderMs")) {
			notes.add("previews rendered in " + pl.get("renderMs").getAsLong() + " ms");
		}
		int format = pl.has("irFormat") && pl.get("irFormat").isJsonPrimitive() ? pl.get("irFormat").getAsInt() : p.ir().format();
		return new RegionPlan(p.planId(), p.programId(), p.programSha() == null ? "" : p.programSha(), p.irSha(), p.surveySha(), p.seed(), lots,
			p.ir().stages(), anchors, new RegionBudget(b[0], b[1], b[2], tiles, p.chunks(), p.chunksToGenerate()), notes, Wire6b.report(pl.get("report")),
			Wire6b.previews(pl.get("previews"), pl.get("sitePlan")), format, Revisions.revisionOf(pl));
	}

	static Direction dir(String s) {
		Direction d = Direction.byName(s);
		return d == null || d.getAxis().isVertical() ? Direction.SOUTH : d;
	}

	private static JsonObject planToJson(PlanRec p) {
		JsonObject o = new JsonObject();
		o.addProperty("planId", p.planId());
		o.addProperty("programId", p.programId());
		o.addProperty("programSha", p.programSha());
		o.addProperty("irSha", p.irSha());
		o.addProperty("surveySha", p.surveySha());
		o.addProperty("seed", Long.toUnsignedString(p.seed()));
		o.addProperty("dimension", p.dimension());
		if (p.owner() != null) {
			o.addProperty("owner", p.owner());
		}
		o.add("ext", p.ext());
		JsonObject pl = p.planned().deepCopy();
		pl.remove("ir");
		o.add("planned", pl);
		o.add("ir", p.ir().json());
		o.addProperty("chunks", p.chunks());
		o.addProperty("chunksToGenerate", p.chunksToGenerate());
		if (p.opKey() != null) {
			o.addProperty("opKey", p.opKey());
			o.addProperty("opHash", p.opHash());
		}
		return o;
	}

	private static PlanRec planFromJson(JsonObject o) {
		Ir ir = Ir.of(o.getAsJsonObject("ir"));
		return new PlanRec(o.get("planId").getAsString(), str(o, "programId"), str(o, "programSha"), o.get("irSha").getAsString(), str(o, "surveySha"),
			Long.parseUnsignedLong(o.get("seed").getAsString()), o.get("dimension").getAsString(), ir.claim(), o.has("owner") ? o.get("owner").getAsString()
				: null, o.has("ext") ? o.getAsJsonObject("ext") : new JsonObject(), o.getAsJsonObject("planned"), ir, o.get("chunks").getAsInt(), o.get(
					"chunksToGenerate").getAsInt(), o.has("opKey") ? o.get("opKey").getAsString() : null, o.has("opHash") ? o.get("opHash").getAsString() : null);
	}

	// ------------------------------------------------------------------ 6b: PLAN_STALE, kit versions, blobs, progress

	/** The helper's kit and IR versions ({@code hello} snapshot), or null when unknown. */
	static IrStale.@Nullable Hello hello() {
		return IrStale.Hello.of(dev.larattalabs.architect.apiimpl.RegionBridge.versions());
	}

	/** PLAN_STALE for a raw IR against the mod's constants and the helper's hello, or null. */
	public static @Nullable String staleReason(@Nullable JsonObject irJson) {
		return IrStale.reason(irJson, hello());
	}

	/** (6b, §2.4 (c)) Why a region may not be evaluated (its IR is stale), or null. Cheap: called per item start. */
	public static @Nullable String staleOf(Live l) {
		return staleReason(l.ir().json());
	}

	/** The dev-only log line when the helper's kit differs from the bundled one (once per difference). */
	static void warnKitMismatch() {
		String w = IrStale.versionWarning(hello());
		if (w != null && !w.equals(lastKitWarning)) {
			lastKitWarning = w;
			if (net.fabricmc.loader.api.FabricLoader.getInstance().isDevelopmentEnvironment()) {
				Architect.LOGGER.warn("Regions: {} (dev: a sidecar from another checkout?)", w);
			} else {
				Architect.LOGGER.debug("Regions: {}", w);
			}
		}
	}

	/** A region's side blob copies, by sha ({@code blob_unknown} re-sends read them). Off the server thread. */
	public static TileStream.BlobSource blobSource(Live l) {
		Path dir = RegionBlobs.dir(l.world(), l.rec().id);
		return sha -> {
			try {
				Path f = dir.resolve(sha + ".bin");
				return Files.isRegularFile(f) ? Files.readAllBytes(f) : null;
			} catch (IOException e) {
				return null;
			}
		};
	}

	/** A plan entered a phase (S-6b-5): kept for its notes and fired as REGION_PLAN_PROGRESS. Server thread. */
	static void progress(MinecraftServer s, @Nullable String planId, String phase) {
		if (planId != null) {
			PROGRESS.computeIfAbsent(planId, k -> java.util.Collections.synchronizedList(new ArrayList<>())).add(phase);
		}
		Runnable fire = () -> SiteEvents.REGION_PLAN_PROGRESS.invoker().onPhase(planId, phase);
		if (s.isSameThread()) {
			fire.run();
		} else {
			s.execute(fire);
		}
	}

	/** The phases a plan went through (DevBridge). */
	public static List<String> progressOf(String planId) {
		List<String> l = PROGRESS.get(planId);
		return l == null ? List.of() : List.copyOf(l);
	}

	// ------------------------------------------------------------------ messages from the sidecar (the link's thread)

	public static void onMessage(JsonObject m) {
		String type = m.has("type") ? m.get("type").getAsString() : "";
		switch (type) {
			case "region.planned" -> {
				String id = m.get("planId").getAsString();
				PLANNING.computeIfAbsent(id, k -> new CompletableFuture<>()).complete(m);
				PLANNING.remove(id);
			}
			case "region.failed" -> {
				String id = m.get("planId").getAsString();
				PLANNING.computeIfAbsent(id, k -> new CompletableFuture<>()).completeExceptionally(new IllegalStateException(str(m, "message")));
				PLANNING.remove(id);
			}
			case "region.tile", "region.tile.error" -> TileStream.onMessage(m);
			case "region.progress" -> {
				// (6b, S-6b-5) {planId, phase: planning|checking|rendering}
				String id = str(m, "planId", null);
				String phase = str(m, "phase", "?");
				MinecraftServer srv = id == null ? server : PLAN_SERVER.getOrDefault(id, server);
				if (srv != null) {
					srv.execute(() -> progress(srv, id, phase));
				}
			}
			default -> {
			}
		}
	}

	// ------------------------------------------------------------------ prepare

	@Override
	public CompletableFuture<PrepareView> prepare(PrepareRequest r) {
		PlanRec p = planRec(r.planId());
		if (p == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no region plan " + r.planId()));
		}
		MinecraftServer s = server;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		return Prepare.start(s, p, r.inFlight());
	}

	@Override
	public void cancelPrepare(String regionOrPlanId) {
		Live l = REGIONS.get(regionOrPlanId);
		Prepare.cancel(l != null ? l.rec().planId : regionOrPlanId);
	}

	@Override
	public Optional<PrepareView> prepareState(String planId) {
		return Optional.ofNullable(Prepare.view(planId));
	}

	// ------------------------------------------------------------------ realise

	@Override
	public CompletableFuture<String> realise(RealiseRequest r) {
		MinecraftServer s = server;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		// (6c X, C20) an operation key, scoped by the plan's owner: the same key and body returns the existing realise's region id
		// (also while it starts); another body refuses OP_KEY_CONFLICT. A region found by key is final or running: nothing is queued.
		String key;
		try {
			key = dev.larattalabs.architect.apiimpl.Wire0a.opKey(r.opKey());
		} catch (IllegalArgumentException e) {
			return CompletableFuture.failedFuture(e);
		}
		PlanRetention.touch(r.planId()); // (6c close-out A) a realise attempt is a use of its plan
		if (key == null) {
			return realise0(s, r);
		}
		return onServer(s, () -> {
			PlanRec p = planRec(r.planId());
			String owner = p == null ? null : p.owner();
			String hash = RegionKeys.hash(RegionKeys.realiseBody(r));
			String scope = RegionKeys.scope(owner, "region.realise", key);
			Live live = regionByKey(owner, key);
			KeyedRealise kr = REALISE_KEYS.get(scope);
			// (6d GR, S-GR-3) a revision realised under the key: the same plan answers its region again; another plan conflicts
			Object[] rvk = live == null && kr == null ? revisionByKey(owner, key) : null;
			if (rvk != null) {
				Revisions.Rev rv = (Revisions.Rev) rvk[1];
				if (rv.planId.equals(r.planId())) {
					Architect.LOGGER.info("Region {}: revision {}'s realise adopted by opKey {}", ((Live) rvk[0]).rec().id, rv.rid, key);
					return CompletableFuture.completedFuture(((Live) rvk[0]).rec().id);
				}
				throw conflict(key, owner, ((Live) rvk[0]).rec().id);
			}
			switch (keyOutcome(live == null ? null : live.rec().opHash, kr == null ? null : kr.hash(), hash)) {
				case CONFLICT -> throw conflict(key, owner, live == null ? null : live.rec().id);
				case ADOPT_REGION -> {
					Architect.LOGGER.info("Region {}: realise adopted by opKey {} ({})", live.rec().id, key, live.rec().state.name().toLowerCase(java.util.Locale.ROOT));
					return CompletableFuture.completedFuture(live.rec().id);
				}
				case ADOPT_STARTING -> {
					Architect.LOGGER.info("Realise adopted by opKey {} (still starting)", key);
					return kr.future();
				}
				case NEW -> {
				}
			}
			CompletableFuture<String> mine = new CompletableFuture<>();
			REALISE_KEYS.put(scope, new KeyedRealise(hash, mine));
			realise0(s, r).whenComplete((id, e) -> onServer(s, () -> {
				REALISE_KEYS.remove(scope);
				if (e != null) {
					mine.completeExceptionally(e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e);
				} else if (holdNextRealise) {
					holdNextRealise = false; // DevBridge: the region record is saved, the caller's future never completes (it fails at a stop)
				} else {
					PlanChecks.keyRealised(id); // (6c close-out A, §2) the key's region record is written: its keyed pins end
					mine.complete(id);
				}
				return null;
			}));
			return mine;
		}).thenCompose(f -> f);
	}

	/** (6c close-out A, §1) What a keyed realise does with its key. */
	enum KeyOutcome { NEW, ADOPT_REGION, ADOPT_STARTING, CONFLICT }

	/**
	 * (6c close-out A, §1 and its §14 amendment) The realise key rule, pure: {@code standingHash} is the body hash of the standing region
	 * realised under the key (null when none: never realised, refused before its record, or REMOVED, as since C20), {@code startingHash}
	 * the one still starting under it (null when none). The same body adopts, another conflicts, and no holder starts afresh.
	 */
	static KeyOutcome keyOutcome(@Nullable String standingHash, @Nullable String startingHash, String hash) {
		if (standingHash != null) {
			return standingHash.equals(hash) ? KeyOutcome.ADOPT_REGION : KeyOutcome.CONFLICT;
		}
		if (startingHash != null) {
			return startingHash.equals(hash) ? KeyOutcome.ADOPT_STARTING : KeyOutcome.CONFLICT;
		}
		return KeyOutcome.NEW;
	}

	/** (6c X) Hold the next keyed realise's future after its region record is saved (the gate's item 3). */
	public static void holdNextRealise(boolean on) {
		holdNextRealise = on;
	}

	private static dev.larattalabs.architect.api.ArchitectRefused conflict(String key, @Nullable String owner, @Nullable String regionId) {
		return new dev.larattalabs.architect.api.ArchitectRefused(Reason.OP_KEY_CONFLICT, "opKey \"" + key + "\" (region.realise" + (owner == null ? ""
			: ", " + owner) + ") was used for another realise" + (regionId != null ? " (" + regionId + ")" : ""));
	}

	private CompletableFuture<String> realise0(MinecraftServer s, RealiseRequest r) {
		String[] id = {null};
		return onServer(s, () -> {
			PlanRec p = planRec(r.planId());
			ServerLevel level = p == null ? null : Sites.levelOf(s, p.dimension());
			if (p == null || level == null) {
				return CompletableFuture.<Drift.@Nullable Result>completedFuture(null);
			}
			// (6b, §2.4 (b)) refused before anything is checked, copied or requested
			String stale = staleReason(p.ir().json());
			if (stale != null) {
				throw refusal(Reason.PLAN_STALE, stale);
			}
			if (Revisions.isRevision(p)) {
				// (6d RV) a revision's blobs go into its region's dir; no new region, and the dirty tiles' history replaces the drift check
				id[0] = p.planned().getAsJsonObject("revisionOf").get("region").getAsString();
				return CompletableFuture.<Drift.@Nullable Result>completedFuture(null);
			}
			id[0] = "rg" + nextRegion++; // reserved now: the blob copies go into its dir before the record exists
			return Drift.check(level, p);
		}).thenCompose(f -> f).thenComposeAsync(drift -> { // off the server thread: the copies are file I/O
			PlanRec p = id[0] == null ? null : PLANS.get(r.planId());
			if (p != null && !RegionBlobs.volumeShas(p.ir().json()).isEmpty()) {
				List<String> miss = RegionBlobs.installVolumes(s.getWorldPath(LevelResource.ROOT), id[0], RegionBlobs.volumeShas(p.ir().json()));
				if (!miss.isEmpty()) {
					Architect.LOGGER.info("Region {}: frozen volumes {} not in the standalone dir (their side blobs carry them)", id[0], miss);
				}
			}
			if (p == null || p.ir().blobShas().isEmpty()) {
				return CompletableFuture.completedFuture(new Object[] {drift, null});
			}
			// (6b, §2.2) every side blob into <world>/architect-regions/<id>/blobs (off the server thread), before the record
			Path dir = RegionBlobs.dir(s.getWorldPath(LevelResource.ROOT), id[0]);
			return RegionBlobs.install(dir, p.ir().blobShas(), RegionBlobs.blobIds(p.planned()), BlobPut::read).thenApply(err -> new Object[] {drift, err});
		}).thenCompose(o -> onServer(s, () -> {
			try {
				return realise0(s, r, (Drift.Result) o[0], id[0], (String) o[1]);
			} catch (RuntimeException e) {
				if (id[0] != null && REGIONS.get(id[0]) == null) {
					// refused before the record: the copies made for it go (the reserved id stays unused)
					Path w = s.getWorldPath(LevelResource.ROOT);
					RegionBlobs.delete(RegionBlobs.dir(w, id[0]));
					RegionBlobs.delete(RegionStore.region(w, id[0]).resolve("volumes"));
				}
				throw e;
			}
		}));
	}

	private String realise0(MinecraftServer s, RealiseRequest r, Drift.@Nullable Result drift, @Nullable String reserved, @Nullable String blobError) {
		PlanRec p = planRec(r.planId());
		// (6d RV) a revision candidate: accepted onto its region (Revisions.realise), never a region of its own
		if (p != null && Revisions.isRevision(p)) {
			if (blobError != null) {
				throw refusal(Reason.OTHER, blobError);
			}
			return Revisions.realise(s, r, p);
		}
		if (p == null && PlanRetention.discarded(r.planId())) {
			throw new RegionException(Reason.PLAN_STALE, "region plan " + r.planId() + " was discarded", PlanRetention.DISCARDED);
		}
		if (p == null) {
			throw refusal(Reason.OTHER, "no region plan " + r.planId());
		}
		String stale = staleReason(p.ir().json());
		if (stale != null) {
			throw refusal(Reason.PLAN_STALE, stale);
		}
		// (6c RS, §3) the mode is the world's: survival when the toggle is on and the default game type isn't creative
		boolean survival = RegionSurvival.on(s);
		if (r.mode() == Mode.CONSTRUCTION && !survival) {
			throw refusal(Reason.NOT_ALLOWED, "a region builds in the world's mode: CONSTRUCTION needs a survival world (the toggle on, not creative)");
		}
		if (survival != RegionSurvival.planned(p.ir().json())) {
			throw refusal(Reason.NOT_ALLOWED, survival ? "this plan was made in creative: plan it again in survival (this world builds from a stockpile)"
				: "this plan was made in survival: plan it again in creative");
		}
		if (survival) {
			survivalRefusal(s, p, r);
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			throw refusal(Reason.JOURNAL_UNAVAILABLE, why);
		}
		ServerLevel level = Sites.levelOf(s, p.dimension());
		if (level == null) {
			throw refusal(Reason.NOT_LOADED, p.dimension() + " is not loaded");
		}
		if (blobError != null) {
			throw refusal(Reason.OTHER, blobError); // (6b) "blob <sha> missing": before any write
		}
		Ir ir = p.ir();
		// 6c 0c (C17): an area marked after planning refuses the realise (no per-tile check); 6c V: the areas the program honoured
		// (the IR's keepOut, the exact rects it was planned around) don't
		// (6c B) a brush stroke: its owner's areas against the brush box (the claim's survey margin is never written)
		JsonObject stroke = Brushes.strokeOf(p.planId());
		String prot = stroke != null ? protectedClaim(p.dimension(), p.owner(), Brushes.box(stroke)) : protectedClaim(p.dimension(), p.owner(), ir.claim(),
			honoured(ir.json()));
		if (prot != null) {
			throw refusal(Reason.PROTECTED, prot);
		}
		// (6c D3, §2.3, §4.4) a reach plan, re-checked once before any write: its town stands (not in flight), the held set over its reach
		// as planned, its reach columns clear of the owner's areas and of other owners' regions
		if (stroke == null && ir.json().get("reach") instanceof JsonObject reach) {
			String[] rw = reachRecheck(p, reach);
			if (rw != null) {
				throw refusal(Reason.valueOf(rw[0]), rw[1]);
			}
		}
		// another owner's standing region over the claim
		for (Live l : REGIONS.values()) {
			if (l.rec().state != RegionState.REMOVING && overlaps(l.rec().claim, ir.claim()) && !java.util.Objects.equals(l.rec().owner, p.owner())
				&& !r.force()) {
				throw refusal(Reason.OVERLAP_OWNED, "the claim overlaps region " + l.rec().id + " of " + (l.rec().owner == null ? "the player"
					: l.rec().owner));
			}
		}
		if (drift == null) {
			drift = new Drift.Result(true, "not checked", 0, 0, 0);
		}
		if (!drift.ok() && !r.force()) {
			throw refusal(Reason.DRIFTED, "land changed since planning: " + drift.message() + "; replan, or realise with force");
		}
		String id = reserved != null ? reserved : "rg" + nextRegion++;
		Path w = s.getWorldPath(LevelResource.ROOT);
		RegionRec rec = new RegionRec(id, p.planId(), p.irSha(), p.owner(), r.ext(), p.dimension(), ir.claim(), System.currentTimeMillis());
		if (survival) {
			JsonObject sv = new JsonObject();
			sv.addProperty("on", true);
			rec.survival = sv; // (6c RS) its tiles put targets down, its lots and roads are construction items
		}
		// (6c D1) planned beside a standing region: the record names it (the join is this region's; a dangling end is noted on removal)
		if (ir.json().get("beside") instanceof JsonObject bs && bs.get("id") instanceof JsonElement bid && bid.isJsonPrimitive()) {
			rec.beside = bid.getAsString();
			JsonObject note = new JsonObject();
			note.addProperty("region", rec.beside);
			note.addProperty("dangling", REGIONS.get(rec.beside) == null);
			rec.ext.add(EXT_BESIDE, note);
		}
		// (6c D2) an outpost's corridor: the settlement land its road crosses (row runs [x0, z, x1, z] per outpost district and their
		// bounding rect), this region's: undone with it
		if (ir.json().get("corridor") instanceof JsonObject cor && !cor.isEmpty()) {
			JsonObject o = new JsonObject();
			for (var en : cor.entrySet()) {
				int x0 = Integer.MAX_VALUE, z0 = Integer.MAX_VALUE, x1 = Integer.MIN_VALUE, z1 = Integer.MIN_VALUE;
				long cells = 0;
				for (JsonElement run : en.getValue().getAsJsonArray()) {
					JsonArray q = run.getAsJsonArray();
					x0 = Math.min(x0, q.get(0).getAsInt());
					z0 = Math.min(z0, q.get(1).getAsInt());
					x1 = Math.max(x1, q.get(2).getAsInt());
					z1 = Math.max(z1, q.get(3).getAsInt());
					cells += q.get(2).getAsInt() - q.get(0).getAsInt() + 1;
				}
				JsonObject one = new JsonObject();
				one.add("runs", en.getValue().deepCopy());
				one.addProperty("cells", cells);
				JsonArray b = new JsonArray();
				b.add(x0);
				b.add(z0);
				b.add(x1);
				b.add(z1);
				one.add("rect", b);
				o.add(en.getKey(), one);
			}
			rec.ext.add(EXT_CORRIDOR, o);
		}
		// (6c D3, D-S3, §6) every districts region: the land it takes (architect_mc:land), from its IR
		int[] townClaim = null;
		if (rec.beside != null && REGIONS.get(rec.beside) instanceof Live tl) {
			int[] tc = tl.rec().claim;
			townClaim = new int[] {tc[0], tc[2], tc[3], tc[5]};
		}
		JsonObject land = DistrictLand.of(ir.json(), townClaim, null);
		if (land != null) {
			rec.ext.add(DistrictLand.EXT_LAND, land);
		}
		if (stroke != null) {
			rec.brush = stroke.deepCopy(); // (6c B) the stroke's kind and destruction rule, read by every tile check
		}
		// (6c PT §6) the consent, checked once: the builds named whose actor placed at least 10% or holds permission level 2; (a stroke's
		// was checked at the stroke: only a PLAYER_BLOCKS stroke's counts, Brushes)
		rec.consented.addAll(stroke != null ? Brushes.consented(stroke) : dev.larattalabs.architect.placed.BuildViews.consent(s, r.consent(), false)
			.allowed());
		if (r.opKey() != null) {
			rec.opKey = r.opKey();
			rec.opHash = RegionKeys.hash(RegionKeys.realiseBody(r));
		}
		List<String> stages = r.stages() == null ? ir.stages() : r.stages().stream().filter(ir.stages()::contains).toList();
		List<QItem> items = new ArrayList<>();
		// (6c D3, §3.4) the hold: every town-held cell of the reach's contact columns journaled as this region's (before = after, the block
		// standing), one cell site item first in the batch, so the town's undo never writes a join column
		QItem hold = ir.json().get("reach") instanceof JsonObject rh ? holdItem(level, rec, rh, stages.isEmpty() ? null : stages.get(0)) : null;
		if (hold != null) {
			items.add(hold);
		}
		int maxNeed = 36;
		Map<String, List<String>> tilesOfStage = new HashMap<>();
		for (String st : stages) {
			RegionRec.Stage sp = new RegionRec.Stage();
			rec.stages.put(st, sp);
			List<String> terrainKeys = new ArrayList<>();
			for (String key : ir.terrainTiles().getOrDefault(st, List.of())) {
				items.add(tileItem(rec, p, st, "terrain", key, List.of()));
				terrainKeys.add(key);
				sp.tilesTotal++;
			}
			List<String> pathKeys = new ArrayList<>();
			for (String key : ir.pathTiles().getOrDefault(st, List.of())) {
				// a path tile LAYERs over the same stage's terrain tiles around it
				List<String> after = new ArrayList<>();
				int[] k = Ir.tile(key);
				for (String tk : terrainKeys) {
					int[] t = Ir.tile(tk);
					if (Math.abs(t[0] - k[0]) <= 1 && Math.abs(t[1] - k[1]) <= 1) {
						after.add(tileKey(st, "terrain", tk));
					}
				}
				items.add(tileItem(rec, p, st, "path", key, after));
				pathKeys.add(key);
				sp.tilesTotal++;
			}
			List<String> roadKeys = new ArrayList<>();
			for (Ir.Road road : ir.roads()) {
				if (!road.stage().equals(st)) {
					continue;
				}
				items.add(roadItem(level, rec, road, deps(st, terrainKeys, pathKeys, roadBox(road))));
				roadKeys.add("road:" + road.id());
			}
			for (Ir.Lot lot : ir.lots()) {
				if (!lot.stage().equals(st)) {
					continue;
				}
				RegionRec.Lot ls = new RegionRec.Lot();
				ls.stage = st;
				rec.lots.put(lot.id(), ls);
				String entry = r.lotEntries().get(lot.id());
				if (entry == null) {
					continue; // a pad
				}
				ls.entry = entry;
				List<String> after = deps(st, terrainKeys, pathKeys, grow(lot.box(), 8));
				after.addAll(roadKeys);
				QItem li = lotItem(level, rec, ir, lot, entry, after, r);
				if (li != null) {
					items.add(li);
					ls.state = li.status == QItem.Status.FAILED ? "failed:" + li.reason : "queued";
					Blueprint bp = Blueprints.get(li.blueprint);
					if (bp != null) {
						maxNeed = Math.max(maxNeed, dev.larattalabs.architect.site.RegionQueue.itemChunks(li, bp));
					}
				}
			}
			tilesOfStage.put(st, terrainKeys);
		}
		// the writer, the next tile (its tickets taken while the last one's P7 commits) and two freezes ahead fit together
		LoadPolicy load = r.load() != null ? r.load() : LoadPolicy.GENERATED_ONLY(Math.max(64, maxNeed + 2 * 36));
		rec.maxChunks = load.maxChunks();
		rec.generate = load.generate();
		rec.stats.addProperty("drift", drift.message());
		if (r.maxWaitSeconds() > 0) {
			rec.stats.addProperty("maxWaitSeconds", r.maxWaitSeconds());
		}
		rec.stats.addProperty("realiseStartedAt", System.currentTimeMillis());
		rec.stats.addProperty("genTerrainAtStart", GenCounter.terrain());
		try {
			Path dir = RegionStore.region(w, id);
			Files.createDirectories(dir.resolve("heights"));
			RegionStore.writeJson(dir.resolve("ir.json"), ir.json());
		} catch (IOException e) {
			throw refusal(Reason.OTHER, "the region could not be saved: " + e.getMessage());
		}
		Live live = new Live(rec, ir, w);
		REGIONS.put(id, live);
		QBatch b = Batches.queueRegion(s, id, p.owner(), r.ext(), items, stages, load.maxChunks(), load.generate(), r.autoApprove(), r.maxWaitSeconds());
		rec.groupId = b.group;
		rec.batchId = b.id;
		rec.state = RegionState.PLACING;
		save(live);
		WorldJournal.kill("RG2"); // the region record is written, no tile started
		SiteEvents.REGION_STATE.invoker().onState(view(live));
		Architect.LOGGER.info("Region {} realising plan {} ({} items, {} stages, load {} chunks{})", id, p.planId(), items.size(), stages.size(),
			load.maxChunks(), load.generate() ? "" : ", generated only");
		return id;
	}

	/**
	 * (6c RS, §3, §4.2) A survival realise's refusals, before anything is written: a creative-only block in the plan (CREATIVE_ONLY_BLOCK,
	 * naming the parts), a plan that builds anything with no stockpile of its owner in its dimension (NOT_ALLOWED, with the bill).
	 */
	private static void survivalRefusal(MinecraftServer s, PlanRec p, RealiseRequest r) {
		JsonObject ir = p.ir().json();
		var co = RegionSurvival.creativeOnly(ir);
		if (!co.isEmpty()) {
			List<String> parts = new ArrayList<>();
			co.forEach((g, b) -> parts.add(g + " (" + String.join(", ", b.keySet()) + ")"));
			throw refusal(Reason.CREATIVE_ONLY_BLOCK, "a survival world can't build a creative-only block: part" + (parts.size() == 1 ? " " : "s ") + String
				.join("; ", parts));
		}
		boolean lots = r.lotEntries() != null && !r.lotEntries().isEmpty();
		if (!RegionSurvival.buildsFromStock(ir, lots)) {
			return; // all of it is free: no stockpile needed
		}
		String dimWhy = dev.larattalabs.architect.site.Stockpiles.dimensionRefusal(p.owner(), p.dimension());
		if (dimWhy != null) {
			throw refusal(Reason.NOT_ALLOWED, "a survival region builds from its owner's stockpile, and " + dimWhy);
		}
		if (!dev.larattalabs.architect.site.Stockpiles.drawsFrom(p.owner(), p.dimension())) {
			JsonElement bom = p.planned().get("planCheck") instanceof JsonObject pc && pc.get("cost") instanceof JsonObject c ? c.get("bom") : null;
			long[] cells = RegionSurvival.cells(ir);
			throw refusal(Reason.NOT_ALLOWED, (p.owner() == null ? "the player" : p.owner()) + " has no stockpile in " + p.dimension() + ": a survival region builds "
				+ "from its owner's stockpile (create one first); the bill: " + (bom != null && bom.isJsonObject() ? bom.toString() : cells[2] + " paid cells")
				+ (lots ? ", and its lots' designs" : ""));
		}
	}

	/**
	 * (6c D3, §2.3, §4.4) A reach plan's re-check at realise (once, before any write): {reason, message} or null. The town stands and is
	 * not in flight (Steward's finding: PLACED, PARTIAL and FAILED are beside towns); every reach column outside the contact columns is
	 * unheld (a site placed on the join's path, a player's build), a contact column held only by the town's terrain and held by the plan;
	 * no reach column in the owner's protected areas or in another owner's region.
	 */
	static String @Nullable [] reachRecheck(PlanRec p, JsonObject reach) {
		String town = str(reach, "standing");
		Live st = town == null ? null : REGIONS.get(town);
		if (st == null || st.rec().state == RegionState.REMOVED) {
			return new String[] {"OTHER", "beside: region " + town + " was removed; re-plan"};
		}
		String busy = besideBusy(st);
		if (busy != null) {
			return new String[] {"OVERLAP_BUSY", "beside: region " + town + " is " + busy};
		}
		// ((7a GJ, §7) a gate join: the gate still stands as planned (held by its wall's region with the blocks it wrote, its opening clear))
		if (reach.get("gate") instanceof JsonObject gate) {
			MinecraftServer sv = server();
			ServerLevel gl = sv == null ? null : Sites.levelOf(sv, p.dimension());
			String[] gw = gl == null ? new String[] {"ARTIFACT_STALE", "gate " + str(gate, "id") + ": its dimension is not loaded; re-plan"} : GateJoin.recheck(p
				.dimension(), gl, gate);
			if (gw != null) {
				return gw;
			}
		}
		BesideReach.Cols cols = BesideReach.colsOf(reach.getAsJsonArray("runs"));
		BesideReach.Cols contact = BesideReach.colsOf(reach.get("contact") instanceof JsonArray ca ? ca : new JsonArray());
		BesideReach.Cols hold = BesideReach.colsOf(reach.get("hold") instanceof JsonArray ha ? ha : new JsonArray());
		int[] rect = cols.rect();
		if (rect == null) {
			return null;
		}
		// the owner's protected areas and other owners' regions over the reach
		for (JsonElement e : reach.getAsJsonArray("runs")) {
			JsonArray q = e.getAsJsonArray();
			int[] box = {q.get(0).getAsInt(), -2048, q.get(1).getAsInt(), q.get(2).getAsInt(), 2047, q.get(3).getAsInt()};
			String prot = protectedClaim(p.dimension(), p.owner(), box);
			if (prot != null) {
				return new String[] {"PROTECTED", prot + " (the join's reach at " + box[0] + ".." + box[3] + ", " + box[2] + ")"};
			}
			for (Live l : REGIONS.values()) {
				if (l.rec().state != RegionState.REMOVING && l.rec().state != RegionState.REMOVED && overlaps(l.rec().claim, box) && !java.util.Objects.equals(l
					.rec().owner, p.owner())) {
					return new String[] {"OVERLAP_OWNED", "the join's reach at " + box[0] + ".." + box[3] + ", " + box[2] + " lies in region " + l.rec().id + " of "
						+ (l.rec().owner == null ? "the player" : l.rec().owner)};
				}
			}
		}
		// the held set over the reach: as planned
		BesideReach.Held h;
		try {
			h = BesideReach.scan(p.dimension(), rect, st.rec().groupId, BesideReach.propsStages(Revisions.effective(st)), null);
		} catch (IOException e) {
			return new String[] {"JOURNAL_UNAVAILABLE", "the held columns over the join's reach could not be read (" + e.getMessage() + ")"};
		}
		String[] bad = {null};
		cols.forEach((x, z) -> {
			if (bad[0] != null) {
				return;
			}
			int c = h.at(x, z);
			boolean ok = c == 0 ? !hold.has(x, z) || !contact.has(x, z) : contact.has(x, z) && c == 2 && hold.has(x, z);
			if (c == 0 && hold.has(x, z)) {
				ok = true; // a hold column the town no longer holds (its terrain undone by hand): nothing to hold, nothing written
			}
			if (!ok) {
				String site = h.siteAt(x, z);
				bad[0] = "the join's reach column " + x + ", " + z + " is held since the plan" + (site == null ? "" : " by " + Sites.describe(site))
					+ (contact.has(x, z) ? " (a contact column held by more than the town's terrain)" : "") + "; re-plan";
			}
		});
		// a contact column the town's terrain holds now that the plan did not hold
		contact.forEach((x, z) -> {
			if (bad[0] == null && h.at(x, z) == 2 && !hold.has(x, z)) {
				bad[0] = "the contact column " + x + ", " + z + " is held by region " + town + "'s terrain since the plan; re-plan";
			}
		});
		return bad[0] == null ? null : new String[] {"OVERLAP", bad[0]};
	}

	/**
	 * (6c D3, §3.4) The hold item of a reach plan: a cell site (architect:hold, CELL, LAYER) of every cell the town's active entries hold in
	 * the reach's hold columns, each written as the block the journal says stands there (its top town cell's after): before = after, nothing
	 * changes in the world, and the cell is this region's, on top. Null when no town cell stands in them.
	 */
	@Nullable QItem holdItem(ServerLevel level, RegionRec rec, JsonObject reach, @Nullable String stage) {
		String town = str(reach, "standing");
		Live st = town == null ? null : REGIONS.get(town);
		if (st == null || !(reach.get("hold") instanceof JsonArray ha) || ha.isEmpty() || stage == null) {
			return null;
		}
		BesideReach.Cols hold = BesideReach.colsOf(ha);
		java.util.TreeMap<Long, net.minecraft.world.level.block.state.BlockState> cells = new java.util.TreeMap<>();
		try {
			BesideReach.townCells(Sites.dimensionId(level), hold, st.rec().groupId, cells);
		} catch (IOException e) {
			throw refusal(Reason.JOURNAL_UNAVAILABLE, "the hold cells could not be read (" + e.getMessage() + ")");
		}
		if (cells.isEmpty()) {
			return null;
		}
		List<dev.larattalabs.architect.api.CellWrite> ws = new ArrayList<>();
		cells.forEach((pos, state) -> ws.add(new dev.larattalabs.architect.api.CellWrite(BlockPos.of(pos), state, null)));
		return dev.larattalabs.architect.site.RegionQueue.holdItem(level, rec.id, "hold:reach", stage, ws, rec.owner);
	}

	static String tileKey(String stage, String set, String key) {
		return "t:" + stage + ":" + set + ":" + key;
	}

	private static QItem tileItem(RegionRec rec, PlanRec p, String stage, String set, String key, List<String> after) {
		return tileItemOf(rec, p.ir().json(), p.ir(), stage, set, key, after);
	}

	/** A tile item; (6d RV) a revision's with its journal stage ({@code rv<rid>:<s>}) and its own IR (whose stage is the plain name). */
	static QItem tileItemOf(RegionRec rec, JsonObject irJson, Ir ir, String stage, String set, String key, List<String> after) {
		int[] t = Ir.tile(key);
		JsonObject ext = new JsonObject();
		ext.addProperty(RegionItems.EXT_TILE, stage + "|" + set + "|" + key);
		dev.larattalabs.architect.site.RegionWaitTags.tagTile(ext, rec.id, ir, Revisions.plainStage(stage), set, key); // (6c close-out A, §8) its region and parts
		// (6c RS, §5) the flags from the region's mode (the latent bug: queued creative-only, a toggle switched on failed them)
		QItem q = new QItem(tileKey(stage, set, key), stage, after, "tile", rec.dimension, Heights.TILE * t[0], rec.claim[1], Heights.TILE * t[1], 0, false,
			ext, null, rec.survival(), dev.larattalabs.architect.survival.SurvivalWorld.on());
		q.itemKind = "tile";
		q.layer = true;
		JsonObject sp = new JsonObject();
		sp.addProperty("region", rec.id);
		sp.addProperty("stage", stage);
		sp.addProperty("set", set);
		sp.addProperty("tile", key);
		q.spec = sp;
		return q;
	}

	private static int[] roadBox(Ir.Road r) {
		int[] b = {Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MAX_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE, Integer.MIN_VALUE};
		for (int[] pt : r.points()) {
			b[0] = Math.min(b[0], pt[0]);
			b[1] = Math.min(b[1], pt[1]);
			b[2] = Math.min(b[2], pt[2]);
			b[3] = Math.max(b[3], pt[0]);
			b[4] = Math.max(b[4], pt[1]);
			b[5] = Math.max(b[5], pt[2]);
		}
		return grow(b, 12);
	}

	private static int[] grow(int[] b, int n) {
		return new int[] {b[0] - n, b[1] - n, b[2] - n, b[3] + n, b[4] + n, b[5] + n};
	}

	/** The same stage's tiles under a box: items placed before it. */
	private static List<String> deps(String st, List<String> terrain, List<String> path, int[] box) {
		List<String> out = new ArrayList<>();
		for (String k : terrain) {
			if (tileTouches(k, box)) {
				out.add(tileKey(st, "terrain", k));
			}
		}
		for (String k : path) {
			if (tileTouches(k, box)) {
				out.add(tileKey(st, "path", k));
			}
		}
		return out;
	}

	private static boolean tileTouches(String key, int[] b) {
		int[] t = Ir.tile(key);
		int x0 = Heights.TILE * t[0];
		int z0 = Heights.TILE * t[1];
		return x0 <= b[3] && b[0] <= x0 + Heights.TILE - 1 && z0 <= b[5] && b[2] <= z0 + Heights.TILE - 1;
	}

	/** 6c W (DevBridge dev.region.survey): the plan survey a region plan of this claim would send (resolution 1 up to 256x256, else 4). */
	public static CompletableFuture<Columns> planSurvey(ServerLevel level, int x0, int z0, int x1, int z1, LoadPolicy load) {
		return RegionSurvey.planSurvey(level, x0, z0, x1, z1, load);
	}

	/** (6c FL, S-FL-5) The road ext key of a plan region's street: {@code {zone, district?}}. */
	public static final String STREET_EXT = "architect_mc:street";

	static QItem roadItem(ServerLevel level, RegionRec rec, Ir.Road road, List<String> after) {
		List<BlockPos> pts = new ArrayList<>();
		road.points().forEach(pt -> pts.add(new BlockPos(pt[0], pt[1], pt[2])));
		// (6c RS, §5) a survival region's 4e road is a construction road (C16) from the owner's stockpile
		var rr = new dev.larattalabs.architect.api.RoadRequest(level, pts, road.width(), road.surface(), null, road.lanterns(), false, rec.survival() ? Mode.CONSTRUCTION
			: Mode.INSTANT, rec.owner, new JsonObject(), null, true);
		QItem q = dev.larattalabs.architect.site.RegionQueue.roadItem(level, rec.id, "road:" + road.id(), road.stage(), after, rr, rec.survival(),
			dev.larattalabs.architect.survival.SurvivalWorld.on());
		if (road.lamp() != null) {
			q.spec.add("lamp", road.lamp().deepCopy()); // 6c W: the bible's lamp fixture for the street's lanterns
		}
		// 6c FL (S-FL-5): a plan region's street carries architect_mc:street {zone, district?} on its item (BatchView.ItemView.ext), so a
		// caller's additions recognise a zone's or a district's streets without matching names
		if (road.ext() != null && road.ext().has(STREET_EXT) && road.ext().get(STREET_EXT).isJsonObject()) {
			q.ext.add(STREET_EXT, road.ext().get(STREET_EXT).deepCopy());
		}
		dev.larattalabs.architect.site.RegionWaitTags.tagRoad(q.ext, rec.id, road.id()); // (6c close-out A, §8) its region and part
		return q;
	}

	/**
	 * (6c X, C19) The caller's part of a lot's {@code ext} in the IR ({@code lots[].ext}): every key outside the {@code architect_mc:}
	 * namespace, deep-copied. The namespace is Architect's (the program's own {@code architect_mc:village} stays on the LotSpec, not on
	 * the site). Looked up by lot id.
	 */
	static JsonObject planLotExt(Ir ir, String lotId) {
		JsonObject out = new JsonObject();
		if (ir.json().get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				if (e instanceof JsonObject lo && lotId.equals(str(lo, "id")) && lo.get("ext") instanceof JsonObject le) {
					le.entrySet().stream().filter(x -> !x.getKey().startsWith("architect_mc:")).forEach(x -> out.add(x.getKey(), x.getValue().deepCopy()));
					break;
				}
			}
		}
		return out;
	}

	private static @Nullable QItem lotItem(ServerLevel level, RegionRec rec, Ir ir, Ir.Lot lot, String entry, List<String> after, RealiseRequest r) {
		return lotItemOf(level, rec, ir, lot, entry, after, r.lotEntries(), r.actor() == null ? null : r.actor().getStringUUID());
	}

	/** {@link #lotItem} with the actor's UUID (6d RV: a revision's lots, installed again after a restart). */
	static @Nullable QItem lotItemOf(ServerLevel level, RegionRec rec, Ir ir, Ir.Lot lot, String entry, List<String> after, Map<String, String> lotEntries,
		@Nullable String actorUuid) {
		String bpId = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
		Blueprint bp = Blueprints.get(bpId);
		// (6c X, C19) the plan's lot ext (the caller's keys, from params.lots[].ext) onto the lot's site; then Architect's own key, which wins
		JsonObject ext = planLotExt(ir, lot.id());
		ext.addProperty("architect_mc:lot", lot.id());
		int[] b = lot.box();
		QItem q;
		if (bp == null) {
			q = new QItem("lot:" + lot.id(), lot.stage(), after, bpId, rec.dimension, b[0], b[1], b[2], 0, false, ext, null, rec.survival(),
				dev.larattalabs.architect.survival.SurvivalWorld.on());
			q.fail(Reason.UNKNOWN_BLUEPRINT.name(), "No design " + bpId + " in the library");
			return q;
		}
		LotFitting.Fit f = LotFitting.fit(bp, new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]), lot.front(), true, 0, true);
		// (6c IRR, §4) the region's irrigation cells in this lot's box: the lot's design drops its blocks there and its site never owns them
		// (LotMask, on the site's ext); how many of the entry's blocks the mask drops is reported (irrigationDropped)
		JsonArray irr = lotIrrigation(ir, lot.id());
		if (irr != null) {
			ext.add(dev.larattalabs.architect.site.LotMask.EXT, dev.larattalabs.architect.site.LotMask.extOf(irr));
			ext.addProperty(dev.larattalabs.architect.site.LotMask.EXT_DROPPED, dropped(bpId, f, dev.larattalabs.architect.site.LotMask.of(ext)));
		}
		// (6c RS, §5) a survival region's lot is a construction site (Y1: the owner's stockpile, no crate)
		q = new QItem("lot:" + lot.id(), lot.stage(), after, bpId, rec.dimension, f.ox(), f.oy(), f.oz(), f.turns(), false, ext, actorUuid, rec.survival(),
			dev.larattalabs.architect.survival.SurvivalWorld.on());
		q.layer = true;
		q.consented.addAll(rec.consented); // (6c PT) the realise's consented builds
		if (!f.fits()) {
			q.fail(Reason.LOT_TOO_SMALL.name(), "The lot is too small for " + bpId + ": " + f.why());
		}
		return q;
	}

	/**
	 * (6c IRR) A lot's irrigation cells in the IR ({@code lots[].irrigation.cells}: column runs), or null: none, or the broken variant
	 * {@code unmasked} (the lot's design is then placed over them, and the live check refuses the sources).
	 */
	static @Nullable JsonArray lotIrrigation(Ir ir, String lotId) {
		if (ir.json().get("lots") instanceof JsonArray lots) {
			for (JsonElement e : lots) {
				if (e instanceof JsonObject lo && lotId.equals(str(lo, "id")) && lo.get("irrigation") instanceof JsonObject g && g.get("cells") instanceof JsonArray c
					&& !c.isEmpty()) {
					return g.get("unmasked") instanceof JsonElement u && u.isJsonPrimitive() && u.getAsBoolean() ? null : c;
				}
			}
		}
		return null;
	}

	/** (6c IRR) How many of an entry's non-air blocks, fitted by {@code f}, stand on a masked cell (the count the realise drops). */
	static int dropped(String bpId, LotFitting.Fit f, java.util.function.@Nullable LongPredicate mask) {
		var grid = dev.larattalabs.architect.placement.TemplateGrid.of(bpId);
		if (grid == null || mask == null) {
			return 0;
		}
		var m = grid.ghost(f.turns());
		int n = 0;
		for (int i = 0; i < m.count(); i++) {
			if (mask.test(net.minecraft.core.BlockPos.asLong(f.ox() + m.x(i), f.oy() + m.y(i), f.oz() + m.z(i)))) {
				n++;
			}
		}
		return n;
	}

	private static boolean overlaps(int[] a, int[] b) {
		return a[0] <= b[3] && b[0] <= a[3] && a[2] <= b[5] && b[2] <= a[5];
	}

	// ------------------------------------------------------------------ chunks generated during a realise (diagnosis)

	/** Per region: the first {@link #GEN_LOGGED} chunks generated while it realised ({@code x,z holder ...}). Server thread. */
	private static final Map<String, List<String>> GENERATED = new HashMap<>();
	static final int GEN_LOGGED = 1000;

	/** Chunks generated in the world while a region realised that were no region's (a player's view, a forceload): counted, never charged. */
	private static long generatedElsewhere;
	/** Of those, the ones logged (one line per tick, at most this many lines a session). */
	private static int elsewhereLogged;
	static final int ELSEWHERE_LOGGED = 200;

	/**
	 * Whether a chunk generated while a region realised is that region's (fix/survival-off-storm): in its dimension, and in its claim
	 * + 2 chunks or held by one of its batch's tickets. Anything else (a player's view after a teleport, a forceload, another mod) is
	 * the world's, not the region's: before this every chunk generated anywhere was charged to every region still placing. Pure.
	 */
	static boolean generatedBy(String regionDimension, int[] claim, @Nullable String batchId, String dimension, long chunk, @Nullable String holder) {
		if (!regionDimension.equals(dimension)) {
			return false;
		}
		if (holder != null && batchId != null && holder.startsWith(batchId + "/")) {
			return true;
		}
		int cx = net.minecraft.world.level.ChunkPos.getX(chunk);
		int cz = net.minecraft.world.level.ChunkPos.getZ(chunk);
		return inClaimPlus2(claim, cx, cz);
	}

	static boolean inClaimPlus2(int[] c, int cx, int cz) {
		return cx >= (c[0] >> 4) - 2 && cx <= (c[3] >> 4) + 2 && cz >= (c[2] >> 4) - 2 && cz <= (c[5] >> 4) + 2;
	}

	/**
	 * Every tick: whether a region realises (the mixin queues generated chunks only then), and the chunks generated during a
	 * realise since the last tick, attributed and logged whatever {@code ARCHITECT_TRACE_JOBS} says. A chunk is a region's when
	 * {@link #generatedBy} says so: those count in its {@code stats.generatedDuringRealise} and the first 1000 per region are logged
	 * with their position, the Architect ticket holding them (if any), whether a prepare runs, the nearest player's distance in
	 * chunks against the view distance. The rest are the world's ({@link #generatedElsewhere}, one summary line per tick). Chunks
	 * the queue dropped (overflow, position unknown) still count for every region realising. The gate's "0 generated during
	 * realise" and its unexplained 161 are what this is for.
	 */
	private static void generatedDuringRealise(MinecraftServer s) {
		List<Live> running = new ArrayList<>();
		for (Live l : REGIONS.values()) {
			QBatch b = l.rec().state == RegionState.PLACING ? Batches.get(l.rec().batchId) : null;
			if (b != null && b.running()) {
				running.add(l);
			}
		}
		GenCounter.realising(!running.isEmpty());
		List<GenCounter.Gen> gen = GenCounter.drain();
		long dropped = GenCounter.dropped();
		if (gen.isEmpty() && dropped == 0 || running.isEmpty()) {
			return;
		}
		int view = s.getPlayerList().getViewDistance();
		boolean preparing = Prepare.running();
		long[] mine = new long[running.size()];
		long elsewhere = 0;
		String sample = null;
		for (GenCounter.Gen g : gen) {
			int cx = net.minecraft.world.level.ChunkPos.getX(g.chunk());
			int cz = net.minecraft.world.level.ChunkPos.getZ(g.chunk());
			String holder = Batches.ticketHolder(g.chunk());
			int near = Integer.MAX_VALUE;
			for (var p : s.getPlayerList().getPlayers()) {
				if (Sites.dimensionId(p.level()).equals(g.dimension())) {
					near = Math.min(near, Math.max(Math.abs((p.getBlockX() >> 4) - cx), Math.abs((p.getBlockZ() >> 4) - cz)));
				}
			}
			String e = cx + "," + cz + " ticket " + (holder == null ? "none" : holder) + "; prepare " + (preparing ? "running" : "idle") + "; player "
				+ (near == Integer.MAX_VALUE ? "none" : near + " chunks away (view " + view + ")");
			boolean any = false;
			for (int k = 0; k < running.size(); k++) {
				RegionRec rec = running.get(k).rec();
				if (!generatedBy(rec.dimension, rec.claim, rec.batchId, g.dimension(), g.chunk(), holder)) {
					continue;
				}
				any = true;
				mine[k]++;
				List<String> list = GENERATED.computeIfAbsent(rec.id, x -> new ArrayList<>());
				if (list.size() < GEN_LOGGED) {
					String le = e + "; " + (inClaimPlus2(rec.claim, cx, cz) ? "in" : "outside") + " the claim + 2";
					list.add(le);
					Architect.LOGGER.info("Region {}: chunk {} generated during realise (#{}): {}", rec.id, cx + "," + cz, list.size(), le);
				}
			}
			if (!any) {
				elsewhere++;
				if (sample == null) {
					sample = g.dimension() + " " + e;
				}
			}
		}
		for (int k = 0; k < running.size(); k++) {
			RegionRec rec = running.get(k).rec();
			long add = mine[k] + dropped;
			if (add > 0) {
				long n = (rec.stats.has("generatedDuringRealise") ? rec.stats.get("generatedDuringRealise").getAsLong() : 0) + add;
				rec.stats.addProperty("generatedDuringRealise", n);
			}
			if (dropped > 0) {
				Architect.LOGGER.info("Region {}: {} more chunks generated during realise (not attributed: queue full)", rec.id, dropped);
			}
		}
		if (elsewhere > 0) {
			generatedElsewhere += elsewhere;
			if (elsewhereLogged < ELSEWHERE_LOGGED) {
				elsewhereLogged++;
				Architect.LOGGER.info("{} chunks generated in the world while {} region(s) realised, none in a realising region's claim + 2 or tickets "
					+ "(not charged to a region; {} this session), e.g. {}", elsewhere, running.size(), generatedElsewhere, sample);
			}
		}
	}

	/** Chunks generated while a region realised that were no region's (this session). */
	public static long generatedElsewhere() {
		return generatedElsewhere;
	}

	/** The chunks generated while the region realised that were logged (at most 1000), for DevBridge and {@code generated.json}. */
	public static List<String> generatedLog(String regionId) {
		return List.copyOf(GENERATED.getOrDefault(regionId, List.of()));
	}

	// ------------------------------------------------------------------ the per-stage drift check (Steward S2)

	/**
	 * Whether a region stage that is approved but not started may start (Batches asks every tick; while it answers false the
	 * stage's items don't start and no tile ahead is frozen). The first stage of the realise was checked at region start. Any
	 * later stage is checked once, when it is about to start ({@link Drift#checkStage}, off the server thread for stored
	 * heightmaps). Land changed beyond the tolerance holds the stage: it goes back to PLANNED, the region's view waits
	 * {@code DRIFTED} "land changed since planning", and {@code REGION_STATE} fires. Approving the stage again continues it
	 * ({@code continued} in the record); replanning is skipping the stage or removing the region. The outcome is kept in the
	 * region record ({@code drift}), so a relog neither checks again nor drops a hold.
	 */
	public static boolean stageGate(MinecraftServer s, QBatch b, String stage) {
		String region = b.ext.get(RegionItems.EXT_REGION).getAsString();
		Live l = REGIONS.get(region);
		if (l == null) {
			return true;
		}
		RegionRec rec = l.rec();
		if (!rec.stages.containsKey(stage) || Revisions.layerOf(stage) > 0) {
			return true; // (6d RV) a revision's stages check every cell at its write instead (§3.3)
		}
		// the stage that runs first (in the group's order: a reorder may change it) was checked at region start
		boolean first = rec.stages.entrySet().stream().allMatch(e -> e.getKey().equals(stage) || e.getValue().startedAt == 0);
		if (first) {
			return true;
		}
		String d = rec.drift.get(stage);
		if (d != null) {
			if (d.startsWith("held:")) {
				// approved again after the hold: the caller continues
				rec.drift.put(stage, "continued:" + d.substring(5));
				Architect.LOGGER.info("Region {}: stage {} continued after its drift hold", region, stage);
				save(l);
				SiteEvents.REGION_STATE.invoker().onState(view(l));
			}
			return true;
		}
		if (b.inStage(stage).stream().anyMatch(i -> i.status != QItem.Status.QUEUED && i.status != QItem.Status.WAITING)) {
			return true; // already under way
		}
		String key = region + "/" + stage;
		if (STAGE_CHECKS.containsKey(key)) {
			return false;
		}
		ServerLevel level = l.level(s);
		if (level == null) {
			return true;
		}
		CompletableFuture<Drift.Result> f;
		try {
			f = Drift.checkStage(level, l, stage);
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("Region {}: stage {} drift check failed: {}", region, stage, e.toString());
			rec.drift.put(stage, "ok: not checked (" + e + ")");
			return true;
		}
		STAGE_CHECKS.put(key, f);
		f.whenComplete((r, e) -> s.execute(() -> {
			STAGE_CHECKS.remove(key);
			if (REGIONS.get(region) != l) {
				return;
			}
			Drift.Result res = e != null || r == null ? new Drift.Result(true, "not checked: " + e, 0, 0, 0) : r;
			if (res.ok()) {
				rec.drift.put(stage, "ok: " + res.message());
				Architect.LOGGER.info("Region {}: stage {} drift check ok: {}", region, stage, res.message());
				save(l);
				return;
			}
			rec.drift.put(stage, "held: " + res.message());
			try {
				RegionItems.holdStage(s, rec.groupId, stage);
			} catch (RuntimeException ex) {
				// it started meanwhile (it can't: the gate held it); nothing to hold
				rec.drift.put(stage, "continued: " + res.message());
			}
			save(l);
			Architect.LOGGER.info("Region {}: land changed since planning before stage {}: {}; the stage holds (approve it again to continue, or replan)",
				region, stage, res.message());
			SiteEvents.REGION_STATE.invoker().onState(view(l));
		}));
		return false;
	}

	/** Server thread (Batches.startStage): an item of a region stage starts. */
	public static void itemStarted(QBatch b, QItem i) {
		Live l = REGIONS.get(b.ext.get(RegionItems.EXT_REGION).getAsString());
		RegionRec.Stage st = l == null ? null : l.rec().stages.get(i.stage);
		if (st != null && st.startedAt == 0) {
			st.startedAt = System.currentTimeMillis();
		}
	}

	/** Server thread: a tick in which an item of the region's running stage was writing (the stage's engine time). */
	public static void stageActive(String region, String stage) {
		Live l = REGIONS.get(region);
		RegionRec.Stage st = l == null ? null : l.rec().stages.get(stage);
		if (st != null) {
			st.activeTicks++;
		}
	}

	// ------------------------------------------------------------------ progress (from Batches)

	/** A region batch item placed or failed. */
	public static void itemDone(QBatch b, QItem i) {
		String region = b.ext.has(RegionItems.EXT_REGION) ? b.ext.get(RegionItems.EXT_REGION).getAsString() : null;
		Live l = region == null ? null : REGIONS.get(region);
		if (l == null) {
			return;
		}
		RegionRec rec = l.rec();
		RegionRec.Stage stg = rec.stages.get(i.stage);
		if (stg != null) {
			stg.lastDoneAt = System.currentTimeMillis();
		}
		if (i.status == QItem.Status.PLACED && server != null) {
			snapshotAfter(l, i);
		}
		if (i.key.startsWith("lot:")) {
			RegionRec.Lot ls = rec.lots.get(i.key.substring(4));
			if (ls != null) {
				ls.siteId = i.siteId;
				ls.state = i.status == QItem.Status.PLACED ? "placed" : "failed:" + i.reason;
			}
		}
		if ("tile".equals(i.itemKind) && i.status == QItem.Status.FAILED) {
			rec.skip("failedTiles", 1);
		}
		dev.larattalabs.architect.site.RealisedRecords.itemDone(Revisions.liveFor(l, i.stage), b, i); // (RP; 6d RV: a revision's own layer)
		if (Revisions.isRevisionBatch(b)) {
			Revisions.itemDone(l, b, i); // (6d RV) its sites
		}
		dirty(l);
	}

	/**
	 * (6c close-out A, Steward's RC finding 1) A construction target, road or lot of a region's group built: the heights over its box
	 * become the later stages' drift baseline. A survival region's items are put down unbuilt (their heights at put-down are the land's),
	 * so without this a later stage's check counted the region's own walls and houses as land changed since planning and held. No region
	 * for the group: nothing.
	 */
	public static void constructionBuilt(MinecraftServer s, @Nullable String groupId, dev.larattalabs.architect.placement.Anchors.@Nullable Bounds box) {
		if (groupId == null || box == null) {
			return;
		}
		for (Live l : REGIONS.values()) {
			if (groupId.equals(l.rec().groupId)) {
				ServerLevel level = l.level(s);
				if (level != null) {
					Heights.snapshotAfter(level, l.world(), l.rec().id, box.minX(), box.minZ(), box.maxX(), box.maxZ());
				}
				return;
			}
		}
	}

	/**
	 * DevBridge (close-out A, Steward's RC finding 1): a region's stage drift check run now, as before the stage starts, and its record's
	 * drift entries -> {ok, message, sampled, within2, over8InLots, drift: {stage: entry}}. Server thread.
	 */
	public static CompletableFuture<JsonObject> stageDriftNow(String regionId, String stage) {
		Live l = REGIONS.get(regionId);
		MinecraftServer s = server;
		ServerLevel level = l == null || s == null ? null : l.level(s);
		if (level == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no region " + regionId + " loaded"));
		}
		return Drift.checkStage(level, l, stage).thenApply(r -> {
			JsonObject o = new JsonObject();
			o.addProperty("ok", r.ok());
			o.addProperty("message", r.message());
			o.addProperty("sampled", r.sampled());
			o.addProperty("within2", r.within2());
			o.addProperty("over8InLots", r.over8InLots());
			JsonObject d = new JsonObject();
			l.rec().drift.forEach(d::addProperty);
			o.add("drift", d);
			com.google.gson.JsonArray st = new com.google.gson.JsonArray();
			l.rec().stages.keySet().forEach(st::add);
			o.add("stages", st);
			return o;
		});
	}

	/** The heights a placed item left over its columns: the later stages' drift baseline ({@link Heights#snapshotAfter}). */
	private static void snapshotAfter(Live l, QItem i) {
		ServerLevel level = l.level(server);
		if (level == null) {
			return;
		}
		int x0;
		int z0;
		int x1;
		int z1;
		if ("tile".equals(i.itemKind) && i.spec != null) {
			int[] t = Ir.tile(i.spec.get("tile").getAsString());
			x0 = Heights.TILE * t[0];
			z0 = Heights.TILE * t[1];
			x1 = x0 + Heights.TILE - 1;
			z1 = z0 + Heights.TILE - 1;
		} else if (i.siteId != null && dev.larattalabs.architect.site.Infras.get(i.siteId) != null) {
			var bx = dev.larattalabs.architect.site.Infras.get(i.siteId).box();
			x0 = bx.minX();
			z0 = bx.minZ();
			x1 = bx.maxX();
			z1 = bx.maxZ();
		} else if (i.siteId != null && Sites.get(i.siteId) != null) {
			var bx = Sites.get(i.siteId).restoreBox();
			x0 = bx.minX();
			z0 = bx.minZ();
			x1 = bx.maxX();
			z1 = bx.maxZ();
		} else {
			return;
		}
		Heights.snapshotAfter(level, l.world(), l.rec().id, x0, z0, x1, z1);
	}

	/** A tile's check counted its skipped cells. */
	public static void tileChecked(String region, String stage, Map<String, Long> skipped) {
		tileChecked(region, stage, skipped, List.of());
	}

	/** (6c PT) With the builds the tile kept out (the region's findings, {@link RegionView#buildHits}). */
	public static void tileChecked(String region, String stage, Map<String, Long> skipped, List<dev.larattalabs.architect.api.BuildHit> builds) {
		Live l = REGIONS.get(region);
		if (l != null) {
			skipped.forEach((k, v) -> l.rec().skip(k, v));
			l.rec().builds(builds);
		}
	}

	/** A tile entry committed (P8) with {@code cells}, or a tile with nothing to write. */
	public static void tilePlaced(String region, String stage, String set, String key, @Nullable String siteId, int cells) {
		Live l = REGIONS.get(region);
		if (l == null) {
			return;
		}
		RegionRec.Stage st = l.rec().stages.get(stage);
		if (st != null) {
			st.tilesDone++;
			st.cells += cells;
		}
		l.rec().cellsWritten += cells;
		Object fl = l.rec().stats.get("firstTileAt");
		long now = System.currentTimeMillis();
		if (fl == null) {
			l.rec().stats.addProperty("firstTileAt", now);
		}
		l.rec().stats.addProperty("lastTileAt", now);
		dirty(l);
		var hook = TILE_HOOK;
		if (hook != null) {
			int done = 0;
			for (RegionRec.Stage x : l.rec().stages.values()) {
				done += x.tilesDone;
			}
			hook.accept(l, done);
		}
	}

	/** The region's batch ended. */
	public static void batchDone(QBatch b) {
		String region = b.ext.get(RegionItems.EXT_REGION).getAsString();
		Live l = REGIONS.get(region);
		if (l == null) {
			return;
		}
		if (Revisions.isRevisionBatch(b)) {
			Revisions.batchDone(l, b); // (6d RV) a revision ended: the region reads its own state again
			return;
		}
		// (6c H) a body not written (its containment check failed) or drained by the escape guard ends the region PARTIAL (S-H-6: no new state)
		boolean allPlaced = b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED) && !RegionFluids.anyDrained(l);
		l.rec().state = b.status == QBatch.Status.DONE && allPlaced ? RegionState.PLACED : b.status == QBatch.Status.DONE ? RegionState.PARTIAL
			: RegionState.FAILED;
		l.rec().stats.addProperty("doneAt", System.currentTimeMillis());
		l.rec().stats.addProperty("generatedTerrainDuring", GenCounter.terrain() - (l.rec().stats.has("genTerrainAtStart") ? l.rec().stats.get(
			"genTerrainAtStart").getAsLong() : 0));
		l.rec().generatedWhileHeld = GenCounter.whileHeld();
		save(l);
		dev.larattalabs.architect.site.RealisedRecords.batchDone(l); // (RP) the dev audit only
		List<String> gl = GENERATED.get(region);
		if (gl != null && !gl.isEmpty()) {
			com.google.gson.JsonArray a = new com.google.gson.JsonArray();
			gl.forEach(a::add);
			JsonObject o = new JsonObject();
			o.addProperty("count", l.rec().stats.has("generatedDuringRealise") ? l.rec().stats.get("generatedDuringRealise").getAsLong() : gl.size());
			o.add("first", a);
			try {
				RegionStore.writeJson(RegionStore.region(l.world(), region).resolve("generated.json"), o);
			} catch (IOException e) {
				Architect.LOGGER.warn("Region {}: generated.json: {}", region, e.toString());
			}
		}
		SiteEvents.REGION_STATE.invoker().onState(view(l));
	}

	private static void dirty(Live l) {
		long now = System.currentTimeMillis();
		if (now - lastProgress >= 1000) {
			lastProgress = now;
			save(l);
			SiteEvents.REGION_PROGRESS.invoker().onProgress(view(l));
		}
	}

	/** (6c RS) Saves a region's record (RegionFluids' charge). */
	public static void saveRec(Live l) {
		save(l);
	}

	static void save(Live l) {
		try {
			RegionStore.writeJson(RegionStore.region(l.world(), l.rec().id).resolve("region.json"), l.rec().toJson());
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {} could not be saved: {}", l.rec().id, e.toString());
		}
	}

	// ------------------------------------------------------------------ views, removal

	@Override
	public Optional<RegionView> get(String regionId) {
		Live l = REGIONS.get(regionId);
		if (l == null && TOMBS.containsKey(regionId)) {
			return Optional.of(tombView(TOMBS.get(regionId))); // (6c X, C22) a removed region: REMOVED with its time
		}
		return l == null ? Optional.empty() : Optional.of(view(l));
	}

	@Override
	public List<RegionView> list(@Nullable String owner) {
		List<RegionView> out = new ArrayList<>();
		for (Live l : REGIONS.values()) {
			if (owner == null || owner.equals(l.rec().owner)) {
				out.add(view(l));
			}
		}
		return out;
	}

	public static RegionView view(Live l) {
		RegionRec r = l.rec();
		SiteGroupRec g = Sites.group(r.groupId);
		List<StageProgress> st = new ArrayList<>();
		r.stages.forEach((name, s) -> {
			SiteGroupRec.StageRec sr = g == null ? null : g.stage(name);
			st.add(new StageProgress(name, sr == null ? Stage.State.PLANNED : sr.state(), s.tilesDone, s.tilesTotal, s.cells));
		});
		List<LotState> lots = new ArrayList<>();
		r.lots.forEach((id, ls) -> lots.add(new LotState(id, ls.siteId, ls.state, Revisions.lotRevision(ls))));
		Refusal waiting = null;
		for (var e : r.drift.entrySet()) {
			if (e.getValue().startsWith("held:")) {
				waiting = new Refusal(Reason.DRIFTED, "land changed since planning: " + e.getValue().substring(5).trim() + "; stage " + e.getKey()
					+ " holds: approve it again to continue, or replan (skip the stage, or remove the region and plan again)");
				break;
			}
		}
		String heldStage = null;
		for (var e : r.drift.entrySet()) {
			if (e.getValue().startsWith("held:")) {
				heldStage = e.getKey();
				break;
			}
		}
		QBatch b = Batches.get(r.batchId);
		QItem waitingItem = null;
		if (waiting == null && b != null && b.running()) {
			for (QItem i : b.items) {
				if (i.status == QItem.Status.WAITING && i.reason != null) {
					waiting = new Refusal(Reason.valueOf(i.reason), i.message);
					waitingItem = i;
					break;
				}
			}
		}
		if (waiting == null && r.state != RegionState.PLACED && r.state != RegionState.REMOVING) {
			String stale = staleOf(l);
			if (stale != null) {
				waiting = new Refusal(Reason.PLAN_STALE, stale);
			}
		}
		int[] c = r.claim;
		PrepareView pv = Prepare.view(r.planId);
		List<dev.larattalabs.architect.api.WaitAction> actions = actionsOf(l, waiting, waitingItem, heldStage, pv);
		return new RegionView(r.id, r.planId, r.irSha, r.owner, r.ext, r.groupId, new BoundingBox(c[0], c[1], c[2], c[3], c[4], c[5]), r.state, st, lots,
			r.cellsWritten, r.skipped, waiting, pv, actions, 0L, Brushes.kindOf(r), r.buildHitList(), r.beside, dev.larattalabs.architect.site.RegionTargets.build(l),
			r.position, r.busy, Revisions.views(r));
	}

	/** (6c X, C22) The view of a removed region: REMOVED, with the time its removal finished. */
	static RegionView tombView(RegionRec r) {
		int[] c = r.claim;
		List<LotState> lots = new ArrayList<>();
		r.lots.forEach((id, ls) -> lots.add(new LotState(id, ls.siteId, ls.state)));
		return new RegionView(r.id, r.planId, r.irSha, r.owner, r.ext, r.groupId, new BoundingBox(c[0], c[1], c[2], c[3], c[4], c[5]), RegionState.REMOVED,
			List.of(), lots, r.cellsWritten, r.skipped, null, null, List.of(), r.removedAt, Brushes.kindOf(r), r.buildHitList(), r.beside);
	}

	/** (6b) The nudge actions for what the region waits for ({@link WaitActions}). */
	static List<dev.larattalabs.architect.api.WaitAction> actionsOf(Live l, @Nullable Refusal waiting, @Nullable QItem item, @Nullable String heldStage,
		@Nullable PrepareView pv) {
		if (waiting == null) {
			return List.of();
		}
		int[] box = null;
		if (item != null) {
			if ("tile".equals(item.itemKind) && item.spec != null) {
				int[] t = Ir.tile(item.spec.get("tile").getAsString());
				box = new int[] {Heights.TILE * t[0], Heights.TILE * t[1], Heights.TILE * t[0] + Heights.TILE - 1, Heights.TILE * t[1] + Heights.TILE - 1};
			} else {
				box = new int[] {item.x, item.z, item.x + 15, item.z + 15};
			}
		}
		int[] player = null;
		MinecraftServer s = server;
		if (s != null && s.isSameThread()) {
			var players = s.getPlayerList().getPlayers();
			if (!players.isEmpty()) {
				var pl = players.get(0);
				player = new int[] {pl.getBlockX(), pl.getBlockY(), pl.getBlockZ()};
			}
		}
		PlanRec p = PLANS.get(l.rec().planId);
		int toGenerate = pv != null && pv.state() == PrepareView.State.RUNNING ? pv.chunksMissing() : p != null ? p.chunksToGenerate() : 0;
		if (waiting.reason() == Reason.NOT_GENERATED && pv != null && pv.state() == PrepareView.State.RUNNING) {
			return List.of(); // a prepare already runs: nothing to do but wait
		}
		return WaitActions.of(new WaitActions.Context(waiting.reason(), box, player, heldStage, toGenerate, Prepare.measuredRate(WaitActions.DEFAULT_RATE)));
	}

	/** Every second: REGION_STATE when a placing region's actions changed (S8). Server thread. */
	static void actionsTick(MinecraftServer s) {
		if (s.getTickCount() % 20 != 0) {
			return;
		}
		for (Live l : REGIONS.values()) {
			if (l.rec().state != RegionState.PLACING) {
				continue;
			}
			RegionView v = view(l);
			List<dev.larattalabs.architect.api.WaitAction> was = LAST_ACTIONS.put(l.rec().id, v.actions());
			// what changed is the kinds (and the held stage), not a MOVE_CLOSER target that follows the walking player
			if (was != null && !actionKeys(was).equals(actionKeys(v.actions())) || was == null && !v.actions().isEmpty()) {
				SiteEvents.REGION_STATE.invoker().onState(v);
			}
		}
	}

	static List<String> actionKeys(List<dev.larattalabs.architect.api.WaitAction> a) {
		return a.stream().map(x -> x.kind() == dev.larattalabs.architect.api.WaitAction.Kind.APPROVE_STAGE ? x.kind() + ":" + x.detail() : x.kind().name())
			.toList();
	}

	// ------------------------------------------------------------------ 6b: check, previews, design, nudge

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.CheckReport> check(String planId) {
		MinecraftServer s = server;
		TileStream.Link link = TileStream.link;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		if (link == null || !link.connected()) {
			return failed(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.check");
		m.addProperty("planId", planId);
		progress(s, planId, "checking");
		return link.send(m).thenCompose(ack -> onServer(s, () -> {
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				throw refusal(Reason.OTHER, "the helper refused the check: " + str(ack, "error"));
			}
			JsonObject res = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
			dev.larattalabs.architect.api.CheckReport rep = Wire6b.report(res.get("report"));
			if (rep == null) {
				throw refusal(Reason.OTHER, "the helper's check answered no report");
			}
			PlanRec p = planRec(planId);
			if (p != null) {
				p.planned().add("report", res.get("report").deepCopy());
				savePlan(s, p);
			}
			SiteEvents.REGION_CHECKED.invoker().onChecked(planId, rep);
			return rep;
		}));
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.RegionPreviews> previews(String planId, java.util.Set<dev.larattalabs.architect.api.PreviewView> views,
		List<List<BlockPos>> axes) {
		MinecraftServer s = server;
		TileStream.Link link = TileStream.link;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world"));
		}
		if (link == null || !link.connected()) {
			return failed(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		if (axes != null && axes.size() > 4) {
			return failed(Reason.REGION_LIMIT, "at most 4 section axes (" + axes.size() + " given)");
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.preview");
		m.addProperty("planId", planId);
		if (views != null && !views.isEmpty()) {
			JsonArray v = new JsonArray();
			views.stream().sorted().forEach(x -> v.add(x.name().toLowerCase(java.util.Locale.ROOT)));
			m.add("views", v);
		}
		if (axes != null && !axes.isEmpty()) {
			JsonArray a = new JsonArray();
			for (List<BlockPos> axis : axes) {
				JsonArray pts = new JsonArray();
				for (BlockPos bp : axis) {
					JsonArray q = new JsonArray();
					q.add(bp.getX());
					q.add(bp.getY());
					q.add(bp.getZ());
					pts.add(q);
				}
				a.add(pts);
			}
			m.add("axes", a);
		}
		progress(s, planId, "rendering");
		return link.send(m).thenCompose(ack -> onServer(s, () -> {
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				throw refusal(Reason.OTHER, "the helper refused the previews: " + str(ack, "error"));
			}
			JsonObject res = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
			dev.larattalabs.architect.api.RegionPreviews pr = Wire6b.previews(res.get("paths"), res.get("sitePlan"));
			if (pr == null) {
				throw refusal(Reason.OTHER, "the helper's previews answered no paths");
			}
			return pr;
		}));
	}

	@Override
	public CompletableFuture<String> design(dev.larattalabs.architect.api.RegionDesignRequest r) {
		return RegionDesigns.start(r);
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.NudgeResult> nudge(String regionId, dev.larattalabs.architect.api.WaitAction.Kind action) {
		MinecraftServer s = server;
		Live l = REGIONS.get(regionId);
		if (s == null || l == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no region " + regionId));
		}
		return onServer(s, () -> nudge0(s, l, action)).thenCompose(f -> f);
	}

	/** When a PREPARE nudge showed its estimate, per region (a second one within {@link #PREPARE_CONFIRM_MS} starts it). */
	private static final Map<String, Long> PREPARE_SHOWN = new HashMap<>();
	public static final long PREPARE_CONFIRM_MS = 5 * 60_000L;

	private static CompletableFuture<dev.larattalabs.architect.api.NudgeResult> nudge0(MinecraftServer s, Live l, dev.larattalabs.architect.api.WaitAction.Kind k) {
		RegionView v = view(l);
		dev.larattalabs.architect.api.WaitAction a = v.actions().stream().filter(x -> x.kind() == k).findFirst().orElse(null);
		if (a == null) {
			return done(false, "not applicable" + (v.waiting() == null ? " (the region waits for nothing)" : " (it waits " + v.waiting().reason() + ")"));
		}
		String id = l.rec().id;
		return switch (k) {
			case MOVE_CLOSER -> done(false, a.target() == null ? "walk closer to the region" : "walk to " + a.target().getX() + ", " + a.target().getZ());
			case PREPARE -> {
				Long shown = PREPARE_SHOWN.get(id);
				long now = System.currentTimeMillis();
				if (shown == null || now - shown > PREPARE_CONFIRM_MS) {
					PREPARE_SHOWN.put(id, now);
					yield done(false, "prepare would generate " + a.detail() + "; nudge PREPARE again within 5 minutes to start it");
				}
				PREPARE_SHOWN.remove(id);
				PlanRec p = planRec(l.rec().planId);
				if (p == null) {
					yield done(false, "the region's plan " + l.rec().planId + " is gone: replan with Regions.plan");
				}
				Prepare.start(s, p, null);
				Architect.LOGGER.info("Region {}: prepare started by a nudge ({})", id, a.detail());
				yield done(true, "prepare started: " + a.detail());
			}
			case START_SIDECAR -> {
				if (TileStream.available()) {
					// connected, yet a tile waits: the helper kept answering ir_unknown/blob_unknown; ask again
					int n = TileStream.retryWaiting(id);
					yield done(n > 0, n > 0 ? "asked the helper again for " + n + " tile" + (n == 1 ? "" : "s") : "the helper is connected");
				}
				String st = dev.larattalabs.architect.apiimpl.RegionBridge.restartSidecar();
				yield done("starting".equals(st), "starting".equals(st) ? "asked the launcher to start the helper" : "the helper is " + st);
			}
			case APPROVE_STAGE -> {
				String stage = a.detail();
				if (stage == null) {
					yield done(false, "no held stage");
				}
				try {
					ArchitectApi.get().sites(s).approveStage(l.rec().groupId, stage);
				} catch (RuntimeException e) {
					yield done(false, "stage " + stage + " could not be approved: " + e.getMessage());
				}
				yield done(true, "stage " + stage + " approved: it continues on the changed land");
			}
			case REPLAN -> done(false, "replan with Regions.plan (remove this region first, or skip the held stage)");
			case RETRY -> {
				// (6c 0a) TILE_SLOW: ask the helper again now for the region's waiting tiles
				int n = TileStream.retryWaiting(id);
				yield done(n > 0, n > 0 ? "asked the helper again for " + n + " slow tile" + (n == 1 ? "" : "s") : "no tile waits");
			}
		};
	}

	private static CompletableFuture<dev.larattalabs.architect.api.NudgeResult> done(boolean ok, String msg) {
		return CompletableFuture.completedFuture(new dev.larattalabs.architect.api.NudgeResult(ok, msg));
	}

	static void savePlan(MinecraftServer s, PlanRec p) {
		try {
			RegionStore.writeJson(RegionStore.plan(s.getWorldPath(LevelResource.ROOT), p.planId()), planToJson(p));
		} catch (IOException e) {
			Architect.LOGGER.warn("Region plan {} could not be saved: {}", p.planId(), e.toString());
		}
	}

	@Override
	public CompletableFuture<RemoveResult> remove(String regionId, RemoveOptions o) {
		MinecraftServer s = server;
		Live l = REGIONS.get(regionId);
		if (s != null && l == null && TOMBS.containsKey(regionId)) {
			// (6c X, C22) already removed: removed again, nothing written
			return CompletableFuture.completedFuture(new RemoveResult(true, List.of(), Map.of()));
		}
		if (s == null || l == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no region " + regionId));
		}
		return onServer(s, () -> {
			ServerLevel lv = l.level(s);
			if (lv != null && l.rec().survival()) {
				dev.larattalabs.architect.site.RegionFreeDrops.restoreMined(lv, l); // (6c RS §9) mined free cells back first
			}
			QBatch b = Batches.get(l.rec().batchId);
			if (b != null && b.running()) {
				return ArchitectApi.get().sites(s).cancelBatch(b.id).thenCompose(x -> removeGroup(s, l, o));
			}
			return removeGroup(s, l, o);
		}).thenCompose(f -> f);
	}

	/**
	 * (6c D3, Steward's RC) The state a region had when its removal began: a removal that ends having written nothing (refused at once,
	 * or stopped on a blocker before it starts) leaves the region as it was, not PARTIAL. Transient: a load reconciles a REMOVING region.
	 */
	private static final Map<String, RegionState> BEFORE_REMOVAL = new java.util.concurrent.ConcurrentHashMap<>();

	private static CompletableFuture<RemoveResult> removeGroup(MinecraftServer s, Live l, RemoveOptions o) {
		// (6c D3, Steward's RC) the owner rule first: a refused caller changes nothing (the region's state and its sites' stay as they
		// were) and is answered with the rule's blocker. Before, the region went REMOVING and then ended PARTIAL with nothing removed
		// (main since C23's refusal path)
		SiteGroupRec grp = Sites.group(l.rec().groupId);
		String refused = grp == null ? null : dev.larattalabs.architect.apiimpl.ApiRules.removeRefusal(l.rec().groupId, grp.owner(), o == null ? null : o.requester(),
			o != null && o.force());
		if (refused != null && !dev.larattalabs.architect.site.Groups.removalRunning(l.rec().groupId)) {
			Architect.LOGGER.info("Region {}: removal refused, nothing changed (state {}): {}", l.rec().id, l.rec().state, refused);
			return CompletableFuture.completedFuture(new RemoveResult(false, List.of(refused), Map.of()));
		}
		if (l.rec().state != RegionState.REMOVING) {
			BEFORE_REMOVAL.put(l.rec().id, l.rec().state);
		}
		l.rec().state = RegionState.REMOVING;
		save(l);
		SiteEvents.REGION_STATE.invoker().onState(view(l));
		// (C23) the region's end state is set by groupEnded (Groups.GROUP_ENDED), from the removal itself, not from this future:
		// a removal resumed after a load has no future, and every end (or early answer) of the group's removal reaches the hook
		// on the server thread before this future completes
		CompletableFuture<RemoveResult> f = ArchitectApi.get().sites(s).removeGroup(l.rec().groupId, o);
		if (!dev.larattalabs.architect.site.Groups.removalRunning(l.rec().groupId)) {
			// this call started or joined no removal: it answered at once (refused by the owner rule, no such group; an already
			// removed group ended the region through the hook). Its own refusal ends the region PARTIAL, as before.
			f.whenComplete((res, e) -> {
				if (e != null || !res.removed()) {
					// (the D3 RC's finding 1) the refusal's reason goes with the region's end: never a PARTIAL without one
					String why = e != null ? "it failed: " + (e.getCause() != null ? e.getCause() : e) : String.join("; ", res.blockers());
					Runnable end = () -> {
						if (!dev.larattalabs.architect.site.Groups.removalRunning(l.rec().groupId)) {
							finishRemoval(l, false, 0L, why, true); // (answered at once: nothing was written)
						}
					};
					if (s.isSameThread()) {
						end.run(); // the usual case: answered at once on this (server) thread, before the caller sees it
					} else {
						s.execute(end);
					}
				}
			});
		}
		return f;
	}

	/** DevBridge {@code dev.region.dropRemovalEnd} (C23 gate): the next group end leaves its region REMOVING (a stop between the group's save and the region's record). */
	public static volatile boolean dropNextRemovalEnd;

	/**
	 * (C23) A whole-group removal ended (Groups, server thread): the REMOVING region of that group ends as an uninterrupted removal
	 * ends it: REMOVED (removedAt, the tombstone, its key ended) or PARTIAL (the stopped removal). Only a REMOVING region changes,
	 * once: a removal of a region's group through the site API leaves the region's state alone, as before.
	 */
	private static void groupEnded(String groupId, dev.larattalabs.architect.site.Groups.Removed res) {
		if (dropNextRemovalEnd && REGIONS.values().stream().anyMatch(l -> l.rec().state == RegionState.REMOVING && java.util.Objects.equals(l.rec().groupId, groupId))) {
			dropNextRemovalEnd = false;
			Architect.LOGGER.info("Group {} ended (removed={}); dev hook: its region's record is left REMOVING", groupId, res.removed());
			return;
		}
		for (Live l : List.copyOf(REGIONS.values())) {
			if (l.rec().state == RegionState.REMOVING && java.util.Objects.equals(l.rec().groupId, groupId)) {
				SiteGroupRec g = Sites.group(groupId);
				finishRemoval(l, res.removed(), g != null && g.removedAt() > 0 ? g.removedAt() : System.currentTimeMillis(), String.join("; ", res.blockers()),
					!res.removed() && dev.larattalabs.architect.site.Groups.endedUntouched(groupId));
			}
		}
	}

	private static void finishRemoval(Live l, boolean removed, long at, @Nullable String why, boolean untouched) {
		if (REGIONS.get(l.rec().id) != l || l.rec().state != RegionState.REMOVING) {
			return;
		}
		RegionState before = BEFORE_REMOVAL.remove(l.rec().id);
		if (!removed && untouched && before != null) {
			// (6c D3, Steward's RC) stopped before it wrote anything: the region stays as it was
			l.rec().state = before;
			save(l);
			Architect.LOGGER.info("Region {}: removal stopped before it wrote anything; it stays {} ({}): {}", l.rec().id, before, l.rec().groupId,
				why == null || why.isBlank() ? "no reason given" : why);
			SiteEvents.REGION_STATE.invoker().onState(view(l));
			return;
		}
		if (removed) {
			l.rec().state = RegionState.REMOVED;
			l.rec().removedAt = at;
			TOMBS.put(l.rec().id, l.rec());
			REGIONS.remove(l.rec().id);
			Heights.forget(l.rec().id);
			TileStream.forgetRegion(l.rec().id);
			RegionFluids.forget(l.rec().id);
			try {
				RegionStore.writeJson(RegionStore.region(l.world(), l.rec().id).resolve("removed.json"), l.rec().toJson());
				Files.deleteIfExists(RegionStore.region(l.world(), l.rec().id).resolve("region.json"));
			} catch (IOException e) {
				Architect.LOGGER.warn("Region {}: {}", l.rec().id, e.toString());
			}
		} else {
			l.rec().state = RegionState.PARTIAL;
			save(l);
		}
		if (removed) {
			Architect.LOGGER.info("Region {}: removal done: REMOVED ({})", l.rec().id, l.rec().groupId);
		} else {
			// (the D3 RC's finding 1) a stopped removal always names why (the caller's RemoveResult.blockers carries the same)
			Architect.LOGGER.info("Region {}: removal stopped: PARTIAL ({}): {}", l.rec().id, l.rec().groupId, why == null || why.isBlank() ? "no reason given" : why);
		}
		SiteEvents.REGION_STATE.invoker().onState(view(l));
		if (removed) {
			PlanChecks.regionRemoved(l.rec(), false); // (C36) its artifact, if nothing else holds it
			danglingJoins(l.rec().id, at);
		}
	}

	/** RegionView ext key (Architect's): {@code {region, dangling, since?}} on a region planned beside another (6c D1). */
	public static final String EXT_BESIDE = "architect_mc:beside";
	/** RegionView ext key (Architect's): an outpost's corridor, {@code {district: {runs, cells, rect}}} (6c D2). */
	public static final String EXT_CORRIDOR = "architect_mc:corridor";

	/**
	 * (6c D1, CONTRACT D §3) The standing region {@code id} was removed first (allowed: journal layering): every region planned beside
	 * it reports its join's end as dangling in its ext ({@code architect_mc:beside.dangling}, since when), saved, and logged.
	 */
	/** (7a GJ) The region whose gate a district's join crosses (its IR's {@code reach.gate.region}), or null. */
	static @Nullable String gateRegionOf(Live o) {
		JsonObject ir = Revisions.effective(o);
		return ir != null && ir.get("reach") instanceof JsonObject rc && rc.get("gate") instanceof JsonObject g ? str(g, "region") : null;
	}

	private static void danglingJoins(String id, long at) {
		for (Live o : List.copyOf(REGIONS.values())) {
			// ((7a GJ, §6) a district joined through a gate of the removed region (a wall region round its town): dangling too, its land's
			// standingRemoved set; `gateRemoved` names the gate's region, `region` stays its town)
			String via = !id.equals(o.rec().beside) && o.rec().beside != null && o.rec().state != RegionState.REMOVED ? gateRegionOf(o) : null;
			if (!id.equals(o.rec().beside) && !id.equals(via)) {
				continue;
			}
			JsonObject note = o.rec().ext.get(EXT_BESIDE) instanceof JsonObject n ? n : new JsonObject();
			if (id.equals(via)) {
				note.addProperty("region", o.rec().beside);
				note.addProperty("gateRemoved", id);
			} else {
				note.addProperty("region", id);
			}
			note.addProperty("dangling", true);
			note.addProperty("since", at);
			o.rec().ext.add(EXT_BESIDE, note);
			// (6c D3, §6, S-D3-3) its land: standingRemoved set, inside and outside kept (the cells are still the district's)
			if (o.rec().ext.get(DistrictLand.EXT_LAND) instanceof JsonObject land) {
				land.addProperty("standingRemoved", at);
			}
			save(o);
			Architect.LOGGER.info("Region {}: its join's end at region {} is dangling (the standing region was removed)", o.rec().id, id);
			SiteEvents.REGION_STATE.invoker().onState(view(o));
		}
	}

	/**
	 * (C23) Once per world, on its first tick (after the regions and the placement queue loaded): a region still REMOVING whose
	 * group has no removal in progress ends from its group's persisted state (a stop between the group's end and the region's
	 * record): the group REMOVED gives REMOVED with the group's time; otherwise PARTIAL (a retry resumes or restarts the removal).
	 */
	private static void reconcileRemovals() {
		for (Live l : List.copyOf(REGIONS.values())) {
			RegionState end = reconcileEnd(l.rec().state, l.rec().groupId, () -> dev.larattalabs.architect.site.Groups.removalRunning(l.rec().groupId),
				() -> {
					SiteGroupRec gr = Sites.group(l.rec().groupId);
					return gr == null ? null : gr.state();
				});
			if (end == null) {
				continue;
			}
			SiteGroupRec g = Sites.group(l.rec().groupId);
			boolean removed = end == RegionState.REMOVED;
			Architect.LOGGER.info("Region {} was REMOVING with no removal of group {} in progress: it ends {}", l.rec().id, l.rec().groupId,
				removed ? "REMOVED (the group is removed)" : "PARTIAL");
			finishRemoval(l, removed, removed && g.removedAt() > 0 ? g.removedAt() : System.currentTimeMillis(),
				"the world was loaded with the region REMOVING and no removal of its group in progress (remove it again)", false);
		}
	}

	/**
	 * (C23) {@link #reconcileRemovals}'s decision for one region (a table, unit-tested in RegionReconcileTest; docs/GATES.md "Fast checks
	 * P1"): null leaves it (not REMOVING, no group, or its group's removal still running); else REMOVED when the group's persisted state
	 * is REMOVED, PARTIAL otherwise. {@code running} and {@code groupState} are asked only for a REMOVING region with a group.
	 */
	static @Nullable RegionState reconcileEnd(RegionState state, @Nullable String groupId, java.util.function.BooleanSupplier running,
		java.util.function.Supplier<@Nullable String> groupState) {
		if (state != RegionState.REMOVING || groupId == null || running.getAsBoolean()) {
			return null;
		}
		return SiteGroupRec.REMOVED.equals(groupState.get()) ? RegionState.REMOVED : RegionState.PARTIAL;
	}

	private static volatile boolean reconcilePending;

	/** DevBridge (gate 10(a)): called after each tile entry of a region is placed, with the region's tiles done so far. */
	public static volatile java.util.function.@Nullable BiConsumer<Live, Integer> TILE_HOOK;

	/**
	 * DevBridge test hook (gate item 10(b), realise start): merges {@code members} into a held plan's IR (memory and the world's
	 * plan file), e.g. {@code {format: 3}} or {@code {kitVersion: "0.99.0"}}. False when there is no such plan.
	 */
	public static boolean doctorPlan(String planId, JsonObject members) {
		PlanRec p = planRec(planId);
		if (p == null) {
			return false;
		}
		members.entrySet().forEach(e -> p.ir().json().add(e.getKey(), e.getValue().deepCopy()));
		if (server != null) {
			savePlan(server, p);
		}
		return true;
	}

	/**
	 * DevBridge test hook (gate item 10(b), resume): merges {@code members} into a region's IR, in memory and in its
	 * {@code ir.json} (so a relog resumes it stale too). From then on its items wait PLAN_STALE. False when there is no such region.
	 */
	public static boolean doctorRegion(String regionId, JsonObject members) {
		Live l = REGIONS.get(regionId);
		if (l == null) {
			return false;
		}
		members.entrySet().forEach(e -> l.ir().json().add(e.getKey(), e.getValue().deepCopy()));
		try {
			RegionStore.writeJson(RegionStore.region(l.world(), regionId).resolve("ir.json"), l.ir().json());
		} catch (IOException e) {
			Architect.LOGGER.warn("Region {}: doctored ir.json not written: {}", regionId, e.toString());
		}
		String stale = staleOf(l);
		if (stale != null) {
			STALE_LOGGED.put(regionId, stale);
		}
		return true;
	}

	/** DevBridge: a plan's IR facts: requires, kitVersion, blobs, needVolumes, volumes (6b). */
	public static JsonObject planFacts(String planId) {
		JsonObject o = new JsonObject();
		PlanRec p = planRec(planId);
		if (p == null) {
			return o;
		}
		JsonArray req = new JsonArray();
		p.ir().requires().forEach(req::add);
		o.add("requires", req);
		o.addProperty("kitVersion", p.ir().kitVersion());
		JsonArray bl = new JsonArray();
		p.ir().blobShas().forEach(bl::add);
		o.add("blobs", bl);
		for (String k : new String[] {"needVolumes", "volumes", "checkMs", "renderMs"}) {
			if (p.planned().has(k)) {
				o.add(k, p.planned().get(k).deepCopy());
			}
		}
		return o;
	}

	/** (6b) The region ghost's view of a plan (stages up to {@code stage}; null: all), or null when there is no such plan. */
	public static @Nullable GhostPlan ghostPlan(String planId, @Nullable String stage) {
		PlanRec p = planRec(planId);
		return p == null ? null : GhostPlan.of(planId, p.irSha(), p.ir(), stage, p.planned());
	}

	/** The plan's claim {minX, minY, minZ, maxX, maxY, maxZ} (the IR's: its y range is the program's), or null. */
	public static int @Nullable [] planClaim(String planId) {
		PlanRec p = planRec(planId);
		return p == null ? null : p.ir().claim().clone();
	}

	/**
	 * Gate helper (DevBridge {@code dev.region.realise {fitLots}}): lot id -> the first of {@code entries}, starting at a rotating
	 * index for variety, whose footprint fits the lot (LotFitting, as realise will); a lot nothing fits stays a pad.
	 */
	public static Map<String, String> fitLots(String planId, List<String> entries) {
		Map<String, String> out = new LinkedHashMap<>();
		PlanRec p = planRec(planId);
		if (p == null || entries.isEmpty()) {
			return out;
		}
		int k = 0;
		for (Ir.Lot l : p.ir().lots()) {
			int[] b = l.box();
			for (int t = 0; t < entries.size(); t++) {
				String e = entries.get((k + t) % entries.size());
				Blueprint bp = Blueprints.get(e);
				// (release v0.42.0) an adopted build's entry is the player's house, never placed elsewhere (Sites refuses it ADOPT_REFUSED):
				// never a fill candidate
				Blueprints.Entry en = bp != null ? Blueprints.entry(e) : null;
				if (bp != null && (en == null || !Adopt.isAdoptedEntry(en.json())) && LotFitting.fit(bp, new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]), l.front(), true, 0, true).fits()
					&& bp.sizeY() <= b[4] - b[1] + 1) {
					out.put(l.id(), e);
					break;
				}
			}
			k++;
		}
		return out;
	}

	/** The lot ids of a plan (DevBridge: fill every lot round robin). */
	public static List<String> planLots(String planId) {
		PlanRec p = planRec(planId);
		List<String> out = new ArrayList<>();
		if (p != null) {
			p.ir().lots().forEach(l -> out.add(l.id()));
		}
		return out;
	}

	/** DevBridge {@code dev.region.state}: the view, the record, the queue's counts, starvation, streaming, generation. */
	public static JsonObject devState(String regionId) {
		Live l = REGIONS.get(regionId);
		JsonObject o = new JsonObject();
		if (l == null) {
			o.addProperty("missing", true);
			return o;
		}
		RegionView rv = view(l);
		o.add("view", com.google.gson.JsonParser.parseString(new com.google.gson.Gson().toJson(rv)).getAsJsonObject());
		o.add("actions", Wire6b.json(rv.actions())); // (6b) what a nudge can do about the wait
		String stale = staleOf(l);
		if (stale != null) {
			o.addProperty("stale", stale);
		}
		o.add("record", l.rec().toJson());
		QBatch b = Batches.get(l.rec().batchId);
		if (b != null) {
			Map<String, Integer> counts = new LinkedHashMap<>();
			Map<String, Integer> waits = new LinkedHashMap<>();
			JsonObject longWaits = new JsonObject();
			for (QItem i : b.items) {
				counts.merge(i.itemKind + ":" + i.status, 1, Integer::sum);
				if (i.status == QItem.Status.WAITING && i.reason != null) {
					waits.merge(i.reason, 1, Integer::sum);
				}
				if (i.status == QItem.Status.FAILED) {
					longWaits.addProperty(i.key, i.reason + ": " + i.message);
				}
			}
			JsonObject c = new JsonObject();
			counts.forEach(c::addProperty);
			o.add("items", c);
			JsonObject w = new JsonObject();
			waits.forEach(w::addProperty);
			o.add("waiting", w);
			// where the unfinished items are (the gate's configuration B walks the player there): key, status, reason, x, z
			com.google.gson.JsonArray at = new com.google.gson.JsonArray();
			for (QItem i : b.items) {
				if (i.status.terminal() || at.size() >= 40) {
					continue;
				}
				JsonObject e = new JsonObject();
				e.addProperty("key", i.key);
				e.addProperty("stage", i.stage);
				e.addProperty("status", i.status.name());
				if (i.reason != null) {
					e.addProperty("reason", i.reason);
				}
				int x = i.x;
				int z = i.z;
				if (i.key.startsWith("t:")) {
					String[] xz = i.key.substring(i.key.lastIndexOf(':') + 1).split(",");
					x = Integer.parseInt(xz[0]) * 64 + 32;
					z = Integer.parseInt(xz[1]) * 64 + 32;
				}
				e.addProperty("x", x);
				e.addProperty("z", z);
				at.add(e);
			}
			o.add("unfinished", at);
			o.add("failed", longWaits);
			o.addProperty("batchStatus", b.status.name());
		}
		o.addProperty("starvedTicks", RegionItems.starvedTicks);
		o.addProperty("maxHeldWaitSeconds", RegionItems.maxHeldWaitSeconds);
		JsonObject sw = new JsonObject();
		RegionItems.STARVED.forEach(sw::addProperty);
		o.add("starvedBy", sw);
		JsonObject lk = new JsonObject();
		RegionItems.LEAKS.forEach(lk::addProperty);
		o.add("ticketLeaks", lk);
		JsonObject tk = new JsonObject();
		var held = dev.larattalabs.architect.site.Batches.ticketsOf(l.rec().batchId);
		held.forEach((k, v) -> tk.addProperty(k, v));
		o.add("tickets", tk);
		// (fix/survival-off-storm) the chunks its tickets hold outside its claim + 2 chunks (the gate's bar: 0)
		int outside = 0;
		for (long c : dev.larattalabs.architect.site.Batches.ticketChunks(l.rec().batchId)) {
			if (!inClaimPlus2(l.rec().claim, net.minecraft.world.level.ChunkPos.getX(c), net.minecraft.world.level.ChunkPos.getZ(c))) {
				outside++;
			}
		}
		o.addProperty("ticketsOutsideClaim2", outside);
		o.addProperty("ticketBound", l.rec().maxChunks);
		com.google.gson.JsonArray lw = new com.google.gson.JsonArray();
		RegionItems.LONG_WAITS.forEach(lw::add);
		o.add("longWaits", lw);
		o.addProperty("chunkLoads", GenCounter.loads());
		o.addProperty("writerTicks", RegionItems.writerTicks);
		o.addProperty("generatedTerrain", GenCounter.terrain());
		o.addProperty("generatedWhileHeld", GenCounter.whileHeld());
		com.google.gson.JsonArray gd = new com.google.gson.JsonArray();
		generatedLog(regionId).stream().limit(50).forEach(gd::add);
		o.add("generatedDuringRealise", gd);
		o.addProperty("generatedDuringRealiseCount", l.rec().stats.has("generatedDuringRealise") ? l.rec().stats.get("generatedDuringRealise").getAsLong() : 0);
		o.addProperty("generatedElsewhere", generatedElsewhere);
		o.addProperty("tilesReceived", TileStream.RECEIVED.get());
		o.addProperty("wireBytes", TileStream.WIRE_BYTES.get());
		o.addProperty("wireCells", TileStream.WIRE_CELLS.get());
		o.addProperty("ticketsHeld", dev.larattalabs.architect.site.ChunkTickets.held());
		return o;
	}

	// ------------------------------------------------------------------ helpers

	static <T> CompletableFuture<T> onServer(MinecraftServer s, java.util.function.Supplier<T> f) {
		CompletableFuture<T> out = new CompletableFuture<>();
		Runnable r = () -> {
			try {
				out.complete(f.get());
			} catch (Throwable t) {
				out.completeExceptionally(t);
			}
		};
		if (s.isSameThread()) {
			r.run();
		} else {
			s.execute(r);
		}
		return out;
	}

	/** A refusal with its reason (the futures fail with it; {@link #reasonOf} reads it back). */
	public static final class RegionException extends dev.larattalabs.architect.api.RegionRefused {
		public final Reason reason;

		RegionException(Reason r, String msg) {
			super(r, msg);
			this.reason = r;
		}

		/** (VOC-c) With a detail (PALETTE: the rule id). */
		RegionException(Reason r, String msg, String detail) {
			super(r, msg, detail);
			this.reason = r;
		}
	}

	/** 6c 0c (C17): the refusal message when the claim {minX, minY, minZ, maxX, maxY, maxZ} touches a protected area of {@code owner}. */
	static @Nullable String protectedClaim(String dimension, @Nullable String owner, int[] claim) {
		return protectedClaim(dimension, owner, claim, java.util.Set.of());
	}

	/**
	 * 6c V: as above, except the areas whose exact rect {@code "x0,z0,x1,z1"} is in {@code honoured} (the IR's keepOut: the program
	 * was planned around them). An area marked or moved after the plan is not in it, so it still refuses.
	 */
	static @Nullable String protectedClaim(String dimension, @Nullable String owner, int[] claim, java.util.Set<String> honoured) {
		for (dev.larattalabs.architect.api.ProtectedArea a : dev.larattalabs.architect.site.Protected.of(dimension, owner)) {
			if (a.intersects(claim[0], claim[2], claim[3], claim[5]) && !honoured.contains(a.x0() + "," + a.z0() + "," + a.x1() + "," + a.z1())) {
				return dev.larattalabs.architect.site.Protected.message("The region's claim", a);
			}
		}
		return null;
	}

	/** 6c V: {@code region.plan}'s keepOut: the owner's areas that meet the claim, [[x0, z0, x1, z1]] sorted (as the kit sorts them). */
	static JsonArray keepOutOf(String dimension, @Nullable String owner, int[] claim) {
		return keepOutOf(dimension, owner, claim, true);
	}

	static JsonArray keepOutOf(String dimension, @Nullable String owner, int[] claim, boolean builds) {
		List<int[]> rects = new ArrayList<>();
		for (dev.larattalabs.architect.api.ProtectedArea a : dev.larattalabs.architect.site.Protected.of(dimension, owner)) {
			if (a.intersects(claim[0], claim[2], claim[3], claim[5])) {
				rects.add(new int[] {a.x0(), a.z0(), a.x1(), a.z1()});
			}
		}
		// (6c PT §7, S-PT-4) the players' builds in the claim are hard keep-outs: each build's bounds with a 1-cell margin, and each
		// door's apron (the 3 cells outside it)
		if (builds) {
			rects.addAll(dev.larattalabs.architect.placed.BuildViews.keepOut(dimension, claim));
		}
		rects.sort(java.util.Comparator.<int[]>comparingInt(q -> q[0]).thenComparingInt(q -> q[1]).thenComparingInt(q -> q[2]).thenComparingInt(q -> q[3]));
		JsonArray out = new JsonArray();
		String last = null;
		for (int[] q : rects) {
			String k = q[0] + "," + q[1] + "," + q[2] + "," + q[3];
			if (k.equals(last)) {
				continue;
			}
			last = k;
			JsonArray a = new JsonArray();
			for (int v : q) {
				a.add(v);
			}
			out.add(a);
		}
		return out;
	}

	/** 6c V: the rects an IR's program honoured ({@code keepOut}, as "x0,z0,x1,z1"); empty when it read none. */
	static java.util.Set<String> honoured(@Nullable JsonObject ir) {
		java.util.Set<String> out = new java.util.HashSet<>();
		if (ir != null && ir.get("keepOut") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonArray q && q.size() == 4) {
					out.add(q.get(0).getAsInt() + "," + q.get(1).getAsInt() + "," + q.get(2).getAsInt() + "," + q.get(3).getAsInt());
				}
			}
		}
		return out;
	}

	static RegionException refusal(Reason r, String msg) {
		return new RegionException(r, msg);
	}

	private static <T> CompletableFuture<T> failed(Reason r, String msg) {
		return CompletableFuture.failedFuture(new RegionException(r, msg));
	}

	static String str(JsonObject o, String k) {
		return str(o, k, "");
	}

	static String str(JsonObject o, String k, String def) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : def;
	}

	/** One chunk's generated status, read off the server thread (loaded chunks answer at once). */
	static final class ChunkStatusQ {
		final CompletableFuture<Boolean> future;

		private ChunkStatusQ(CompletableFuture<Boolean> f) {
			future = f;
		}

		static ChunkStatusQ of(ServerLevel level, long chunk) {
			ChunkGen.State st = ChunkGen.state(level, chunk);
			if (st == ChunkGen.State.GENERATED) {
				return new ChunkStatusQ(CompletableFuture.completedFuture(true));
			}
			return new ChunkStatusQ(ChunkGen.query(level, chunk));
		}
	}

}
