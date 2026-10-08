package dev.larattalabs.architect.region;

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
		@Nullable String owner, JsonObject ext, JsonObject planned, Ir ir, int chunks, int chunksToGenerate) {
	}

	/** A region in memory: its record, IR and world. */
	public record Live(RegionRec rec, Ir ir, Path world) {
		public @Nullable ServerLevel level(MinecraftServer server) {
			return Sites.levelOf(server, rec.dimension);
		}

		public JsonObject irJson() {
			return ir.json();
		}
	}

	private static final Map<String, PlanRec> PLANS = new ConcurrentHashMap<>();
	private static final Map<String, Live> REGIONS = new LinkedHashMap<>();
	private static final Map<String, CompletableFuture<JsonObject>> PLANNING = new ConcurrentHashMap<>();
	private static @Nullable MinecraftServer server;
	private static long lastProgress;
	private static int nextRegion = 1;

	private RegionsImpl() {
	}

	public static int window() {
		return Math.max(1, Math.min(16, window));
	}

	public static void init() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STARTED.register(RegionsImpl::started);
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			REGIONS.clear();
			PLANS.clear();
			Heights.forget(null);
			TileStream.forgetRegion(null);
			Prepare.stopAll();
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(s -> {
			RegionSurvey.tick(s);
			Prepare.tick(s);
			RegionHash.tick(s);
		});
	}

	private static void started(MinecraftServer s) {
		server = s;
		REGIONS.clear();
		Path w = s.getWorldPath(LevelResource.ROOT);
		Path root = RegionStore.root(w);
		if (!Files.isDirectory(root)) {
			return;
		}
		try (var st = Files.list(root)) {
			for (Path d : st.toList()) {
				Path f = d.resolve("region.json");
				if (!Files.isRegularFile(f)) {
					continue;
				}
				try {
					RegionRec r = RegionRec.fromJson(RegionStore.readJson(f));
					Ir ir = Ir.of(RegionStore.readJson(d.resolve("ir.json")));
					REGIONS.put(r.id, new Live(r, ir, w));
					nextRegion = Math.max(nextRegion, num(r.id) + 1);
				} catch (IOException | RuntimeException e) {
					Architect.LOGGER.warn("Region {} unreadable: {}", d.getFileName(), e.toString());
				}
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Regions unreadable: {}", e.toString());
		}
		Prepare.resumeAll(s);
		Architect.LOGGER.info("Regions: {} loaded", REGIONS.size());
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
		if (r.level().dimension() != Level.OVERWORLD) {
			return failed(Reason.NOT_ALLOWED, "regions are Overworld only in this version");
		}
		BoundingBox c = r.claim();
		int big = Boolean.getBoolean("architect.dev.bigRegions") ? 2048 : 1024;
		if (c.getXSpan() > big || c.getZSpan() > big) {
			return failed(Reason.REGION_LIMIT, "the claim is " + c.getXSpan() + "x" + c.getZSpan() + " columns (at most " + big + "x" + big + ")");
		}
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return failed(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected");
		}
		int res = (long) c.getXSpan() * c.getZSpan() <= 256L * 256 ? 1 : 4;
		return RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), res, r.surveyLoad()).thenCompose(cols -> {
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> {
				JsonObject m = new JsonObject();
				m.addProperty("type", "region.plan");
				m.addProperty("program", r.program());
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
				return link.send(m).thenCompose(ack -> {
					if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
						return CompletableFuture.failedFuture(new IllegalStateException("the helper refused the plan: " + str(ack, "error")));
					}
					String planId = ack.getAsJsonObject("result").get("planId").getAsString();
					CompletableFuture<JsonObject> done = PLANNING.computeIfAbsent(planId, k -> new CompletableFuture<>());
					return done.orTimeout(120, java.util.concurrent.TimeUnit.SECONDS).thenCompose(planned -> irOf(link, planned).thenApply(irJson -> {
						planned.addProperty("planId", planId);
						planned.addProperty("surveySha", surveySha);
						return new Object[] {planned, irJson, survey};
					}));
				});
			});
		}).thenCompose(o -> onServer(s, () -> finishPlan(r, (JsonObject) ((Object[]) o)[0], (JsonObject) ((Object[]) o)[1], (byte[]) ((Object[]) o)[2])))
			.thenCompose(f -> f);
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
	private CompletableFuture<RegionPlan> finishPlan(RegionPlanRequest r, JsonObject planned, JsonObject irJson, byte[] survey) {
		Ir ir = Ir.of(irJson);
		String planId = planned.get("planId").getAsString();
		List<Long> chunks = Prepare.chunksOf(ir.claim());
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
			PlanRec p = new PlanRec(planId, str(planned, "programId", ir.id()), str(irJson, "programSha"), planned.get("irSha").getAsString(), planned.get(
				"surveySha").getAsString(), seed, Sites.dimensionId(level), ir.claim(), r.owner(), r.ext(), planned, ir, chunks.size(), missing);
			PLANS.put(planId, p);
			try {
				Path w = level.getServer().getWorldPath(LevelResource.ROOT);
				RegionStore.writeJson(RegionStore.plan(w, planId), planToJson(p));
				RegionStore.write(RegionStore.plan(w, planId).resolveSibling(planId + ".survey.bin"), survey);
			} catch (IOException e) {
				Architect.LOGGER.warn("Region plan {} could not be saved: {}", planId, e.toString());
			}
			return view(p);
		}));
	}

	static RegionPlan view(PlanRec p) {
		List<LotSpec> lots = new ArrayList<>();
		for (Ir.Lot l : p.ir().lots()) {
			int[] b = l.box();
			JsonObject ext = new JsonObject();
			if (l.part() != null) {
				ext.addProperty("part", l.part());
			}
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
		return new RegionPlan(p.planId(), p.programId(), p.programSha() == null ? "" : p.programSha(), p.irSha(), p.surveySha(), p.seed(), lots,
			p.ir().stages(), anchors, new RegionBudget(b[0], b[1], b[2], tiles, p.chunks(), p.chunksToGenerate()), notes);
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
		return o;
	}

	private static PlanRec planFromJson(JsonObject o) {
		Ir ir = Ir.of(o.getAsJsonObject("ir"));
		return new PlanRec(o.get("planId").getAsString(), str(o, "programId"), str(o, "programSha"), o.get("irSha").getAsString(), str(o, "surveySha"),
			Long.parseUnsignedLong(o.get("seed").getAsString()), o.get("dimension").getAsString(), ir.claim(), o.has("owner") ? o.get("owner").getAsString()
				: null, o.has("ext") ? o.getAsJsonObject("ext") : new JsonObject(), o.getAsJsonObject("planned"), ir, o.get("chunks").getAsInt(), o.get(
					"chunksToGenerate").getAsInt());
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
		return onServer(s, () -> {
			PlanRec p = planRec(r.planId());
			ServerLevel level = p == null ? null : Sites.levelOf(s, p.dimension());
			if (p == null || level == null) {
				return CompletableFuture.<Drift.Result>completedFuture(null);
			}
			return Drift.check(level, p);
		}).thenCompose(f -> f).thenCompose(drift -> onServer(s, () -> realise0(s, r, drift)));
	}

	private String realise0(MinecraftServer s, RealiseRequest r, Drift.@Nullable Result drift) {
		PlanRec p = planRec(r.planId());
		if (p == null) {
			throw refusal(Reason.OTHER, "no region plan " + r.planId());
		}
		if (r.mode() == Mode.CONSTRUCTION || dev.larattalabs.architect.survival.SurvivalWorld.on() && s.getDefaultGameType() != GameType.CREATIVE) {
			throw refusal(Reason.NOT_ALLOWED, "regions are INSTANT only (creative, or the survival toggle off) in this version");
		}
		String why = WorldJournal.unavailable();
		if (why != null) {
			throw refusal(Reason.JOURNAL_UNAVAILABLE, why);
		}
		ServerLevel level = Sites.levelOf(s, p.dimension());
		if (level == null) {
			throw refusal(Reason.NOT_LOADED, p.dimension() + " is not loaded");
		}
		Ir ir = p.ir();
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
		String id = "rg" + nextRegion++;
		Path w = s.getWorldPath(LevelResource.ROOT);
		RegionRec rec = new RegionRec(id, p.planId(), p.irSha(), p.owner(), r.ext(), p.dimension(), ir.claim(), System.currentTimeMillis());
		List<String> stages = r.stages() == null ? ir.stages() : r.stages().stream().filter(ir.stages()::contains).toList();
		List<QItem> items = new ArrayList<>();
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
				QItem li = lotItem(level, rec, lot, entry, after, r);
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
		LoadPolicy load = r.load() != null ? r.load() : LoadPolicy.GENERATED_ONLY(Math.max(64, maxNeed + 36));
		rec.maxChunks = load.maxChunks();
		rec.generate = load.generate();
		rec.stats.addProperty("drift", drift.message());
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
		QBatch b = Batches.queueRegion(s, id, p.owner(), r.ext(), items, stages, load.maxChunks(), load.generate(), r.autoApprove());
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

	static String tileKey(String stage, String set, String key) {
		return "t:" + stage + ":" + set + ":" + key;
	}

	private static QItem tileItem(RegionRec rec, PlanRec p, String stage, String set, String key, List<String> after) {
		int[] t = Ir.tile(key);
		JsonObject ext = new JsonObject();
		ext.addProperty(RegionItems.EXT_TILE, stage + "|" + set + "|" + key);
		QItem q = new QItem(tileKey(stage, set, key), stage, after, "tile", rec.dimension, Heights.TILE * t[0], rec.claim[1], Heights.TILE * t[1], 0, false,
			ext, null, false, false);
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

	private static QItem roadItem(ServerLevel level, RegionRec rec, Ir.Road road, List<String> after) {
		List<BlockPos> pts = new ArrayList<>();
		road.points().forEach(pt -> pts.add(new BlockPos(pt[0], pt[1], pt[2])));
		var rr = new dev.larattalabs.architect.api.RoadRequest(level, pts, road.width(), road.surface(), null, road.lanterns(), false, Mode.INSTANT, rec.owner,
			new JsonObject(), null, true);
		return dev.larattalabs.architect.site.RegionQueue.roadItem(level, rec.id, "road:" + road.id(), road.stage(), after, rr);
	}

	private static @Nullable QItem lotItem(ServerLevel level, RegionRec rec, Ir.Lot lot, String entry, List<String> after, RealiseRequest r) {
		String bpId = entry.contains("@") ? entry.substring(0, entry.indexOf('@')) : entry;
		Blueprint bp = Blueprints.get(bpId);
		JsonObject ext = new JsonObject();
		ext.addProperty("architect_mc:lot", lot.id());
		int[] b = lot.box();
		QItem q;
		if (bp == null) {
			q = new QItem("lot:" + lot.id(), lot.stage(), after, bpId, rec.dimension, b[0], b[1], b[2], 0, false, ext, null, false, false);
			q.fail(Reason.UNKNOWN_BLUEPRINT.name(), "No design " + bpId + " in the library");
			return q;
		}
		LotFitting.Fit f = LotFitting.fit(bp, new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]), lot.front(), true, null, false);
		q = new QItem("lot:" + lot.id(), lot.stage(), after, bpId, rec.dimension, f.ox(), f.oy(), f.oz(), f.turns(), false, ext, r.actor() == null ? null
			: r.actor().getStringUUID(), false, false);
		q.layer = true;
		if (!f.fits()) {
			q.fail(Reason.LOT_TOO_SMALL.name(), "The lot is too small for " + bpId + ": " + f.why());
		}
		return q;
	}

	private static boolean overlaps(int[] a, int[] b) {
		return a[0] <= b[3] && b[0] <= a[3] && a[2] <= b[5] && b[2] <= a[5];
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
		dirty(l);
	}

	/** A tile's check counted its skipped cells. */
	public static void tileChecked(String region, String stage, Map<String, Long> skipped) {
		Live l = REGIONS.get(region);
		if (l != null) {
			skipped.forEach((k, v) -> l.rec().skip(k, v));
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
	}

	/** The region's batch ended. */
	public static void batchDone(QBatch b) {
		String region = b.ext.get(RegionItems.EXT_REGION).getAsString();
		Live l = REGIONS.get(region);
		if (l == null) {
			return;
		}
		boolean allPlaced = b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED);
		l.rec().state = b.status == QBatch.Status.DONE && allPlaced ? RegionState.PLACED : b.status == QBatch.Status.DONE ? RegionState.PARTIAL
			: RegionState.FAILED;
		l.rec().stats.addProperty("doneAt", System.currentTimeMillis());
		l.rec().stats.addProperty("generatedTerrainDuring", GenCounter.terrain() - (l.rec().stats.has("genTerrainAtStart") ? l.rec().stats.get(
			"genTerrainAtStart").getAsLong() : 0));
		l.rec().generatedWhileHeld = GenCounter.whileHeld();
		save(l);
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
		r.lots.forEach((id, ls) -> lots.add(new LotState(id, ls.siteId, ls.state)));
		Refusal waiting = null;
		QBatch b = Batches.get(r.batchId);
		if (b != null && b.running()) {
			for (QItem i : b.items) {
				if (i.status == QItem.Status.WAITING && i.reason != null) {
					waiting = new Refusal(Reason.valueOf(i.reason), i.message);
					break;
				}
			}
		}
		int[] c = r.claim;
		return new RegionView(r.id, r.planId, r.irSha, r.owner, r.ext, r.groupId, new BoundingBox(c[0], c[1], c[2], c[3], c[4], c[5]), r.state, st, lots,
			r.cellsWritten, r.skipped, waiting, Prepare.view(r.planId));
	}

	@Override
	public CompletableFuture<RemoveResult> remove(String regionId, RemoveOptions o) {
		MinecraftServer s = server;
		Live l = REGIONS.get(regionId);
		if (s == null || l == null) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("no region " + regionId));
		}
		return onServer(s, () -> {
			QBatch b = Batches.get(l.rec().batchId);
			if (b != null && b.running()) {
				return ArchitectApi.get().sites(s).cancelBatch(b.id).thenCompose(x -> removeGroup(s, l, o));
			}
			return removeGroup(s, l, o);
		}).thenCompose(f -> f);
	}

	private static CompletableFuture<RemoveResult> removeGroup(MinecraftServer s, Live l, RemoveOptions o) {
		l.rec().state = RegionState.REMOVING;
		save(l);
		SiteEvents.REGION_STATE.invoker().onState(view(l));
		return ArchitectApi.get().sites(s).removeGroup(l.rec().groupId, o).thenApply(res -> {
			s.execute(() -> {
				if (res.removed()) {
					REGIONS.remove(l.rec().id);
					Heights.forget(l.rec().id);
					TileStream.forgetRegion(l.rec().id);
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
				SiteEvents.REGION_STATE.invoker().onState(view(l));
			});
			return res;
		});
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
		o.add("view", com.google.gson.JsonParser.parseString(new com.google.gson.Gson().toJson(view(l))).getAsJsonObject());
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
			o.add("failed", longWaits);
			o.addProperty("batchStatus", b.status.name());
		}
		o.addProperty("starvedTicks", RegionItems.starvedTicks);
		o.addProperty("maxHeldWaitSeconds", RegionItems.maxHeldWaitSeconds);
		com.google.gson.JsonArray lw = new com.google.gson.JsonArray();
		RegionItems.LONG_WAITS.forEach(lw::add);
		o.add("longWaits", lw);
		o.addProperty("chunkLoads", GenCounter.loads());
		o.addProperty("writerTicks", RegionItems.writerTicks);
		o.addProperty("generatedTerrain", GenCounter.terrain());
		o.addProperty("generatedWhileHeld", GenCounter.whileHeld());
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
