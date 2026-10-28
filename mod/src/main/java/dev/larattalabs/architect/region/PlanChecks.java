package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.PlanArtifact;
import dev.larattalabs.architect.api.PlanBudget;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.api.PreviewView;
import dev.larattalabs.architect.api.ProtectedArea;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RegionPreviews;
import dev.larattalabs.architect.api.RegionState;
import dev.larattalabs.architect.batch.BatchKeys;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.site.Protected;
import dev.larattalabs.architect.site.Sites;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (6c P0) Plan check v0 (docs/CONTRACT.md "Phase 6c slice P0: plan check v0"): {@link dev.larattalabs.architect.api.Regions#checkPlan}
 * runs the bundled {@code plan_v0} program over a resolution-1 survey of the claim (one region plan, the checker, the site plan only:
 * images on request), with the plan, the caller's anchors, every protected area and other owner's region meeting the claim (and their
 * fingerprint), the bible and the caps as its params; the kit answers each part and, READY or NEEDS_REPAIR, writes the resolved
 * artifact, which this class keeps world-side by its sha ({@code <world>/architect-regions/artifacts/}: {@code <sha>.json} the
 * canonical body, {@code <sha>.meta.json} its plan, {@code <sha>.pins.json} the owners pinning it, {@code <sha>.removed.json} a
 * tombstone). {@code realiseApproved} re-surveys the claim and refuses ARTIFACT_STALE on any changed column in the plan's tiles or a
 * changed protection fingerprint, then realises the artifact's own plan. Checks with a key are kept in {@code checks/<checkId>.json}
 * (found by key after a restart). Server thread unless noted.
 */
public final class PlanChecks {
	/** §7 / R9: a plan is at most this many characters as canonical JSON (more refuses FIELD_LIMIT). */
	public static final int PLAN_MAX_CHARS = 65536;
	public static final int ANCHORS_MAX = 64;
	static final Pattern ANCHOR = Pattern.compile("[a-z][a-z0-9_]{0,31}");
	static final Pattern SHA = Pattern.compile("[0-9a-f]{64}");
	/** The program a plan compiles through. */
	public static final String PROGRAM = "plan_v0";
	/** A check's sandbox gets its maxMs plus this (the kit's own deadline answers first; this only stops a runaway). */
	static final int GRACE_MS = 30_000;

	private record Running(String hash, CompletableFuture<PlanCheck> future) {
	}

	private record Keyed(String hash, String checkId) {
	}

	/** scope -> a check still running (its future: an in-flight twin shares it). */
	private static final Map<String, Running> RUNNING = new ConcurrentHashMap<>();
	/** scope -> a finished keyed check. */
	private static final Map<String, Keyed> KEYS = new ConcurrentHashMap<>();
	/** checkId -> a finished check (this session; the keyed ones are on disk too). */
	private static final Map<String, PlanCheck> CHECKS = new ConcurrentHashMap<>();
	private static final AtomicLong FAILED = new AtomicLong();
	private static volatile @Nullable MinecraftServer server;

	private PlanChecks() {
	}

	static Path root(Path world) {
		return RegionStore.root(world);
	}

	static Path artifacts(Path world) {
		return root(world).resolve("artifacts");
	}

	static Path checks(Path world) {
		return root(world).resolve("checks");
	}

	/** The world start: the keyed checks into the registry. */
	static void started(MinecraftServer s) {
		server = s;
		RUNNING.clear();
		KEYS.clear();
		CHECKS.clear();
		Path dir = checks(s.getWorldPath(LevelResource.ROOT));
		if (!Files.isDirectory(dir)) {
			return;
		}
		try (var st = Files.list(dir)) {
			for (Path f : st.filter(x -> x.getFileName().toString().endsWith(".json")).toList()) {
				try {
					JsonObject o = RegionStore.readJson(f);
					if (o != null && o.has("opKey") && o.has("opHash") && o.has("checkId")) {
						KEYS.put(RegionKeys.scope(o.has("owner") ? o.get("owner").getAsString() : null, "region.checkPlan", o.get("opKey").getAsString()),
							new Keyed(o.get("opHash").getAsString(), o.get("checkId").getAsString()));
					}
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Plan check {} unreadable: {}", f.getFileName(), e.toString());
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Plan checks unreadable: {}", e.toString());
		}
	}

	// ------------------------------------------------------------------ checkPlan

	static CompletableFuture<PlanCheck> check(PlanRequest r) {
		MinecraftServer s = r.level().getServer();
		server = s;
		String canonical;
		try {
			canonical = BatchKeys.canonical(r.plan());
		} catch (RuntimeException e) {
			return refused(Reason.FIELD_LIMIT, "plan: " + e.getMessage());
		}
		if (canonical.length() > PLAN_MAX_CHARS) {
			return refused(Reason.FIELD_LIMIT, "plan: " + canonical.length() + " characters as canonical JSON, at most " + PLAN_MAX_CHARS);
		}
		if (r.anchors().size() > ANCHORS_MAX) {
			return refused(Reason.FIELD_LIMIT, "anchors: " + r.anchors().size() + ", at most " + ANCHORS_MAX);
		}
		for (String a : r.anchors().keySet()) {
			if (!ANCHOR.matcher(a).matches()) {
				return refused(Reason.FIELD_LIMIT, "anchors: \"" + a + "\" is not [a-z][a-z0-9_]{0,31}");
			}
		}
		if (r.level().dimension() != Level.OVERWORLD) {
			return refused(Reason.NOT_ALLOWED, "regions are Overworld only in this version");
		}
		BoundingBox c = r.claim();
		if (c.getXSpan() > 1024 || c.getZSpan() > 1024) {
			return refused(Reason.REGION_LIMIT, "the claim is " + c.getXSpan() + "x" + c.getZSpan() + " columns (at most 1024x1024)");
		}
		PlanBudget budget = (r.budget() == null ? PlanBudget.defaults() : r.budget()).resolved();
		String key;
		try {
			key = dev.larattalabs.architect.apiimpl.Wire0a.opKey(r.opKey());
		} catch (IllegalArgumentException e) {
			return CompletableFuture.failedFuture(e);
		}
		if (key == null) {
			return check0(r, s, budget, null, null);
		}
		String hash = RegionKeys.hash(body(r, budget));
		String scope = RegionKeys.scope(r.owner(), "region.checkPlan", key);
		Keyed done = KEYS.get(scope);
		if (done != null) {
			if (!done.hash().equals(hash)) {
				return conflict(key, r.owner(), done.checkId());
			}
			PlanCheck pc = load(s, done.checkId());
			if (pc != null) {
				return CompletableFuture.completedFuture(pc);
			}
			KEYS.remove(scope); // its record is gone: the key is too
		}
		CompletableFuture<PlanCheck> mine = new CompletableFuture<>();
		Running[] prior = {null};
		RUNNING.compute(scope, (k, old) -> {
			prior[0] = old;
			return old != null ? old : new Running(hash, mine);
		});
		if (prior[0] != null) {
			return prior[0].hash().equals(hash) ? prior[0].future() : conflict(key, r.owner(), null);
		}
		CompletableFuture<PlanCheck> inner = check0(r, s, budget, key, hash);
		mine.whenComplete((v, e) -> {
			if (mine.isCancelled()) {
				inner.cancel(true); // nothing kept but the cache
			}
		});
		inner.whenComplete((v, e) -> {
			RUNNING.remove(scope, RUNNING.get(scope));
			if (e != null) {
				mine.completeExceptionally(unwrap(e));
			} else {
				if (!mine.isCancelled()) {
					KEYS.put(scope, new Keyed(hash, v.checkId()));
				}
				mine.complete(v);
			}
		});
		return mine;
	}

	/** The key's body: the plan, the claim's x/z, the anchors, the bible and the budget (§2). */
	static JsonObject body(PlanRequest r, PlanBudget b) {
		JsonObject o = new JsonObject();
		o.add("plan", r.plan());
		JsonArray c = new JsonArray();
		c.add(r.claim().minX());
		c.add(r.claim().minZ());
		c.add(r.claim().maxX());
		c.add(r.claim().maxZ());
		o.add("claim", c);
		o.add("anchors", anchorsJson(r.anchors()));
		if (r.bible() != null) {
			o.addProperty("bible", r.bible());
		}
		if (r.bibleVersion() != null) {
			o.addProperty("bibleVersion", r.bibleVersion());
		}
		o.add("budget", budgetJson(b));
		// (6c RS) a check in survival answers otherwise (its costs, its IR): its key's body says so (a creative check's hash is unchanged)
		if (r.level() != null && RegionSurvival.on(r.level().getServer())) {
			o.addProperty("survival", true);
		}
		// (6c T3) the load option only when it is not the default, so the keys of checks without it keep their hash
		if (r.load() != null && r.load().loads()) {
			JsonObject l = new JsonObject();
			l.addProperty("maxChunks", r.load().maxChunks());
			l.addProperty("generate", r.load().generate());
			o.add("load", l);
		}
		return o;
	}

	static boolean cancel(@Nullable String owner, String opKey) {
		String key = java.util.Objects.requireNonNull(dev.larattalabs.architect.apiimpl.Wire0a.opKey(opKey), "opKey");
		Running run = RUNNING.remove(RegionKeys.scope(owner, "region.checkPlan", key));
		return run != null && run.future().cancel(true);
	}

	static Optional<PlanCheck> byKey(@Nullable String owner, String opKey) {
		String key = java.util.Objects.requireNonNull(dev.larattalabs.architect.apiimpl.Wire0a.opKey(opKey), "opKey");
		Keyed k = KEYS.get(RegionKeys.scope(owner, "region.checkPlan", key));
		MinecraftServer s = server;
		if (k != null) {
			PlanRetention.touch(k.checkId()); // (6c close-out A) a lookup by key is a use of the check's plan
		}
		return k == null || s == null ? Optional.empty() : Optional.ofNullable(load(s, k.checkId()));
	}

	static CompletableFuture<RegionPreviews> images(String checkId, Set<PreviewView> views) {
		return RegionsImpl.INSTANCE.previews(checkId, views, List.of());
	}

	private static CompletableFuture<PlanCheck> check0(PlanRequest r, MinecraftServer s, PlanBudget budget, @Nullable String key, @Nullable String hash) {
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return refused(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		RegionsImpl.warnKitMismatch();
		BoundingBox c = r.claim();
		ServerLevel level = r.level();
		String dim = Sites.dimensionId(level);
		// (6d RV, §9.1) a revision of a realised plan: the region realised from the parent artifact (or a standing revision of it), the
		// parent the head's, the claim the region's; its parent's plan, built parts and geometry go to the kit with the revision input
		JsonObject revParent = null;
		RegionsImpl.Live revOf = null;
		if (r.plan().get("revision") instanceof JsonObject rvp && rvp.get("parentArtifact") instanceof JsonElement pae && pae.isJsonPrimitive()) {
			String pa = pae.getAsString();
			for (RegionsImpl.Live l : RegionsImpl.all()) {
				if (l.rec().state == RegionState.REMOVED || l.rec().state == RegionState.REMOVING) {
					continue;
				}
				boolean mine = pa.equals(artifactOf(l.rec())) || l.rec().revisions.stream().anyMatch(x -> pa.equals(x.artifact) && x.standing());
				if (mine) {
					revOf = l;
				}
			}
			if (revOf == null) {
				return refused(Reason.ARTIFACT_UNAPPROVED, "NO_FEATURE {why: parent}: no standing region was realised from artifact " + pa.substring(0, Math.min(12, pa
					.length())) + " (revision.parentArtifact)");
			}
			if (!java.util.Objects.equals(revOf.rec().owner, r.owner())) {
				return refused(Reason.OVERLAP_OWNED, "NO_FEATURE {why: parent}: region " + revOf.rec().id + " is " + (revOf.rec().owner == null ? "the player's" : revOf.rec().owner
					+ "'s"));
			}
			String head = Revisions.headArtifact(revOf.rec());
			if (!pa.equals(head)) {
				return refused(Reason.PLAN_STALE, "NEEDS_REPAIR parent_moved: artifact " + pa.substring(0, 12) + " is not region " + revOf.rec().id + "'s head; the head's artifact is "
					+ (head == null ? "none (its head revision was planned with planRevision)" : head));
			}
			Optional<PlanArtifact> pArt = artifact(pa);
			if (pArt.isEmpty() || pArt.get().body() == null) {
				return refused(Reason.ARTIFACT_UNAPPROVED, "NO_FEATURE {why: parent}: artifact " + pa.substring(0, 12) + " is gone");
			}
			revParent = Revisions.parentInput(revOf, pa, pArt.get().body());
			int[] rc = revOf.rec().claim;
			c = new BoundingBox(rc[0], rc[1], rc[2], rc[3], rc[4], rc[5]);
		}
		Protection prot = protection(dim, r.owner(), new int[] {c.minX(), c.minZ(), c.maxX(), c.maxZ()});
		JsonObject params = new JsonObject();
		params.add("plan", r.plan().deepCopy());
		JsonObject an = new JsonObject();
		an.add("anchors", anchorsJson(r.anchors()));
		params.add("anchors", an);
		JsonObject pa = new JsonObject();
		pa.add("areas", prot.areas());
		params.add("protected", pa);
		JsonObject rg = new JsonObject();
		rg.add("regions", prot.regions());
		params.add("regions", rg);
		// 6c PT: the players' builds meeting the claim (feature.build, target {build}, endpoint.build; kept out, S-PT-4)
		JsonObject bs = new JsonObject();
		bs.add("builds", dev.larattalabs.architect.placed.BuildViews.planJson(dim, new int[] {c.minX(), c.minY(), c.minZ(), c.maxX(), c.maxY(), c.maxZ()}));
		params.add("builds", bs);
		// (6c D1) the owner's standing regions beside the claim (within the seam's reach): endpoint.region ends past one of their street
		// ends inside the claim; their footprint is hard to the plan
		JsonArray standing = standingBeside(dim, r.owner(), new int[] {c.minX(), c.minZ(), c.maxX(), c.maxZ()});
		if (!standing.isEmpty()) {
			JsonObject sb = new JsonObject();
			sb.add("standing", standing);
			params.add("standing", sb);
		}
		params.add("budget", budgetJson(budget));
		if (r.bible() != null) {
			JsonObject b = new JsonObject();
			b.addProperty("id", r.bible());
			if (r.bibleVersion() != null) {
				b.addProperty("version", r.bibleVersion());
			}
			params.add("bible", b);
		}
		JsonObject fp = new JsonObject();
		fp.addProperty("sha", prot.sha());
		params.add("fingerprint", fp);
		JsonObject rpExt = new JsonObject();
		if (revOf != null) {
			JsonObject of = new JsonObject();
			of.addProperty("region", revOf.rec().id);
			rpExt.add(Revisions.EXT_REVISION_OF, of);
		}
		RegionPlanRequest rp = new RegionPlanRequest(PROGRAM, params, level, c, null, r.bible(), r.bibleVersion(), LoadPolicy.LOADED_ONLY, r.owner(), rpExt,
			null);
		if (revOf != null) {
			String[] no = Revisions.prepare(rp, s, revParent);
			if (no != null) {
				return refused(Reason.valueOf(no[0]), no[1]);
			}
		}
		final RegionsImpl.Live revRegion = revOf;
		JsonObject extra = new JsonObject();
		extra.addProperty("planCache", r.owner() == null ? "player" : r.owner());
		JsonArray views = new JsonArray();
		views.add("siteplan");
		extra.add("previewViews", views);
		extra.addProperty("timeoutMs", Math.min(600_000, budget.maxMs() + GRACE_MS));
		extra.addProperty("heapMb", Math.max(64, budget.maxHeapMb()));
		// (6c D2) the claim's biome grid (4x4, loaded chunks): a zone along a biome edge reads it
		extra.add("biomes", BiomeGrid.sample(level, c.minX(), c.minZ(), c.maxX(), c.maxZ()));
		// (6c VOC-c) a plan with a palette rule: the block histograms of the lots whose entry it names (the kit measures them at check time)
		JsonObject lotBlocks = PaletteRules.lotBlocks(r.plan());
		if (lotBlocks.size() > 0) {
			extra.add("lotBlocks", lotBlocks);
		}
		// (6c D3, §8) the reach inputs of each standing region an endpoint.region names (at most 2 per check)
		CompletableFuture<@Nullable Void> reachReady = CompletableFuture.completedFuture(null);
		java.util.Set<String> named = new java.util.TreeSet<>();
		endpointRegions(r.plan(), named);
		int nr = 0;
		for (String id : named) {
			RegionsImpl.Live st = RegionsImpl.live(id);
			if (st == null || nr >= 2 || !java.util.Objects.equals(st.rec().owner, r.owner()) || !st.rec().dimension.equals(dim) || RegionsImpl.besideBusy(st) != null) {
				continue;
			}
			nr++;
			int[] sc = st.rec().claim;
			int[] stc = {sc[0], sc[2], sc[3], sc[5]};
			reachReady = reachReady.thenCompose(v -> RegionsImpl.reachInputs(rp, st, stc, true));
			// ((7a GJ, §4) a wall region round it: its inputs too, within the 2 per check; the kit reads them only through a gate)
			RegionsImpl.Live wr = GateJoin.wallRegionRound(st);
			if (wr != null && nr < 2 && !named.contains(wr.rec().id)) {
				nr++;
				int[] wc = wr.rec().claim;
				int[] wrc = {wc[0], wc[2], wc[3], wc[5]};
				// (on the server thread: the previous region's blob upload completes elsewhere)
				reachReady = reachReady.thenCompose(v -> RegionsImpl.onServer(s, () -> RegionsImpl.reachInputs(rp, wr, wrc, true)).thenCompose(f -> f));
			}
		}
		CompletableFuture<PlanCheck> out = new CompletableFuture<>();
		RegionsImpl.progress(s, null, "planning");
		// (6c T3, Steward's S-T3-6) load: "generate" lets the survey and the tunnels' volume pass load (and generate) their chunks
		LoadPolicy load = r.load() != null && r.load().loads() ? r.load() : null;
		long t0 = System.nanoTime();
		final BoundingBox cc = c;
		reachReady.thenCompose(rv -> RegionSurvey.sample(level, cc.minX(), cc.minZ(), cc.maxX(), cc.maxZ(), 1, revRegion != null ? LoadPolicy.GENERATED_ONLY(4096) : load != null
			? load : LoadPolicy.LOADED_ONLY)).thenCompose(cols -> {
			if (revRegion != null) {
				Revisions.overlayFrozen(cols, s.getWorldPath(LevelResource.ROOT), revRegion.rec().id); // (6d RV) the region's frozen heights
			}
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> RegionsImpl.planOnce(link, rp, blobId, surveySha, survey, null, false, extra)
				.thenCompose(o -> secondPlan(link, rp, r, budget, extra, blobId, surveySha, survey, load, t0, o)));
		}).thenCompose(o -> RegionsImpl.onServer(s, () -> {
			if (out.isCancelled()) {
				return CompletableFuture.<PlanCheck>failedFuture(new CancellationException("cancelled"));
			}
			JsonObject planned = (JsonObject) o[0];
			return RegionsImpl.INSTANCE.finishPlan(rp, planned, (JsonObject) o[1], (byte[]) o[2], null, null).thenApply(plan -> {
				// the whole plan's chunks to generate (§3's cost; the kit can't see the world's generated chunks)
				if (planned.get("planCheck") instanceof JsonObject k && k.get("cost") instanceof JsonObject cost) {
					cost.addProperty("chunksToGenerate", plan.budget().chunksToGenerate());
					cost.addProperty("chunks", plan.budget().chunks());
					// (6c RS, §3) a survival check's whole bill: the bound lots' design bills and the 4e roads' (the game's to add)
					if (k.get("survival") instanceof JsonElement sv && sv.isJsonPrimitive() && sv.getAsBoolean()) {
						survivalBills(level, r, plan.planId(), cost);
					}
				}
				PlanCheck pc = fromPlanned(plan.planId(), planned);
				if (!out.isCancelled()) {
					keep(s, pc, planned, r, key, hash);
				}
				return pc;
			});
		})).thenCompose(f -> f).whenComplete((pc, e) -> {
			RegionsImpl.REACH.remove(rp);
			RegionsImpl.REACH_SURVEY.remove(rp);
			Revisions.INPUT.remove(rp);
			Revisions.CANDIDATE.remove(rp);
			Revisions.giveBack(rp, e != null);
			if (e == null) {
				out.complete(pc);
				return;
			}
			Throwable t = unwrap(e);
			String msg = String.valueOf(t.getMessage());
			// the sandbox's own limits: the check ran out of time or memory before any part had an answer
			String cap = msg.contains("took longer than") ? "maxMs" : msg.contains("ran out of memory") ? "maxHeapMb" : null;
			if (cap != null && !out.isCancelled()) {
				out.complete(incomplete(r.plan(), cap, msg));
			} else {
				out.completeExceptionally(t);
			}
		});
		return out;
	}

	/**
	 * (6c RS, §3) A survival check's plan bill completed by the game: each bound lot's design bill (its template's, C26's rules; the
	 * foundation and approach its pad leaves are known only at put-down, so the note says the lots are their templates) and each 4e
	 * road's bill (checkRoad's construction BOM over the land now), added to {@code cost.bom}; {@code cost.bomParts} names each addition.
	 */
	static void survivalBills(ServerLevel level, PlanRequest r, String planId, JsonObject cost) {
		JsonObject bom = cost.get("bom") instanceof JsonObject b ? b : new JsonObject();
		JsonObject parts = new JsonObject();
		java.util.function.BiConsumer<String, Map<String, Integer>> add = (what, items) -> {
			JsonObject o = new JsonObject();
			items.forEach((k, v) -> {
				o.addProperty(k, v);
				bom.addProperty(k, (bom.has(k) ? bom.get(k).getAsInt() : 0) + v);
			});
			parts.add(what, o);
		};
		RegionsImpl.PlanRec p = RegionsImpl.planRec(planId);
		int lots = 0;
		if (p != null) {
			Map<String, String> entries = PaletteRules.boundLots(r.plan());
			for (var e : entries.entrySet()) {
				String bpId = e.getValue().contains("@") ? e.getValue().substring(0, e.getValue().indexOf('@')) : e.getValue();
				var grid = dev.larattalabs.architect.placement.TemplateGrid.of(bpId);
				if (grid != null) {
					add.accept("lot:" + e.getKey(), dev.larattalabs.architect.site.Builder.templateBom(grid));
					lots++;
				}
			}
			for (Ir.Road road : p.ir().roads()) {
				List<net.minecraft.core.BlockPos> pts = new ArrayList<>();
				road.points().forEach(pt -> pts.add(new net.minecraft.core.BlockPos(pt[0], pt[1], pt[2])));
				try {
					var c = dev.larattalabs.architect.site.InfraPlace.checkRoad(level, pts, road.width(), road.surface(), null, road.lanterns(), false, p.owner(),
						true, true, null, road.lamp(), null);
					if (c.ok()) {
						add.accept("road:" + road.id(), dev.larattalabs.architect.site.RoadBuilder.bom(level, c.positions(), c.values()));
					}
				} catch (RuntimeException e) {
					Architect.LOGGER.warn("Plan check: road {}'s bill could not be read: {}", road.id(), e.toString());
				}
			}
		}
		JsonObject sorted = new JsonObject();
		bom.entrySet().stream().sorted(Map.Entry.comparingByKey()).forEach(e -> sorted.add(e.getKey(), e.getValue()));
		cost.add("bom", sorted);
		cost.add("bomParts", parts);
		cost.addProperty("bomNote", "the regions' cells, " + lots + " bound lot" + (lots == 1 ? "" : "s") + " (their designs' template bills: the foundation and "
			+ "approach are known when the lot is put down) and the 4e roads' bills (checkRoad's, over the land now)");
	}

	/** (6c T3) The last check's volume pass (DevBridge {@code dev.region.checkPlan}'s {@code volumePass}; gate item 14, recorded). */
	public static volatile @Nullable JsonObject lastVolumePass;

	/** (7a RK §3) The connector kinds whose check plans twice for their corridor's frozen volume: a tunnel's and a rock stair's. */
	static final java.util.Set<String> VOLUME_CONNECTORS = java.util.Set.of("tunnel", "rock_stair");

	/**
	 * Whether a plan has a part of connector kind {@code tunnel} (only those ask for volumes in a check, CONTRACT T3 §6), or (7a RK §3,
	 * F3's {@code hasVolume}) {@code rock_stair}.
	 */
	static boolean hasTunnel(JsonObject plan) {
		if (plan.get("connectors") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject p && p.get("kind") instanceof JsonElement k && k.isJsonPrimitive() && VOLUME_CONNECTORS.contains(k.getAsString())) {
					return true;
				}
			}
		}
		return false;
	}

	/** (6c F3 §3.3) The cave forms: their sites read a frozen volume (a ceiling, its floor), so a check plans them twice as a tunnel's. */
	static final java.util.Set<String> CAVE_KINDS = java.util.Set.of("stalactites", "roots");

	/** (6c F3 §3.3) Whether a plan has a cave form part ({@link #CAVE_KINDS}): with a tunnel or an H part it makes a check plan twice. */
	static boolean hasCaveForm(JsonObject plan) {
		if (plan.get("forms") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject p && p.get("kind") instanceof JsonElement k && k.isJsonPrimitive() && CAVE_KINDS.contains(k.getAsString())) {
					return true;
				}
			}
		}
		return false;
	}

	/** (6c H §10) The kinds whose parts ask fluid volumes in a check: the bodies (pond, fountain, waterfall, the moat channel) and the quay. */
	static final java.util.Set<String> H_KINDS = java.util.Set.of("pond", "fountain", "waterfall", "quay", "channel");

	/**
	 * (6c H §10) Whether a plan has an H part: a form or connector of an {@link #H_KINDS} kind, or a zone or lot with {@code farmPond: true}
	 * (S-H-2). With a tunnel part (T3b) or a wet fallback ({@link #wetAsked}) it is what makes a check plan twice.
	 */
	static boolean hasH(JsonObject plan) {
		for (String fam : new String[] {"forms", "connectors"}) {
			if (plan.get(fam) instanceof JsonArray a) {
				for (JsonElement e : a) {
					if (e instanceof JsonObject p && p.get("kind") instanceof JsonElement k && k.isJsonPrimitive() && H_KINDS.contains(k.getAsString())) {
						return true;
					}
				}
			}
		}
		return farmPond(plan.get("zones")) || irrigate(plan.get("zones")); // ((6c IRR) irrigate: true asks its sources' volumes too)
	}

	/**
	 * (6c H, S-H-2) A farm pond is an opt-in body with no part of its own: {@code farmPond: true} on a zone, or on a lot at any depth under
	 * the zones (a zone's program lots, a district's lots).
	 */
	static boolean farmPond(@Nullable JsonElement e) {
		return trueMember(e, "farmPond");
	}

	/**
	 * (6c IRR, §7) Irrigation is an opt-in body with no part of its own, as a farm pond: {@code irrigate: true} on a zone, or on a lot at
	 * any depth under the zones (a zone's program lots, its template's params.lots, a district's lots).
	 */
	static boolean irrigate(@Nullable JsonElement e) {
		return trueMember(e, "irrigate");
	}

	/** Whether {@code name: true} (a JSON boolean, never a string) stands on any object at any depth of {@code e}. */
	private static boolean trueMember(@Nullable JsonElement e, String name) {
		if (e instanceof JsonObject o) {
			if (o.get(name) instanceof JsonElement f && f.isJsonPrimitive() && f.getAsJsonPrimitive().isBoolean() && f.getAsBoolean()) {
				return true;
			}
			for (var en : o.entrySet()) {
				if (trueMember(en.getValue(), name)) {
					return true;
				}
			}
		} else if (e instanceof JsonArray a) {
			for (JsonElement x : a) {
				if (trueMember(x, name)) {
					return true;
				}
			}
		}
		return false;
	}

	/** (6c H §10) Whether the first plan took the wet fallback somewhere (its check's {@code wetAsked}: the kit's meta.wet records, a pier, a harbour wall or a quay in water). */
	static boolean wetAsked(JsonObject planned) {
		return planned.get("planCheck") instanceof JsonObject k && k.get("wetAsked") instanceof JsonElement w && w.isJsonPrimitive() && w.getAsBoolean();
	}

	/**
	 * (6c T3 §6) The check's two-plan flow: a plan with a tunnel part whose first plan asked for volumes (the tunnels' corridors) has
	 * them sampled ({@link RegionsImpl#volumesFor}, under the check's {@code load}) and is planned again with them; the answers come
	 * from the second plan. The budget covers both: the second plan's sandbox gets the time left (its params, so the IR and the
	 * artifact, are unchanged). Volumes not available (chunks not generated or not loaded under "loaded", or over the region's
	 * volume limit): the first plan stands, its tunnels {@code incomplete VOLUME}, with a note. A plan without a tunnel part plans
	 * once, as before.
	 */
	private static CompletableFuture<Object[]> secondPlan(TileStream.Link link, RegionPlanRequest rp, PlanRequest r, PlanBudget budget, JsonObject extra,
		String blobId, String surveySha, byte[] survey, @Nullable LoadPolicy load, long t0, Object[] first) {
		JsonObject planned = (JsonObject) first[0];
		JsonArray need = planned.get("needVolumes") instanceof JsonArray a ? a : new JsonArray();
		if (need.isEmpty() || !(hasTunnel(r.plan()) || hasH(r.plan()) || hasCaveForm(r.plan()) || wetAsked(planned))) {
			lastVolumePass = null;
			return CompletableFuture.completedFuture(first);
		}
		long cells = 0;
		for (JsonElement e : need) {
			JsonObject b = e.getAsJsonObject();
			cells += (long) (b.get("maxX").getAsInt() - b.get("minX").getAsInt() + 1) * (b.get("maxY").getAsInt() - b.get("minY").getAsInt() + 1) * (b.get("maxZ")
				.getAsInt() - b.get("minZ").getAsInt() + 1);
		}
		long nCells = cells;
		long tv = System.nanoTime();
		return RegionsImpl.volumesFor(r.level(), need, load).handle((vols, e) -> {
			double volMs = (System.nanoTime() - tv) / 1e6;
			JsonObject vp = new JsonObject();
			vp.addProperty("asked", need.size());
			vp.addProperty("cells", nCells);
			vp.addProperty("sampleMs", volMs);
			vp.addProperty("firstPlanMs", (tv - t0) / 1e6);
			vp.addProperty("load", load == null ? "loaded" : "generate");
			if (e != null || vols == null) {
				String why = e != null ? String.valueOf(unwrap(e).getMessage()) : "chunks not " + (load == null ? "loaded or not generated" : "generated");
				vp.addProperty("read", 0);
				vp.addProperty("why", why);
				lastVolumePass = vp;
				checkNote(planned, (hasTunnel(r.plan()) ? "the tunnels" : hasCaveForm(r.plan()) && !hasH(r.plan()) ? "the cave forms" : "the plan's water") + " asked for " + need.size() + " volume" + (need.size() == 1 ? "" : "s") + " (" + nCells + " cells) that could not be read ("
					+ why + "): prepare (or check with load: \"generate\"), then check again");
				Architect.LOGGER.info("Plan check: volume pass not read ({}), {} boxes, {} cells", why, need.size(), nCells);
				return CompletableFuture.completedFuture(first);
			}
			long left = Math.max(1_000L, budget.maxMs() - (System.nanoTime() - t0) / 1_000_000L);
			JsonObject extra2 = extra.deepCopy();
			extra2.addProperty("timeoutMs", Math.min(600_000L, left + GRACE_MS));
			long t2 = System.nanoTime();
			return RegionsImpl.planOnce(link, rp, blobId, surveySha, survey, vols, false, extra2).thenApply(o2 -> {
				JsonObject p2 = (JsonObject) o2[0];
				p2.add("volumes", vols);
				checkNote(p2, "read " + vols.size() + " frozen volume" + (vols.size() == 1 ? "" : "s") + " (two-plan flow)");
				vp.addProperty("read", vols.size());
				vp.addProperty("secondPlanMs", (System.nanoTime() - t2) / 1e6);
				lastVolumePass = vp;
				Architect.LOGGER.info("Plan check: read {} volumes ({} cells) in {} ms, second plan {} ms", vols.size(), nCells, Math.round(volMs), Math.round(
					(System.nanoTime() - t2) / 1e6));
				return o2;
			});
		}).thenCompose(f -> f);
	}

	/** A note on a check's answer ({@code planCheck.notes}, which the PlanCheck carries; not in the artifact). */
	private static void checkNote(JsonObject planned, String note) {
		if (planned.get("planCheck") instanceof JsonObject k) {
			JsonArray n = k.get("notes") instanceof JsonArray a ? a : new JsonArray();
			n.add(note);
			k.add("notes", n);
		}
		RegionsImpl.addNote(planned, note);
	}

	/** A check the sandbox stopped (time or heap): every part incomplete, no artifact, nothing kept. */
	static PlanCheck incomplete(JsonObject plan, String cap, String why) {
		List<JsonObject> parts = new ArrayList<>();
		for (String fam : List.of("zones", "connectors", "forms", "rules")) {
			if (plan.get(fam) instanceof JsonArray a) {
				for (JsonElement e : a) {
					if (e instanceof JsonObject p && p.get("id") instanceof JsonElement id && id.isJsonPrimitive()) {
						JsonObject o = new JsonObject();
						o.addProperty("part", id.getAsString());
						o.addProperty("class", "incomplete");
						JsonArray rs = new JsonArray();
						JsonObject rr = new JsonObject();
						rr.addProperty("code", "BUDGET");
						rr.addProperty("message", "the check ran out of " + cap + " (" + why + ")");
						JsonObject ev = new JsonObject();
						ev.addProperty("cap", cap);
						rr.add("evidence", ev);
						rs.add(rr);
						o.add("reasons", rs);
						parts.add(o);
					}
				}
			}
		}
		return new PlanCheck("check-" + FAILED.incrementAndGet(), BatchKeys.sha256(BatchKeys.canonical(plan)), "", IrStale.KIT_VERSION, "plan/0",
			PlanCheck.Overall.INCOMPLETE, parts, new JsonObject(), new JsonObject(), new JsonObject(), null, List.of("the check stopped: " + why));
	}

	/** The kit's answer in {@code region.planned.planCheck} as a PlanCheck. */
	static PlanCheck fromPlanned(String planId, JsonObject planned) {
		JsonObject k = planned.get("planCheck") instanceof JsonObject o ? o : new JsonObject();
		List<JsonObject> parts = new ArrayList<>();
		if (k.get("parts") instanceof JsonArray a) {
			a.forEach(e -> parts.add(e.getAsJsonObject().deepCopy()));
		}
		JsonObject preview = k.get("preview") instanceof JsonObject p ? p.deepCopy() : new JsonObject();
		if (planned.get("sitePlan") instanceof JsonObject sp) {
			preview.add("siteplan", sp.deepCopy());
		}
		if (planned.get("previews") instanceof JsonObject pv && pv.get("siteplan") instanceof JsonArray files) {
			preview.add("siteplanImages", files.deepCopy());
		}
		List<String> notes = new ArrayList<>();
		if (k.get("notes") instanceof JsonArray n) {
			n.forEach(e -> notes.add(e.isJsonPrimitive() ? e.getAsString() : e.toString()));
		}
		if (k.get("malformed") instanceof JsonObject m) {
			notes.add("malformed: " + m);
		}
		PlanCheck.Overall overall;
		try {
			overall = PlanCheck.Overall.valueOf(RegionsImpl.str(k, "overall", "MALFORMED"));
		} catch (IllegalArgumentException e) {
			overall = PlanCheck.Overall.MALFORMED;
		}
		JsonObject cost = k.get("cost") instanceof JsonObject co ? co.deepCopy() : new JsonObject();
		if (k.get("malformed") instanceof JsonObject m) {
			preview.add("malformed", m.deepCopy());
		}
		return new PlanCheck(planId, RegionsImpl.str(k, "planSha", ""), RegionsImpl.str(planned, "surveySha", RegionsImpl.str(k, "surveySha", "")),
			RegionsImpl.str(k, "kitVersion", RegionsImpl.str(planned, "kitVersion", "")), RegionsImpl.str(k, "schemaVersion", "plan/0"), overall, parts, cost,
			k.get("catalogue") instanceof JsonObject cat ? cat.deepCopy() : new JsonObject(), preview, k.get("artifactSha") instanceof JsonElement a
				&& a.isJsonPrimitive() ? a.getAsString() : null, notes, k.get("survival") instanceof JsonElement sv && sv.isJsonPrimitive() && sv.getAsBoolean());
	}

	/** Keeps a finished check: the artifact (its canonical body checked against its sha) and, with a key, the check's record. */
	private static void keep(MinecraftServer s, PlanCheck pc, JsonObject planned, PlanRequest r, @Nullable String key, @Nullable String hash) {
		CHECKS.put(pc.checkId(), pc);
		Path w = s.getWorldPath(LevelResource.ROOT);
		JsonObject k = planned.get("planCheck") instanceof JsonObject o ? o : new JsonObject();
		try {
			if (pc.artifactSha() != null && k.get("artifact") instanceof JsonElement a && a.isJsonPrimitive()) {
				byte[] body = a.getAsString().getBytes(StandardCharsets.UTF_8);
				String sha = Packed.sha256(body);
				if (!sha.equals(pc.artifactSha())) {
					throw new IOException("the artifact hashes to " + sha + ", not " + pc.artifactSha());
				}
				Path dir = artifacts(w);
				Files.createDirectories(dir);
				Path f = dir.resolve(sha + ".json");
				if (!Files.isRegularFile(f)) {
					RegionStore.write(f, body);
				}
				Files.deleteIfExists(dir.resolve(sha + ".removed.json")); // checked again: a removed artifact comes back
				JsonObject meta = new JsonObject();
				meta.addProperty("planId", pc.checkId());
				if (r.owner() != null) {
					meta.addProperty("owner", r.owner());
				}
				meta.addProperty("dimension", Sites.dimensionId(r.level()));
				meta.addProperty("createdAt", System.currentTimeMillis());
				RegionStore.writeJson(dir.resolve(sha + ".meta.json"), meta);
			}
			if (key != null) {
				JsonObject rec = new JsonObject();
				rec.addProperty("checkId", pc.checkId());
				if (r.owner() != null) {
					rec.addProperty("owner", r.owner());
				}
				rec.addProperty("opKey", key);
				rec.addProperty("opHash", hash);
				rec.add("check", toJson(pc));
				Files.createDirectories(checks(w));
				RegionStore.writeJson(checks(w).resolve(pc.checkId() + ".json"), rec);
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Plan check {} could not be kept: {}", pc.checkId(), e.toString());
		}
	}

	static JsonObject toJson(PlanCheck pc) {
		JsonObject o = new JsonObject();
		o.addProperty("checkId", pc.checkId());
		o.addProperty("planSha", pc.planSha());
		o.addProperty("surveySha", pc.surveySha());
		o.addProperty("kitVersion", pc.kitVersion());
		o.addProperty("schemaVersion", pc.schemaVersion());
		o.addProperty("overall", pc.overall().name());
		JsonArray parts = new JsonArray();
		pc.parts().forEach(p -> parts.add(p.deepCopy()));
		o.add("parts", parts);
		o.add("cost", pc.cost().deepCopy());
		o.add("catalogue", pc.catalogue().deepCopy());
		o.add("preview", pc.preview().deepCopy());
		if (pc.artifactSha() != null) {
			o.addProperty("artifactSha", pc.artifactSha());
		}
		JsonArray n = new JsonArray();
		pc.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static PlanCheck fromJson(JsonObject o) {
		List<JsonObject> parts = new ArrayList<>();
		if (o.get("parts") instanceof JsonArray a) {
			a.forEach(e -> parts.add(e.getAsJsonObject()));
		}
		List<String> notes = new ArrayList<>();
		if (o.get("notes") instanceof JsonArray a) {
			a.forEach(e -> notes.add(e.getAsString()));
		}
		return new PlanCheck(RegionsImpl.str(o, "checkId"), RegionsImpl.str(o, "planSha"), RegionsImpl.str(o, "surveySha"), RegionsImpl.str(o, "kitVersion"),
			RegionsImpl.str(o, "schemaVersion", "plan/0"), PlanCheck.Overall.valueOf(RegionsImpl.str(o, "overall", "MALFORMED")), parts,
			o.get("cost") instanceof JsonObject c ? c : null, o.get("catalogue") instanceof JsonObject c ? c : null, o.get("preview") instanceof JsonObject p ? p : null,
			o.has("artifactSha") ? o.get("artifactSha").getAsString() : null, notes);
	}

	private static @Nullable PlanCheck load(MinecraftServer s, String checkId) {
		PlanCheck pc = CHECKS.get(checkId);
		if (pc != null) {
			return pc;
		}
		try {
			JsonObject rec = RegionStore.readJson(checks(s.getWorldPath(LevelResource.ROOT)).resolve(checkId + ".json"));
			if (rec != null && rec.get("check") instanceof JsonObject c) {
				pc = fromJson(c);
				CHECKS.put(checkId, pc);
				return pc;
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Plan check {} unreadable: {}", checkId, e.toString());
		}
		return null;
	}

	// ------------------------------------------------------------------ protection: the areas and regions meeting a claim, and their sha

	/** {@code areas}: [{id, owner, rect}] (every owner's), {@code regions}: [{id, owner, rect}] (other owners' standing regions), both sorted. */
	record Protection(JsonArray areas, JsonArray regions, String sha) {
	}

	static Protection protection(String dimension, @Nullable String owner, int[] xz) {
		TreeMap<String, JsonObject> areas = new TreeMap<>();
		for (ProtectedArea a : Protected.list(null)) {
			if (!a.dimension().identifier().toString().equals(dimension) || !a.intersects(xz[0], xz[1], xz[2], xz[3])) {
				continue;
			}
			JsonObject o = new JsonObject();
			o.addProperty("id", a.id());
			o.addProperty("owner", a.owner());
			o.add("rect", rect(a.x0(), a.z0(), a.x1(), a.z1()));
			areas.put(a.owner() + "\u0000" + a.id(), o);
		}
		TreeMap<String, JsonObject> regions = new TreeMap<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			var rec = l.rec();
			if (rec.state == RegionState.REMOVED || rec.state == RegionState.REMOVING || java.util.Objects.equals(rec.owner, owner) || !rec.dimension.equals(dimension)) {
				continue;
			}
			int[] c = rec.claim;
			if (c[0] > xz[2] || c[3] < xz[0] || c[2] > xz[3] || c[5] < xz[1]) {
				continue;
			}
			JsonObject o = new JsonObject();
			o.addProperty("id", rec.id);
			if (rec.owner != null) {
				o.addProperty("owner", rec.owner);
			}
			o.add("rect", rect(c[0], c[2], c[3], c[5]));
			// (6c D3, §9) another owner's district's reach: hard as its rect is
			if (l.ir().json().get("reach") instanceof JsonObject reach && reach.get("runs") instanceof JsonArray runs) {
				o.add("reach", runs.deepCopy());
			}
			regions.put(rec.id, o);
		}
		JsonArray a = new JsonArray(), g = new JsonArray();
		areas.values().forEach(a::add);
		regions.values().forEach(g::add);
		JsonObject all = new JsonObject();
		all.add("areas", a);
		all.add("regions", g);
		return new Protection(a, g, BatchKeys.sha256(BatchKeys.canonical(all)));
	}

	/** (6c D3) The region ids every {@code {region: id}} endpoint of a plan's connectors names. */
	static void endpointRegions(@Nullable JsonElement e, java.util.Set<String> out) {
		if (e instanceof JsonObject o) {
			if (o.get("region") instanceof JsonElement v && v.isJsonPrimitive() && v.getAsJsonPrimitive().isString() && o.size() <= 2) {
				out.add(v.getAsString());
			}
			o.entrySet().forEach(x -> endpointRegions(x.getValue(), out));
		} else if (e instanceof JsonArray a) {
			a.forEach(x -> endpointRegions(x, out));
		}
	}

	/** (6c D1) The owner's standing regions within {@link BesideCheck#SEAM_MAX} of a claim, as {@code beside} data, by id. */
	static JsonArray standingBeside(String dimension, @Nullable String owner, int[] xz) {
		TreeMap<String, JsonObject> out = new TreeMap<>();
		int m = BesideCheck.SEAM_MAX;
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			var rec = l.rec();
			if (rec.state == RegionState.REMOVED || rec.state == RegionState.REMOVING || !java.util.Objects.equals(rec.owner, owner) || !rec.dimension.equals(dimension)) {
				continue;
			}
			int[] c = rec.claim;
			if (c[0] > xz[2] + m || c[3] < xz[0] - m || c[2] > xz[3] + m || c[5] < xz[1] - m) {
				continue;
			}
			JsonObject bd = BesideCheck.besideData(rec.id, new int[] {c[0], c[2], c[3], c[5]}, Revisions.effective(l), xz); // (6d RV, §4.5)
			// (6c D3, §9) a district's reach (its join in a town's claim): hard to every later plan
			if (l.ir().json().get("reach") instanceof JsonObject reach && reach.get("runs") instanceof JsonArray runs) {
				bd.add("reach", runs.deepCopy());
			}
			out.put(rec.id, bd);
		}
		JsonArray a = new JsonArray();
		out.values().forEach(a::add);
		return a;
	}

	private static JsonArray rect(int x0, int z0, int x1, int z1) {
		JsonArray r = new JsonArray();
		r.add(x0);
		r.add(z0);
		r.add(x1);
		r.add(z1);
		return r;
	}

	static JsonObject anchorsJson(Map<String, BlockPos> anchors) {
		JsonObject o = new JsonObject();
		new TreeMap<>(anchors).forEach((k, v) -> {
			JsonArray a = new JsonArray();
			a.add(v.getX());
			a.add(v.getY());
			a.add(v.getZ());
			o.add(k, a);
		});
		return o;
	}

	static JsonObject budgetJson(PlanBudget b) {
		JsonObject o = new JsonObject();
		o.addProperty("maxNodes", b.maxNodes());
		o.addProperty("maxEdges", b.maxEdges());
		o.addProperty("maxCells", b.maxCells());
		o.addProperty("maxMs", b.maxMs());
		o.addProperty("maxHeapMb", b.maxHeapMb());
		return o;
	}

	// ------------------------------------------------------------------ artifacts: retention, pins, tombstones

	static Optional<PlanArtifact> artifact(String sha) {
		MinecraftServer s = server;
		if (s == null || !SHA.matcher(sha).matches()) {
			return Optional.empty();
		}
		Path dir = artifacts(s.getWorldPath(LevelResource.ROOT));
		try {
			JsonObject meta = RegionStore.readJson(dir.resolve(sha + ".meta.json"));
			String planId = meta == null ? "" : RegionsImpl.str(meta, "planId", "");
			Set<String> pins = pins(dir, sha);
			Set<String> regions = regionsOf(sha);
			Path f = dir.resolve(sha + ".json");
			if (Files.isRegularFile(f)) {
				JsonObject body = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
				return Optional.of(new PlanArtifact(sha, body, planId, pins, regions, false, 0));
			}
			JsonObject tomb = RegionStore.readJson(dir.resolve(sha + ".removed.json"));
			if (tomb != null) {
				return Optional.of(new PlanArtifact(sha, null, planId, Set.of(), regions, true, tomb.get("removedAt").getAsLong()));
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Artifact {} unreadable: {}", sha, e.toString());
		}
		return Optional.empty();
	}

	/** Every owner pinning the artifact: its plain pins, then (6c close-out A) its keyed pins' owners. */
	private static Set<String> pins(Path dir, String sha) throws IOException {
		Set<String> out = plainPins(dir, sha);
		for (JsonObject k : keyedPins(dir, sha)) {
			out.add(k.get("owner").getAsString());
		}
		return out;
	}

	private static Set<String> plainPins(Path dir, String sha) throws IOException {
		Set<String> out = new LinkedHashSet<>();
		JsonObject p = RegionStore.readJson(dir.resolve(sha + ".pins.json"));
		if (p != null && p.get("owners") instanceof JsonArray a) {
			a.forEach(e -> out.add(e.getAsString()));
		}
		return out;
	}

	/** (6c close-out A, §2) The artifact's keyed pins: {@code [{owner, opKey, at}]} ({@code at}: the pin's last use). */
	private static List<JsonObject> keyedPins(Path dir, String sha) throws IOException {
		List<JsonObject> out = new ArrayList<>();
		JsonObject p = RegionStore.readJson(dir.resolve(sha + ".pins.json"));
		if (p != null && p.get("keyed") instanceof JsonArray a) {
			for (JsonElement e : a) {
				if (e instanceof JsonObject o && o.get("owner") instanceof JsonElement ow && ow.isJsonPrimitive() && o.get("opKey") instanceof JsonElement k
					&& k.isJsonPrimitive()) {
					out.add(o);
				}
			}
		}
		return out;
	}

	/** Writes the pins file: {@code owners} (sorted) and, when there are any, {@code keyed} (sorted by owner then key). */
	private static void writePins(Path dir, String sha, Set<String> owners, List<JsonObject> keyed) throws IOException {
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		owners.stream().sorted().forEach(a::add);
		o.add("owners", a);
		if (!keyed.isEmpty()) {
			JsonArray k = new JsonArray();
			keyed.stream().sorted(java.util.Comparator.<JsonObject, String>comparing(x -> x.get("owner").getAsString()).thenComparing(x -> x.get("opKey")
				.getAsString())).forEach(k::add);
			o.add("keyed", k);
		}
		RegionStore.writeJson(dir.resolve(sha + ".pins.json"), o);
	}

	/** The artifacts' shas with a pins file. */
	private static List<String> pinned(Path dir) throws IOException {
		if (!Files.isDirectory(dir)) {
			return List.of();
		}
		try (var st = Files.list(dir)) {
			return st.map(x -> x.getFileName().toString()).filter(n -> n.endsWith(".pins.json")).map(n -> n.substring(0, n.length() - ".pins.json".length()))
				.filter(x -> SHA.matcher(x).matches()).sorted().toList();
		}
	}

	/** The plan an artifact realises from (its meta's planId), or null. */
	private static @Nullable String planOf(Path dir, String sha) throws IOException {
		JsonObject meta = RegionStore.readJson(dir.resolve(sha + ".meta.json"));
		return meta == null || !meta.has("planId") ? null : meta.get("planId").getAsString();
	}

	/**
	 * (6c close-out A, §2) A keyed pin: {@code (owner, opKey)} holds the artifact until the key's realise ({@link #keyRealised}), an
	 * unpin, or the world-start sweep {@link PlanRetention#KEYED_MS} after its last use. A re-pin refreshes its last use. Server thread.
	 */
	static void pinKeyed(String sha, String owner, String opKey) {
		MinecraftServer s = server;
		String key = dev.larattalabs.architect.apiimpl.Wire0a.opKey(opKey);
		if (s != null) {
			pinKeyedAt(s.getWorldPath(LevelResource.ROOT), sha, owner, key);
		}
	}

	/** {@link #pinKeyed} in a world dir (tests). */
	static void pinKeyedAt(Path world, String sha, @Nullable String owner, @Nullable String key) {
		if (key == null || !SHA.matcher(sha).matches() || owner == null || owner.isBlank()) {
			return;
		}
		Path dir = artifacts(world);
		try {
			if (!Files.isRegularFile(dir.resolve(sha + ".json"))) {
				return; // unknown or removed: nothing to pin (idempotent)
			}
			List<JsonObject> keyed = new ArrayList<>(keyedPins(dir, sha));
			keyed.removeIf(k -> owner.equals(k.get("owner").getAsString()) && key.equals(k.get("opKey").getAsString()));
			JsonObject k = new JsonObject();
			k.addProperty("owner", owner);
			k.addProperty("opKey", key);
			k.addProperty("at", PlanRetention.now());
			keyed.add(k);
			writePins(dir, sha, plainPins(dir, sha), keyed);
			PlanRetention.touchAt(world, planOf(dir, sha));
		} catch (IOException e) {
			Architect.LOGGER.warn("Artifact {} keyed pin: {}", sha, e.toString());
		}
	}

	/**
	 * (6c close-out A, §2) Rewrites every keyed pin of {@code (owner, key)}: {@code end} drops them (the key's realise wrote its region
	 * record) and sweeps their artifacts; else their last use is now (a realise attempt under the key). Server thread.
	 */
	static void keyed(@Nullable String owner, String key, boolean end) {
		MinecraftServer s = server;
		if (s != null) {
			keyedAt(s.getWorldPath(LevelResource.ROOT), owner, key, end);
		}
	}

	/** {@link #keyed} in a world dir (tests). */
	static void keyedAt(Path world, @Nullable String owner, String key, boolean end) {
		if (owner == null) {
			return;
		}
		Path dir = artifacts(world);
		try {
			for (String sha : pinned(dir)) {
				List<JsonObject> keyed = new ArrayList<>(keyedPins(dir, sha));
				boolean hit = false;
				for (var it = keyed.iterator(); it.hasNext();) {
					JsonObject k = it.next();
					if (owner.equals(k.get("owner").getAsString()) && key.equals(k.get("opKey").getAsString())) {
						hit = true;
						if (end) {
							it.remove();
						} else {
							k.addProperty("at", PlanRetention.now());
						}
					}
				}
				if (!hit) {
					continue;
				}
				writePins(dir, sha, plainPins(dir, sha), keyed);
				if (end) {
					sweep(dir, sha, pins(dir, sha));
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Keyed pins of {}: {}", key, e.toString());
		}
	}

	/** (6c close-out A, §2) A realise wrote its region record: a keyed one ends every keyed pin under its key. Server thread. */
	static void keyRealised(@Nullable String regionId) {
		RegionsImpl.Live l = regionId == null ? null : RegionsImpl.live(regionId);
		if (l != null && l.rec().opKey != null) {
			keyed(l.rec().owner, l.rec().opKey, true);
		}
	}

	/**
	 * (6c close-out A, §2) The world-start sweep of keyed pins: a pin whose key has a region (a crash between the record and the pins'
	 * end) or whose last use is past {@link PlanRetention#KEYED_MS} ends; its artifact is swept. Returns how many ended.
	 */
	static int sweepKeyedPins(MinecraftServer s) {
		return sweepKeyedPinsAt(s.getWorldPath(LevelResource.ROOT));
	}

	/** {@link #sweepKeyedPins} in a world dir (tests). */
	static int sweepKeyedPinsAt(Path world) {
		Path dir = artifacts(world);
		long now = PlanRetention.now();
		int n = 0;
		try {
			for (String sha : pinned(dir)) {
				List<JsonObject> keyed = new ArrayList<>(keyedPins(dir, sha));
				int before = keyed.size();
				keyed.removeIf(k -> {
					String owner = k.get("owner").getAsString(), key = k.get("opKey").getAsString();
					long at = k.has("at") ? k.get("at").getAsLong() : 0;
					return now - at > PlanRetention.KEYED_MS || RegionsImpl.INSTANCE.realiseByKey(owner, key).isPresent();
				});
				if (keyed.size() == before) {
					continue;
				}
				n += before - keyed.size();
				writePins(dir, sha, plainPins(dir, sha), keyed);
				sweep(dir, sha, pins(dir, sha));
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Keyed pins sweep: {}", e.toString());
		}
		if (n > 0) {
			Architect.LOGGER.info("Artifacts: {} keyed pin(s) ended at the world start", n);
		}
		return n;
	}

	/** (6c close-out A, §3) A pinned artifact made from the plan (its sha), or null: the plan is held. */
	static @Nullable String pinnedArtifactOf(Path world, String planId) {
		Path dir = artifacts(world);
		try {
			for (String sha : pinned(dir)) {
				if (Files.isRegularFile(dir.resolve(sha + ".json")) && planId.equals(planOf(dir, sha)) && !pins(dir, sha).isEmpty()) {
					return sha;
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Artifacts of plan {}: {}", planId, e.toString());
		}
		return null;
	}

	/** (6c close-out A, §3) A discarded plan that a keyed check made: its key record goes, so checkByKey answers empty and the key checks again. */
	static void checkDiscarded(Path world, String planId) {
		KEYS.values().removeIf(k -> planId.equals(k.checkId()));
		CHECKS.remove(planId);
		try {
			Files.deleteIfExists(checks(world).resolve(planId + ".json"));
		} catch (IOException e) {
			Architect.LOGGER.warn("Plan check {}: key record not removed: {}", planId, e.toString());
		}
	}

	/** (6c close-out A, §3) A discarded plan: every artifact made from it with no pin and no region goes to its tombstone. */
	static void planDiscarded(Path world, String planId) {
		Path dir = artifacts(world);
		if (!Files.isDirectory(dir)) {
			return;
		}
		try (var st = Files.list(dir)) {
			for (String n : st.map(x -> x.getFileName().toString()).filter(x -> x.endsWith(".meta.json")).sorted().toList()) {
				String sha = n.substring(0, n.length() - ".meta.json".length());
				if (SHA.matcher(sha).matches() && planId.equals(planOf(dir, sha))) {
					sweep(dir, sha, pins(dir, sha));
				}
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Artifacts of discarded plan {}: {}", planId, e.toString());
		}
	}

	/** The standing regions realised from an artifact (their record's ext names it). */
	static Set<String> regionsOf(String sha) {
		Set<String> out = new LinkedHashSet<>();
		for (RegionsImpl.Live l : RegionsImpl.all()) {
			var rec = l.rec();
			if (rec.state != RegionState.REMOVED && rec.ext != null && rec.ext.get(EXT_ARTIFACT) instanceof JsonElement e && e.isJsonPrimitive()
				&& sha.equals(e.getAsString())) {
				out.add(rec.id);
			}
			// (6d RV, §9.5) a standing revision's artifact is kept while the revision stands
			if (rec.state != RegionState.REMOVED) {
				for (Revisions.Rev r : rec.revisions) {
					if (sha.equals(r.artifact) && r.standing()) {
						out.add(rec.id);
					}
				}
			}
		}
		return out;
	}

	/** The region record's ext member naming the artifact it was realised from (Architect's own key). */
	public static final String EXT_ARTIFACT = "architect_mc:artifact";

	static void pin(String sha, String owner, boolean on) {
		MinecraftServer s = server;
		if (s == null || !SHA.matcher(sha).matches() || owner == null || owner.isBlank()) {
			return;
		}
		Path dir = artifacts(s.getWorldPath(LevelResource.ROOT));
		try {
			if (!Files.isRegularFile(dir.resolve(sha + ".json"))) {
				return; // unknown or removed: nothing to pin (idempotent)
			}
			Set<String> plain = plainPins(dir, sha);
			List<JsonObject> keyed = new ArrayList<>(keyedPins(dir, sha));
			// (6c close-out A) an unpin drops the owner's keyed pins on this artifact too
			boolean changed = on ? plain.add(owner) : plain.remove(owner) | keyed.removeIf(k -> owner.equals(k.get("owner").getAsString()));
			if (changed) {
				writePins(dir, sha, plain, keyed);
			}
			if (on) {
				PlanRetention.touch(planOf(dir, sha)); // (6c close-out A) a pin is a use of the artifact's plan
			} else {
				sweep(dir, sha, pins(dir, sha));
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Artifact {} pins: {}", sha, e.toString());
		}
	}

	/**
	 * (C36) The retention sweep for one artifact: with no pin and no non-REMOVED region holding it, the body goes and a tombstone
	 * ({@code <sha>.removed.json}) stays (C22's pattern). Idempotent: nothing to do when the body is already gone.
	 */
	private static void sweep(Path dir, String sha, Set<String> pins) throws IOException {
		if (!pins.isEmpty() || !regionsOf(sha).isEmpty() || !Files.isRegularFile(dir.resolve(sha + ".json"))) {
			return;
		}
		JsonObject t = new JsonObject();
		t.addProperty("removedAt", System.currentTimeMillis());
		RegionStore.writeJson(dir.resolve(sha + ".removed.json"), t);
		Files.deleteIfExists(dir.resolve(sha + ".json"));
		Files.deleteIfExists(dir.resolve(sha + ".pins.json"));
		Architect.LOGGER.info("Artifact {} removed (no pin, no region)", sha.substring(0, 12));
	}

	/** The artifact sha a region record was realised from (its ext's {@link #EXT_ARTIFACT}), or null. */
	static @Nullable String artifactOf(RegionRec rec) {
		return rec.ext != null && rec.ext.get(EXT_ARTIFACT) instanceof JsonElement e && e.isJsonPrimitive() && SHA.matcher(e.getAsString()).matches()
			? e.getAsString() : null;
	}

	/**
	 * (C36) A region reached REMOVED (a removal finished, live or resumed after C22/C23): sweep its artifact. Safe to repeat.
	 * {@code atLoad}: the world just loaded, so an artifact checked again after the removal (its meta is newer than the removal) is
	 * left, as it may await its realise.
	 */
	static void regionRemoved(RegionRec rec, boolean atLoad) {
		MinecraftServer s = server;
		// (6d RV, §9.5) Regions.remove tombstones every revision's artifact too (unless pinned)
		if (s != null && !atLoad) {
			Path dir = artifacts(s.getWorldPath(LevelResource.ROOT));
			for (Revisions.Rev r : rec.revisions) {
				if (r.artifact != null && SHA.matcher(r.artifact).matches()) {
					try {
						sweep(dir, r.artifact, pins(dir, r.artifact));
					} catch (IOException | RuntimeException e) {
						Architect.LOGGER.warn("Artifact {} sweep: {}", r.artifact, e.toString());
					}
				}
			}
		}
		String sha = artifactOf(rec);
		if (s == null || sha == null) {
			return;
		}
		Path dir = artifacts(s.getWorldPath(LevelResource.ROOT));
		try {
			if (atLoad) {
				JsonObject meta = RegionStore.readJson(dir.resolve(sha + ".meta.json"));
				if (meta != null && meta.has("createdAt") && meta.get("createdAt").getAsLong() > rec.removedAt) {
					return;
				}
			}
			sweep(dir, sha, pins(dir, sha));
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Artifact {} sweep: {}", sha, e.toString());
		}
	}

	/** (6d RV, §9.5) An undone revision's artifact is tombstoned unless pinned (or held otherwise). Server thread. */
	static void revisionUndone(RegionsImpl.Live l, Revisions.Rev r) {
		MinecraftServer s = server;
		if (s == null || r.artifact == null || !SHA.matcher(r.artifact).matches()) {
			return;
		}
		Path dir = artifacts(s.getWorldPath(LevelResource.ROOT));
		try {
			sweep(dir, r.artifact, pins(dir, r.artifact));
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Artifact {} sweep: {}", r.artifact, e.toString());
		}
	}

	// ------------------------------------------------------------------ realiseApproved

	static CompletableFuture<String> realiseApproved(ApprovedRealise r) {
		MinecraftServer s = server;
		if (s == null) {
			return refused(Reason.NOT_LOADED, "no world");
		}
		String sha = r.artifactSha();
		Optional<PlanArtifact> a = sha == null ? Optional.empty() : artifact(sha);
		if (a.isEmpty()) {
			return refused(Reason.ARTIFACT_UNAPPROVED, "no artifact " + sha);
		}
		if (a.get().removed()) {
			return refused(Reason.ARTIFACT_UNAPPROVED, "artifact " + sha.substring(0, 12) + " was removed at " + a.get().removedAt() + " (its tombstone): check again");
		}
		JsonObject body = a.get().body();
		String planId = a.get().planId();
		RegionsImpl.PlanRec p = RegionsImpl.planRec(planId);
		if (p == null) {
			return refused(Reason.ARTIFACT_UNAPPROVED, "artifact " + sha.substring(0, 12) + ": its plan " + planId + " is gone");
		}
		// (6c close-out A, §14) a realise attempt is a use of the plan, and of the keyed pins under its key
		PlanRetention.touch(planId);
		if (r.opKey() != null && r.opKey().matches("[A-Za-z0-9_.:-]{1,128}")) {
			keyed(p.owner(), r.opKey(), false);
		}
		if (!p.irSha().equals(body.getAsJsonObject("region").get("irSha").getAsString())) {
			return refused(Reason.ARTIFACT_STALE, "artifact " + sha.substring(0, 12) + ": its plan's IR is not the artifact's");
		}
		// (6c RS, §3, S-RS-5) the artifact was checked in the world's mode: a creative artifact in survival (or the reverse) is stale
		boolean checkedSurvival = body.get("survival") instanceof JsonElement sv && sv.isJsonPrimitive() && sv.getAsBoolean();
		if (checkedSurvival != RegionSurvival.on(s)) {
			return refused(Reason.ARTIFACT_STALE, checkedSurvival ? "artifact " + sha.substring(0, 12) + " was checked in survival: check the plan again in creative"
				: "artifact " + sha.substring(0, 12) + " was checked in creative: check the plan again in survival");
		}
		ServerLevel level = Sites.levelOf(s, p.dimension());
		if (level == null) {
			return refused(Reason.NOT_LOADED, p.dimension() + " is not loaded");
		}
		JsonObject inputs = body.getAsJsonObject("inputs");
		Map<String, String> lots = new LinkedHashMap<>();
		if (body.get("lots") instanceof JsonArray la) {
			for (JsonElement e : la) {
				JsonObject l = e.getAsJsonObject();
				if (l.get("entry") instanceof JsonElement en && en.isJsonPrimitive()) {
					lots.put(l.get("id").getAsString(), en.getAsString());
				}
			}
		}
		lots.putAll(r.lotEntries());
		// (6c VOC-c, §4) the palette rules over the lots bound now (the artifact's parts' counts plus each bound lot's template): a required
		// rule outside its share refuses PALETTE below; every rule's measure goes to the realise's ext (architect_mc:palette)
		dev.larattalabs.architect.api.PaletteCheck pal = PaletteRules.measure(body, lots, (lot, entry) -> PaletteRules.placed(entry));
		JsonObject ext = r.ext().deepCopy();
		ext.addProperty(EXT_ARTIFACT, sha);
		if (!pal.rules().isEmpty()) {
			ext.add(PaletteRules.EXT_PALETTE, PaletteRules.extRows(pal));
		}
		RealiseRequest rr = new RealiseRequest(planId, r.mode(), r.actor(), lots, null, true, null, false, ext, 0, r.opKey());
		// a keyed realise that already exists (C20): the realise's own key rule answers (the region, or OP_KEY_CONFLICT); its land has
		// changed by its own writes, so the stale checks below are for a new realise only
		if (r.opKey() != null && RegionsImpl.INSTANCE.realiseByKey(p.owner(), r.opKey()).isPresent()) {
			return RegionsImpl.INSTANCE.realise(rr);
		}
		JsonObject cl = inputs.getAsJsonObject("claim");
		int x0 = cl.get("minX").getAsInt(), z0 = cl.get("minZ").getAsInt(), x1 = cl.get("maxX").getAsInt(), z1 = cl.get("maxZ").getAsInt();
		int res = inputs.has("surveyRes") ? inputs.get("surveyRes").getAsInt() : 1;
		// (3) provisional lots: an entry past its fit box or the top of its cost range refuses now, before the survey
		String lotWhy = lotProblem(body, r.lotEntries());
		if (lotWhy != null) {
			return refused(Reason.ARTIFACT_STALE, lotWhy);
		}
		// (6c VOC-c, §4) a required palette rule the bound lots break: nothing is written
		String[] palWhy = PaletteRules.refusal(pal);
		if (palWhy != null) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.PALETTE, palWhy[0], palWhy[1]));
		}
		// (2) the protection over the claim, then the terrain under the plan's tiles
		Protection prot = protection(p.dimension(), p.owner(), new int[] {x0, z0, x1, z1});
		String frozen = inputs.has("protection") && inputs.get("protection").isJsonPrimitive() ? inputs.get("protection").getAsString() : null;
		if (frozen != null && !frozen.equals(prot.sha())) {
			return refused(Reason.ARTIFACT_STALE, "the protection over the claim changed since the check: " + protectionDiff(p, prot));
		}
		Columns plan = Drift.planSurvey(level, planId);
		if (plan == null) {
			return refused(Reason.ARTIFACT_UNAPPROVED, "artifact " + sha.substring(0, 12) + ": its plan survey is gone");
		}
		// (6c T3 §6) the tunnels' rock first (a mine near the surface would also move a column: the tunnel names it), then the land
		return RegionsImpl.onServer(s, () -> tunnelRock(level, body)).thenCompose(f -> f).thenCompose(rock -> {
			if (rock != null) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, rock);
			}
			return RegionSurvey.sample(level, x0, z0, x1, z1, res, LoadPolicy.LOADED_ONLY);
		}).thenCompose(now -> RegionsImpl.onServer(s, () -> {
			// (6d RV, §9.4) a revision artifact: the land now with its region's frozen heights over it (as its check surveyed it); its tiles are
			// the revision's own (the dirty ones)
			if (body.getAsJsonObject("region").get("revisionOf") instanceof JsonObject ro && ro.get("region") instanceof JsonElement rid && rid.isJsonPrimitive()) {
				Revisions.overlayFrozen(now, s.getWorldPath(LevelResource.ROOT), rid.getAsString());
			}
			String drift = terrainDiff(plan, now, body.getAsJsonObject("region").getAsJsonObject("tiles"), x0, z0, x1, z1);
			if (drift != null) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, "the land under the plan's tiles changed since the check: " + drift);
			}
			// (6c D3, §4.4) a reach plan's re-check (the town, the held set over the reach, the areas and other owners): every refusal is
			// ARTIFACT_STALE here (the land under the plan changed), so Steward's stale retry re-checks
			if (p.ir().json().get("reach") instanceof JsonObject reach) {
				String[] rw = RegionsImpl.reachRecheck(p, reach);
				if (rw != null) {
					throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, "the land under the plan changed since the check (" + rw[0] + "): " + rw[1]);
				}
			}
			return RegionsImpl.INSTANCE.realise(rr);
		})).thenCompose(f -> f);
	}

	/** At most this many changed cells are named in a tunnel's ARTIFACT_STALE. */
	static final int ROCK_CELLS_NAMED = 16;

	/**
	 * (6c T3 §6) The approved tunnels' rock against the world now: the artifact's {@code guards} (per tunnel part: the frozen volume it
	 * was checked against, {@code {sha, box}}, and its void, shell and 2-cell fluid buffer as per-column y runs {@code [x, z, y0, y1,
	 * ...]}) are compared cell by cell: the frozen volume ({@code <world>/architect/volumes/<sha>.bin}) against the same box sampled
	 * again (GENERATED_ONLY). PLANT and AIR count as one class (grass and flowers never stale an artifact); a cell MISSING now is not
	 * judged. Null when every guard holds (or the artifact has none), else the ARTIFACT_STALE message naming the tunnel part and up to
	 * {@link #ROCK_CELLS_NAMED} cells with the class before and now. Server thread.
	 */
	static CompletableFuture<@Nullable String> tunnelRock(ServerLevel level, JsonObject body) {
		if (!(body.get("guards") instanceof JsonArray guards) || guards.isEmpty()) {
			return CompletableFuture.completedFuture(null);
		}
		Path vols = level.getServer().getWorldPath(LevelResource.ROOT).resolve(dev.larattalabs.architect.region.volume.VolumeSurvey.STANDALONE_DIR);
		CompletableFuture<@Nullable String> chain = CompletableFuture.completedFuture(null);
		// ((6c HY, the batch) a course's reaches share one frozen volume: each volume (sha, box, fluid layer) is decoded and sampled again
		// once per check, every guard on it compares its own runs, so ARTIFACT_STALE still names the reach)
		java.util.Map<String, CompletableFuture<GuardSample>> samples = new java.util.HashMap<>();
		int gi = 0;
		for (JsonElement ge : guards) {
			String bad = guardMalformed(gi++, ge);
			if (bad != null) {
				// (housekeeping 3) a malformed guard answers by name before any survey, never a Gson exception from deep in the diff
				final String why = bad;
				chain = chain.thenApply(prev -> prev != null ? prev : why);
				continue;
			}
			JsonObject g = ge.getAsJsonObject();
			chain = chain.thenCompose(prev -> prev != null ? CompletableFuture.completedFuture(prev) : RegionsImpl.onServer(level.getServer(), () -> guardDiff(level,
				vols, g, samples)).thenCompose(f -> f));
		}
		return chain;
	}

	/**
	 * (housekeeping 3) A guard's shape before it is read: an object with {@code volume: {sha: string, box: [6 integers]}} and {@code runs}
	 * a flat array of integers, a whole number of {@code [x, z, y0, y1]} quads. Null when it holds, else the ARTIFACT_STALE message naming
	 * the guard (its body and part, or its index) and what is wrong, so a nested or truncated {@code runs} never surfaces as Gson's "Array
	 * must have size 1".
	 */
	static @Nullable String guardMalformed(int index, JsonElement ge) {
		if (!(ge instanceof JsonObject g)) {
			return "guard " + index + ": the artifact's guard is malformed (not an object): check the plan again";
		}
		boolean fluids = g.get("fluids") instanceof JsonElement fe && fe.isJsonPrimitive() && fe.getAsJsonPrimitive().isBoolean() && fe.getAsBoolean();
		String name = fluids ? RegionsImpl.str(g, "kind", "body") + " " + RegionsImpl.str(g, "body", "?") + " of " + RegionsImpl.str(g, "part", "?")
			: RegionsImpl.str(g, "part", "?");
		String why = null;
		if (!(g.get("volume") instanceof JsonObject v)) {
			why = "no volume";
		} else if (!(v.get("sha") instanceof JsonElement sh && sh.isJsonPrimitive() && sh.getAsJsonPrimitive().isString() && !sh.getAsString().isEmpty())) {
			why = "its volume has no sha";
		} else if (!(v.get("box") instanceof JsonArray bx) || bx.size() != 6 || !allInts(bx)) {
			why = "its volume's box is not 6 integers";
		} else if (!(g.get("runs") instanceof JsonArray runs)) {
			why = "no runs";
		} else if (!allInts(runs)) {
			why = "runs must be a flat array of integers [x, z, y0, y1, ...]";
		} else if (runs.size() % 4 != 0) {
			why = "runs has " + runs.size() + " integers, not a whole number of [x, z, y0, y1] quads";
		}
		return why == null ? null : "guard " + index + " (" + name + "): the artifact's guard is malformed (" + why + "): check the plan again";
	}

	private static boolean allInts(JsonArray a) {
		for (JsonElement e : a) {
			if (!(e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber())) {
				return false;
			}
			double d = e.getAsDouble();
			if (d != Math.rint(d) || d < Integer.MIN_VALUE || d > Integer.MAX_VALUE) {
				return false;
			}
		}
		return true;
	}

	private static CompletableFuture<@Nullable String> guardDiff(ServerLevel level, Path vols, JsonObject g, java.util.Map<String, CompletableFuture<GuardSample>> samples) {
		// (6c H §10) a fluid guard (a body's shell, buffer and joins, or a wet column) names its body, compares the fluid layer too, and is
		// sampled again with it (ARVX version 3)
		boolean fluids = g.get("fluids") instanceof JsonElement fe && fe.isJsonPrimitive() && fe.getAsBoolean();
		String part = fluids ? RegionsImpl.str(g, "kind", "body") + " " + RegionsImpl.str(g, "body", "?") + " of " + RegionsImpl.str(g, "part", "?")
			: RegionsImpl.str(g, "part", "?");
		JsonObject v = g.getAsJsonObject("volume");
		String sha = RegionsImpl.str(v, "sha");
		JsonArray bx = v.getAsJsonArray("box");
		BoundingBox bb = new BoundingBox(bx.get(0).getAsInt(), bx.get(1).getAsInt(), bx.get(2).getAsInt(), bx.get(3).getAsInt(), bx.get(4).getAsInt(), bx.get(5)
			.getAsInt());
		String key = sha + " " + bx + " " + fluids;
		CompletableFuture<GuardSample> sample = samples.get(key);
		if (sample == null) {
			dev.larattalabs.architect.region.volume.Arvx.Decoded before;
			try {
				before = dev.larattalabs.architect.region.volume.Arvx.decode(dev.larattalabs.architect.region.volume.Arvx.gunzip(Files.readAllBytes(vols.resolve(sha
					+ ".bin"))));
			} catch (IOException | RuntimeException e) {
				return CompletableFuture.completedFuture((fluids ? "" : connectorOf(g) + " ") + part + ": the frozen volume " + sha.substring(0, Math.min(12, sha.length()))
					+ " it was checked against is gone (" + e.getMessage() + "): check again");
			}
			int chunks = ((bb.maxX() >> 4) - (bb.minX() >> 4) + 1) * ((bb.maxZ() >> 4) - (bb.minZ() >> 4) + 1);
			sample = dev.larattalabs.architect.region.volume.VolumeSurvey.start(level, bb, LoadPolicy.GENERATED_ONLY(chunks + 8), null, fluids, fluids).thenApply(res -> {
				try {
					return new GuardSample(before, dev.larattalabs.architect.region.volume.Arvx.decode(dev.larattalabs.architect.region.volume.Arvx.gunzip(res.gz())));
				} catch (IOException e) {
					throw new java.io.UncheckedIOException(e);
				}
			});
			samples.put(key, sample);
		}
		return sample.thenApply(bn -> fluids ? waterDiff(part, bn.before(), bn.now(), g.getAsJsonArray("runs")) : rockDiff(connectorOf(g), part, bn.before(), bn.now(),
			g.getAsJsonArray("runs")));
	}

	/** (7a RK §3) A rock guard's connector as its ARTIFACT_STALE names it: the guard's {@code connector} ("rock_stair"), else "tunnel". */
	static String connectorOf(JsonObject g) {
		return g.get("connector") instanceof JsonElement c && c.isJsonPrimitive() && "rock_stair".equals(c.getAsString()) ? "rock_stair" : "tunnel";
	}

	/** A guard's frozen volume as planned and the same box sampled again (one per volume and check, shared by the guards on it). */
	private record GuardSample(dev.larattalabs.architect.region.volume.Arvx.Decoded before, dev.larattalabs.architect.region.volume.Arvx.Decoded now) {}

	/** The guard cells' classes before and now (PLANT as AIR; MISSING now not judged): null when equal, else the message. */
	static @Nullable String rockDiff(String part, dev.larattalabs.architect.region.volume.Arvx.Decoded before, dev.larattalabs.architect.region.volume.Arvx.Decoded now,
		JsonArray runs) {
		return rockDiff("tunnel", part, before, now, runs);
	}

	/** (7a RK §3) The rock diff above with the connector its message names ("tunnel", "rock_stair"). */
	static @Nullable String rockDiff(String connector, String part, dev.larattalabs.architect.region.volume.Arvx.Decoded before,
		dev.larattalabs.architect.region.volume.Arvx.Decoded now, JsonArray runs) {
		int[] b = before.box();
		var classes = dev.larattalabs.architect.api.VoxelClass.values();
		int air = dev.larattalabs.architect.api.VoxelClass.AIR.ordinal(), plant = dev.larattalabs.architect.api.VoxelClass.PLANT.ordinal();
		int missing = dev.larattalabs.architect.api.VoxelClass.MISSING.ordinal();
		int n = 0;
		List<String> named = new ArrayList<>();
		for (int i = 0; i + 3 < runs.size(); i += 4) {
			int x = runs.get(i).getAsInt(), z = runs.get(i + 1).getAsInt(), y0 = runs.get(i + 2).getAsInt(), y1 = runs.get(i + 3).getAsInt();
			for (int y = y0; y <= y1; y++) {
				if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) {
					continue;
				}
				int was = before.classAt(x, y, z), is = now.classAt(x, y, z);
				if (is == missing || was == missing) {
					continue;
				}
				int w = was == plant ? air : was, k = is == plant ? air : is;
				if (w != k) {
					n++;
					if (named.size() < ROCK_CELLS_NAMED) {
						named.add("(" + x + ", " + y + ", " + z + ") " + classes[was] + "->" + classes[is]);
					}
				}
			}
		}
		return n == 0 ? null : connector + " " + part + ": the rock it was checked against changed since the check, " + n + " cell" + (n == 1 ? "" : "s") + ": " + String
			.join("; ", named);
	}

	/**
	 * (6c H §10) A fluid guard's cells before and now: the classes (PLANT as AIR, MISSING not judged) and the fluid layer (a version-3
	 * volume's codes; a volume without it compares classes only). Null when equal, else "body <id> of <part>: the water it was checked
	 * against changed since the check, N cells: (x, y, z) BEFORE->NOW" (a player's pond, a drained lake, a new flow), at most
	 * {@link #ROCK_CELLS_NAMED} named.
	 */
	static @Nullable String waterDiff(String part, dev.larattalabs.architect.region.volume.Arvx.Decoded before, dev.larattalabs.architect.region.volume.Arvx.Decoded now,
		JsonArray runs) {
		int[] b = before.box();
		var classes = dev.larattalabs.architect.api.VoxelClass.values();
		var codes = dev.larattalabs.architect.region.volume.Arvx.FLUID_CODES;
		int air = dev.larattalabs.architect.api.VoxelClass.AIR.ordinal(), plant = dev.larattalabs.architect.api.VoxelClass.PLANT.ordinal();
		int missing = dev.larattalabs.architect.api.VoxelClass.MISSING.ordinal();
		int n = 0;
		List<String> named = new ArrayList<>();
		for (int i = 0; i + 3 < runs.size(); i += 4) {
			int x = runs.get(i).getAsInt(), z = runs.get(i + 1).getAsInt(), y0 = runs.get(i + 2).getAsInt(), y1 = runs.get(i + 3).getAsInt();
			for (int y = y0; y <= y1; y++) {
				if (x < b[0] || x > b[3] || y < b[1] || y > b[4] || z < b[2] || z > b[5]) {
					continue;
				}
				int was = before.classAt(x, y, z), is = now.classAt(x, y, z);
				if (is == missing || was == missing) {
					continue;
				}
				int w = was == plant ? air : was, k = is == plant ? air : is;
				int fw = before.fluidAt(x, y, z), fk = now.fluidAt(x, y, z);
				boolean fluidChanged = fw >= 0 && fk >= 0 && fw != fk;
				if (w != k || fluidChanged) {
					n++;
					if (named.size() < ROCK_CELLS_NAMED) {
						named.add("(" + x + ", " + y + ", " + z + ") " + classes[was] + (fw > 0 ? "/" + codes.get(fw) : "") + "->" + classes[is] + (fk > 0 ? "/" + codes
							.get(fk) : ""));
					}
				}
			}
		}
		return n == 0 ? null : part + ": the water it was checked against changed since the check, " + n + " cell" + (n == 1 ? "" : "s") + ": " + String.join(
			"; ", named);
	}

	/**
	 * Every column of the claim inside the plan's tiles, the plan survey against the survey now (ground, height, floor, flags; a column
	 * missing in either is not judged): null when equal, else how many differ and the first few.
	 */
	static @Nullable String terrainDiff(Columns plan, Columns now, JsonObject tiles, int x0, int z0, int x1, int z1) {
		Set<String> keys = new LinkedHashSet<>();
		for (var st : tiles.entrySet()) {
			for (var set : st.getValue().getAsJsonObject().entrySet()) {
				set.getValue().getAsJsonObject().keySet().forEach(keys::add);
			}
		}
		int n = 0;
		List<String> first = new ArrayList<>();
		for (String k : keys) {
			String[] t = k.split(",");
			int tx = Integer.parseInt(t[0]), tz = Integer.parseInt(t[1]);
			for (int z = Math.max(z0, tz * 64); z <= Math.min(z1, tz * 64 + 63); z++) {
				for (int x = Math.max(x0, tx * 64); x <= Math.min(x1, tx * 64 + 63); x++) {
					if ((x - plan.minX) % plan.resolution != 0 || (z - plan.minZ) % plan.resolution != 0) {
						continue;
					}
					int pi = (x - plan.minX) / plan.resolution, pj = (z - plan.minZ) / plan.resolution;
					int ni = (x - now.minX) / now.resolution, nj = (z - now.minZ) / now.resolution;
					if (pi < 0 || pj < 0 || pi >= plan.width || pj >= plan.depth || ni < 0 || nj < 0 || ni >= now.width || nj >= now.depth) {
						continue;
					}
					int a = plan.index(pi, pj), b = now.index(ni, nj);
					if (plan.missing(a) || now.missing(b)) {
						continue;
					}
					if (plan.ground[a] != now.ground[b] || plan.height[a] != now.height[b] || plan.floor[a] != now.floor[b] || plan.flags[a] != now.flags[b]) {
						n++;
						if (first.size() < 8) {
							first.add("(" + x + ", " + z + ") ground " + plan.ground[a] + "->" + now.ground[b] + " height " + plan.height[a] + "->" + now.height[b]
								+ (plan.flags[a] != now.flags[b] ? " flags " + plan.flags[a] + "->" + now.flags[b] : ""));
						}
					}
				}
			}
		}
		return n == 0 ? null : n + " column" + (n == 1 ? "" : "s") + ": " + String.join("; ", first);
	}

	/** The protected areas and regions that are new or gone since the plan (its IR's params). */
	static String protectionDiff(RegionsImpl.PlanRec p, Protection now) {
		JsonObject params = p.ir().json().getAsJsonObject("params");
		Set<String> was = new LinkedHashSet<>(), is = new LinkedHashSet<>();
		java.util.function.BiConsumer<JsonElement, Set<String>> add = (e, into) -> {
			if (e instanceof JsonArray arr) {
				arr.forEach(x -> into.add(x.toString()));
			}
		};
		if (params != null && params.get("protected") instanceof JsonObject pa) {
			add.accept(pa.get("areas"), was);
		}
		if (params != null && params.get("regions") instanceof JsonObject rg) {
			add.accept(rg.get("regions"), was);
		}
		add.accept(now.areas(), is);
		add.accept(now.regions(), is);
		List<String> d = new ArrayList<>();
		is.stream().filter(x -> !was.contains(x)).forEach(x -> d.add("new " + x));
		was.stream().filter(x -> !is.contains(x)).forEach(x -> d.add("gone " + x));
		return d.isEmpty() ? "the fingerprint differs" : String.join("; ", d);
	}

	/**
	 * A provisional lot's entry against its approval: it must fit the lot's recorded box (footprint and height) and cost no more than
	 * the top of its recorded range (the template's blocks). Null when every bound entry holds.
	 */
	static @Nullable String lotProblem(JsonObject body, Map<String, String> entries) {
		if (!(body.get("lots") instanceof JsonArray la)) {
			return entries.isEmpty() ? null : "the artifact has no lots";
		}
		Map<String, JsonObject> lots = new LinkedHashMap<>();
		la.forEach(e -> lots.put(e.getAsJsonObject().get("id").getAsString(), e.getAsJsonObject()));
		for (var e : entries.entrySet()) {
			JsonObject l = lots.get(e.getKey());
			if (l == null) {
				return "lot " + e.getKey() + " is not a lot of the artifact";
			}
			if (!(l.get("provisional") instanceof JsonElement pv && pv.getAsBoolean())) {
				continue;
			}
			String id = e.getValue().contains("@") ? e.getValue().substring(0, e.getValue().indexOf('@')) : e.getValue();
			var bp = Blueprints.get(id);
			if (bp == null) {
				return "lot " + e.getKey() + ": no library entry " + e.getValue();
			}
			JsonArray box = l.getAsJsonArray("fitBox");
			int w = box.get(3).getAsInt() - box.get(0).getAsInt() + 1, h = box.get(4).getAsInt() - box.get(1).getAsInt() + 1, d = box.get(5).getAsInt() - box
				.get(2).getAsInt() + 1;
			boolean fits = (bp.sizeX() <= w && bp.sizeZ() <= d) || (bp.sizeZ() <= w && bp.sizeX() <= d);
			if (!fits || bp.sizeY() > h) {
				return "lot " + e.getKey() + ": entry " + e.getValue() + " (" + bp.sizeX() + "x" + bp.sizeY() + "x" + bp.sizeZ() + ") is outside the lot's approved box ("
					+ w + "x" + h + "x" + d + "): approve again";
			}
			long top = l.getAsJsonArray("costRange").get(1).getAsLong();
			// ((6c IRR, §5) an entry's blocks on the lot's irrigation cells are dropped at the realise: not counted, so this is the count placed)
			long cells = cells(id) - irrigationDropped(l, bp, id);
			if (cells > top) {
				return "lot " + e.getKey() + ": entry " + e.getValue() + " is " + cells + " cells, past the top of its approved cost range (" + top + "): approve again";
			}
		}
		return null;
	}

	/**
	 * (6c IRR) How many of an entry's non-air blocks the realise drops on an artifact lot's irrigation cells ({@code irrigation.cells},
	 * the lot fitted as the realise fits it: LotFitting on its box and front, centred, setback 0). 0 without irrigation.
	 */
	static long irrigationDropped(JsonObject lot, dev.larattalabs.architect.placement.Blueprint bp, String id) {
		if (!(lot.get("irrigation") instanceof JsonObject g) || !(g.get("cells") instanceof JsonArray c) || !(lot.get("box") instanceof JsonArray b)
			|| b.size() < 6) {
			return 0;
		}
		var f = dev.larattalabs.architect.batch.LotFitting.fit(bp, new dev.larattalabs.architect.placement.Anchors.Bounds(b.get(0).getAsInt(), b.get(1)
			.getAsInt(), b.get(2).getAsInt(), b.get(3).getAsInt(), b.get(4).getAsInt(), b.get(5).getAsInt()), lot.get("front") instanceof JsonElement fr
				&& fr.isJsonPrimitive() ? fr.getAsString() : "south", true, 0, true);
		return RegionsImpl.dropped(id, f, dev.larattalabs.architect.site.LotMask.of(maskExt(c)));
	}

	private static JsonObject maskExt(JsonArray runs) {
		JsonObject o = new JsonObject();
		o.add(dev.larattalabs.architect.site.LotMask.EXT, dev.larattalabs.architect.site.LotMask.extOf(runs));
		return o;
	}

	/** The non-air blocks of an entry's template (0 when it can't be read): the one function {@code Library.Entry.cells()} shares ({@link Blueprints#nonAirCells}). */
	public static long cells(String id) {
		return Blueprints.nonAirCells(Blueprints.template(id));
	}

	// ------------------------------------------------------------------ small

	private static <T> CompletableFuture<T> refused(Reason r, String msg) {
		return CompletableFuture.failedFuture(RegionsImpl.refusal(r, msg));
	}

	private static <T> CompletableFuture<T> conflict(String key, @Nullable String owner, @Nullable String checkId) {
		return CompletableFuture.failedFuture(new ArchitectRefused(Reason.OP_KEY_CONFLICT, "opKey \"" + key + "\" (region.checkPlan" + (owner == null ? ""
			: ", " + owner) + ") was used for another plan check" + (checkId != null ? " (" + checkId + ")" : "")));
	}

	private static Throwable unwrap(Throwable e) {
		while ((e instanceof CompletionException || e instanceof java.util.concurrent.ExecutionException) && e.getCause() != null) {
			e = e.getCause();
		}
		return e;
	}
}
