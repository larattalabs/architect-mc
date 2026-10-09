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
	/** (6b) The server a plan was asked on (its region.progress lands there). */
	private static final Map<String, MinecraftServer> PLAN_SERVER = new ConcurrentHashMap<>();
	/** (6b) Per plan: the phases it went through (planning, checking, rendering, accepted), for RegionPlan.notes and DevBridge. */
	private static final Map<String, List<String>> PROGRESS = new ConcurrentHashMap<>();
	/** (6b) Regions whose IR is stale (PLAN_STALE at resume): region -> the message. */
	private static final Map<String, String> STALE_LOGGED = new ConcurrentHashMap<>();
	/** (6b) The last actions each region showed (REGION_STATE fires when they change). Server thread. */
	private static final Map<String, List<dev.larattalabs.architect.api.WaitAction>> LAST_ACTIONS = new HashMap<>();
	private static volatile @Nullable String lastKitWarning;
	/** Per-stage drift checks running ({@code region/stage}). Server thread. */
	private static final Map<String, CompletableFuture<Drift.Result>> STAGE_CHECKS = new HashMap<>();
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
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(s -> Heights.flush());
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			server = null;
			REGIONS.clear();
			PLANS.clear();
			Heights.forget(null);
			TileStream.forgetRegion(null);
			Prepare.stopAll();
			STAGE_CHECKS.clear();
			GENERATED.clear();
			GenCounter.realising(false);
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(s -> {
			RegionSurvey.tick(s);
			Prepare.tick(s);
			RegionHash.tick(s);
			generatedDuringRealise(s);
			actionsTick(s);
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
		warnKitMismatch();
		int res = (long) c.getXSpan() * c.getZSpan() <= 256L * 256 ? 1 : 4;
		progress(s, null, "planning");
		CompletableFuture<RegionPlan> out = RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), res, r.surveyLoad()).thenCompose(cols -> {
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> planOnce(link, r, blobId, surveySha, survey, null).thenCompose(o -> {
				JsonObject planned = (JsonObject) o[0];
				JsonArray need = planned.has("needVolumes") && planned.get("needVolumes").isJsonArray() ? planned.getAsJsonArray("needVolumes")
					: new JsonArray();
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
		}).thenCompose(o -> onServer(s, () -> finishPlan(r, (JsonObject) o[0], (JsonObject) o[1], (byte[]) o[2]))).thenCompose(f -> f);
		out.whenComplete((p, e) -> {
			if (e != null) {
				progress(s, null, "failed");
			}
		});
		return out;
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
		BoundingBox c = r.claim();
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
		if (!checkOf(r)) {
			m.addProperty("check", false);
		}
		if (volumes != null) {
			m.add("volumes", volumes);
		}
		MinecraftServer s = r.level().getServer();
		return link.send(m).thenCompose(ack -> {
			if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
				return CompletableFuture.failedFuture(new IllegalStateException("the helper refused the plan: " + str(ack, "error")));
			}
			String planId = ack.getAsJsonObject("result").get("planId").getAsString();
			PLAN_SERVER.put(planId, s);
			CompletableFuture<JsonObject> done = PLANNING.computeIfAbsent(planId, k -> new CompletableFuture<>());
			long timeout = checkOf(r) ? 600 : 120; // the checker and the renders: mega_bench full resolution up to 120 s + 30 s
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
				planned.addProperty("planId", planId);
				planned.addProperty("surveySha", surveySha);
				return new Object[] {planned, irJson, survey};
			}));
		});
	}

	private static void addNote(JsonObject planned, String note) {
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
		MinecraftServer s = level.getServer();
		return onServer(s, () -> {
			long cells = 0;
			List<BoundingBox> boxes = new ArrayList<>();
			for (JsonElement e : need) {
				JsonObject b = e.getAsJsonObject();
				BoundingBox bb = new BoundingBox(b.get("minX").getAsInt(), b.get("minY").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(), b.get(
					"maxY").getAsInt(), b.get("maxZ").getAsInt());
				boxes.add(bb);
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
			return CompletableFuture.allOf(qs.toArray(new CompletableFuture[0])).thenCompose(v -> {
				if (qs.stream().anyMatch(q -> !q.join())) {
					return CompletableFuture.<@Nullable JsonArray>completedFuture(null);
				}
				CompletableFuture<JsonArray> chain = CompletableFuture.completedFuture(new JsonArray());
				for (BoundingBox bb : boxes) {
					chain = chain.thenCompose(arr -> dev.larattalabs.architect.region.volume.VolumeSurvey.start(level, bb,
						dev.larattalabs.architect.api.LoadPolicy.GENERATED_ONLY(bound), null).thenCompose(
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
			Wire6b.previews(pl.get("previews"), pl.get("sitePlan")), format);
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
		if (p == null) {
			throw refusal(Reason.OTHER, "no region plan " + r.planId());
		}
		String stale = staleReason(p.ir().json());
		if (stale != null) {
			throw refusal(Reason.PLAN_STALE, stale);
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
		if (blobError != null) {
			throw refusal(Reason.OTHER, blobError); // (6b) "blob <sha> missing": before any write
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
		String id = reserved != null ? reserved : "rg" + nextRegion++;
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
		LotFitting.Fit f = LotFitting.fit(bp, new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]), lot.front(), true, 0, true);
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

	// ------------------------------------------------------------------ chunks generated during a realise (diagnosis)

	/** Per region: the first {@link #GEN_LOGGED} chunks generated while it realised ({@code x,z holder ...}). Server thread. */
	private static final Map<String, List<String>> GENERATED = new HashMap<>();
	static final int GEN_LOGGED = 1000;

	/**
	 * Every tick: whether a region realises (the mixin queues generated chunks only then), and the chunks generated during a
	 * realise since the last tick, attributed and logged whatever {@code ARCHITECT_TRACE_JOBS} says: the first 1000 per region
	 * with their position, the Architect ticket holding them (if any), whether a prepare runs, the nearest player's distance in
	 * chunks against the view distance, and whether they lie in the claim + 2 chunks. Counted always
	 * ({@code stats.generatedDuringRealise}). The gate's "0 generated during realise" and its unexplained 161 are what this is for.
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
		long[] gen = GenCounter.drain();
		if (gen.length <= 1 && gen[0] == 0 || running.isEmpty()) {
			return;
		}
		int view = s.getPlayerList().getViewDistance();
		boolean preparing = Prepare.running();
		for (Live l : running) {
			RegionRec rec = l.rec();
			long n = (rec.stats.has("generatedDuringRealise") ? rec.stats.get("generatedDuringRealise").getAsLong() : 0) + gen.length - 1 + gen[0];
			rec.stats.addProperty("generatedDuringRealise", n);
			List<String> list = GENERATED.computeIfAbsent(rec.id, k -> new ArrayList<>());
			int[] c = rec.claim;
			for (int k = 1; k < gen.length && list.size() < GEN_LOGGED; k++) {
				int cx = net.minecraft.world.level.ChunkPos.getX(gen[k]);
				int cz = net.minecraft.world.level.ChunkPos.getZ(gen[k]);
				String holder = Batches.ticketHolder(gen[k]);
				int near = Integer.MAX_VALUE;
				for (var p : s.getPlayerList().getPlayers()) {
					near = Math.min(near, Math.max(Math.abs((p.getBlockX() >> 4) - cx), Math.abs((p.getBlockZ() >> 4) - cz)));
				}
				boolean inClaim = cx >= (c[0] >> 4) - 2 && cx <= (c[3] >> 4) + 2 && cz >= (c[2] >> 4) - 2 && cz <= (c[5] >> 4) + 2;
				String e = cx + "," + cz + " ticket " + (holder == null ? "none" : holder) + "; prepare " + (preparing ? "running" : "idle") + "; player "
					+ (near == Integer.MAX_VALUE ? "none" : near + " chunks away (view " + view + ")") + "; " + (inClaim ? "in" : "outside") + " the claim + 2";
				list.add(e);
				Architect.LOGGER.info("Region {}: chunk {} generated during realise (#{}): {}", rec.id, cx + "," + cz, list.size(), e);
			}
			if (gen[0] > 0) {
				Architect.LOGGER.info("Region {}: {} more chunks generated during realise (not attributed: queue full)", rec.id, gen[0]);
			}
		}
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
		if (!rec.stages.containsKey(stage)) {
			return true;
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
		dirty(l);
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
		boolean allPlaced = b.items.stream().allMatch(i -> i.status == QItem.Status.PLACED);
		l.rec().state = b.status == QBatch.Status.DONE && allPlaced ? RegionState.PLACED : b.status == QBatch.Status.DONE ? RegionState.PARTIAL
			: RegionState.FAILED;
		l.rec().stats.addProperty("doneAt", System.currentTimeMillis());
		l.rec().stats.addProperty("generatedTerrainDuring", GenCounter.terrain() - (l.rec().stats.has("genTerrainAtStart") ? l.rec().stats.get(
			"genTerrainAtStart").getAsLong() : 0));
		l.rec().generatedWhileHeld = GenCounter.whileHeld();
		save(l);
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
			r.cellsWritten, r.skipped, waiting, pv, actions);
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
			if (was != null && !was.equals(v.actions()) || was == null && !v.actions().isEmpty()) {
				SiteEvents.REGION_STATE.invoker().onState(v);
			}
		}
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
				if (bp != null && LotFitting.fit(bp, new Anchors.Bounds(b[0], b[1], b[2], b[3], b[4], b[5]), l.front(), true, 0, true).fits()
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
