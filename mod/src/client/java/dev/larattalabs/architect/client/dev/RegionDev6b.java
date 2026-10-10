package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.PreviewView;
import dev.larattalabs.architect.api.RegionDesignRequest;
import dev.larattalabs.architect.api.Volume;
import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.api.WaitAction;
import dev.larattalabs.architect.client.placement.RegionGhost;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import dev.larattalabs.architect.region.Wire6b;
import dev.larattalabs.architect.region.volume.DumpJob;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 6b DevBridge hooks (docs/DEVBRIDGE.md, docs/CONTRACT.md phase 6b §6.5): region check, previews, design and nudge, the
 * volume survey, the region ghost, the scenario cameras, the mid-realise drop of the helper's plan data, the realised-world dump
 * (ARWD), the PLAN_STALE test hooks (gate item 10(b)) and plan progress.
 */
public final class RegionDev6b {
	private RegionDev6b() {
	}

	private static String reason(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		if (c instanceof RegionsImpl.RegionException r) {
			return r.reason + ": " + r.getMessage();
		}
		if (c instanceof dev.larattalabs.architect.api.RegionRefused r) {
			return r.reason() + ": " + r.getMessage();
		}
		return String.valueOf(c.getMessage());
	}

	private static <T> CompletableFuture<JsonObject> wrap(CompletableFuture<T> f, java.util.function.Function<T, JsonObject> ok) {
		return f.handle((v, e) -> {
			if (e != null) {
				JsonObject o = new JsonObject();
				o.addProperty("refused", reason(e));
				return o;
			}
			return ok.apply(v);
		});
	}

	static BoundingBox box6(JsonArray a) {
		if (a == null || a.size() != 6) {
			throw new DevBridge.DevException("box is [x0,y0,z0,x1,y1,z1]");
		}
		return BoundingBox.fromCorners(new net.minecraft.core.Vec3i(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()),
			new net.minecraft.core.Vec3i(a.get(3).getAsInt(), a.get(4).getAsInt(), a.get(5).getAsInt()));
	}

	public static void init() {
		DevBridge.register("dev.region.check", 900_000, "{planId} - phase 6b: Regions.check (region.check) -> {report, summary, ms} or {refused}",
			(req, mc) -> {
				String planId = Fields.of(req).nonBlank("planId");
				long t0 = System.nanoTime();
				return wrap(ServerTasks.callOnServer(s -> ArchitectApi.get().regions().check(planId)).thenCompose(x -> x), r -> {
					JsonObject o = new JsonObject();
					o.add("report", Wire6b.json(r));
					o.addProperty("summary", Wire6b.summary(r));
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				});
			});
		DevBridge.register("dev.region.preview", 900_000, "{planId, views?: [top|section|iso|siteplan], axes?: [[[x,y,z]...]...]} - phase 6b: "
			+ "Regions.previews (region.preview) -> {paths: {view: [path]}, sitePlan, ms} or {refused}", (req, mc) -> {
				String planId = Fields.of(req).nonBlank("planId");
				Set<PreviewView> views = EnumSet.noneOf(PreviewView.class);
				if (req.get("views") instanceof JsonArray v) {
					for (JsonElement e : v) {
						PreviewView pv = Wire6b.view(e.getAsString());
						if (pv == null) {
							throw new DevBridge.DevException("unknown view " + e.getAsString());
						}
						views.add(pv);
					}
				}
				List<List<BlockPos>> axes = new ArrayList<>();
				if (req.get("axes") instanceof JsonArray ax) {
					for (JsonElement a : ax) {
						List<BlockPos> pts = new ArrayList<>();
						a.getAsJsonArray().forEach(p -> {
							JsonArray q = p.getAsJsonArray();
							pts.add(new BlockPos(q.get(0).getAsInt(), q.get(1).getAsInt(), q.get(2).getAsInt()));
						});
						axes.add(pts);
					}
				}
				long t0 = System.nanoTime();
				return wrap(ServerTasks.callOnServer(s -> ArchitectApi.get().regions().previews(planId, views, axes)).thenCompose(x -> x), p -> {
					JsonObject o = Wire6b.json(p);
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				});
			});
		DevBridge.register("dev.region.design", 1_800_000, "{brief, card?: {site?, purpose?, style?, text?}, claim: [x0,z0,x1,z1], bible?, mustPass?, "
			+ "model?, budgetUsd?, requireFit?, owner?, wait?: true} - phase 6b: Regions.design; with wait (default) the answer comes when the design "
			+ "ended and, for a fit, its plan is accepted or failed -> {designId, status, error?, result, cost, ms}", (req, mc) -> {
				Fields f = Fields.of(req);
				String brief = f.nonBlank("brief");
				JsonArray c = req.getAsJsonArray("claim");
				if (c == null || c.size() != 4) {
					throw new DevBridge.DevException("claim is [x0,z0,x1,z1]");
				}
				RegionDesignRequest.Card card = null;
				if (req.get("card") instanceof JsonObject co) {
					card = new RegionDesignRequest.Card(str(co, "site"), str(co, "purpose"), str(co, "style"), str(co, "text"));
				}
				List<String> must = new ArrayList<>();
				if (req.get("mustPass") instanceof JsonArray m) {
					m.forEach(e -> must.add(e.getAsString()));
				}
				RegionDesignRequest.Card cd = card;
				String bible = f.optStr("bible", null);
				String model = f.optStr("model", null);
				Double budget = f.optNum("budgetUsd");
				boolean requireFit = f.optBool("requireFit", false);
				String owner = f.optStr("owner", null);
				boolean wait = f.optBool("wait", true);
				long t0 = System.nanoTime();
				CompletableFuture<String> id = DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> ArchitectApi.get().regions().design(
					new RegionDesignRequest(brief, cd, level, new BoundingBox(c.get(0).getAsInt(), level.getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(),
						level.getMaxY(), c.get(3).getAsInt()), bible, must, model, budget, requireFit, owner, new JsonObject())))).thenCompose(x -> x).thenCompose(
							x -> x);
				return id.thenCompose(designId -> wait ? waitDesign(designId, t0) : CompletableFuture.completedFuture(designJson(designId, null, t0)))
					.exceptionally(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("refused", reason(e));
						return o;
					});
			});
		DevBridge.register("dev.region.nudge", 120_000, "{region, action: MOVE_CLOSER|PREPARE|START_SIDECAR|APPROVE_STAGE|REPLAN|RETRY} - phase 6b (RETRY: 6c 0a): "
			+ "Regions.nudge -> {done, message, actions (before)}", (req, mc) -> {
				Fields f = Fields.of(req);
				String region = f.nonBlank("region");
				WaitAction.Kind k;
				try {
					k = WaitAction.Kind.valueOf(f.nonBlank("action").toUpperCase(Locale.ROOT));
				} catch (IllegalArgumentException e) {
					throw new DevBridge.DevException("action is MOVE_CLOSER | PREPARE | START_SIDECAR | APPROVE_STAGE | REPLAN | RETRY");
				}
				return ServerTasks.callOnServer(s -> {
					JsonArray before = ArchitectApi.get().regions().get(region).map(v -> Wire6b.json(v.actions())).orElse(new JsonArray());
					return ArchitectApi.get().regions().nudge(region, k).thenApply(r -> {
						JsonObject o = new JsonObject();
						o.addProperty("done", r.done());
						o.addProperty("message", r.message());
						o.add("actions", before);
						return o;
					});
				}).thenCompose(x -> x).exceptionally(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("refused", reason(e));
					return o;
				});
			});
		DevBridge.register("dev.survey.volume", 1_800_000, "{box: [x0,y0,z0,x1,y1,z1], load?: loaded|generated:<n>|bounded:<n>} - phase 6b: "
			+ "Survey.volume -> {sha, blobId, counts, missingColumns, stats, cells, ms, ticks, maxTickMs, sampleMs, bytes, bytesPerCell, file, "
			+ "chunksLoaded, maxCells}", (req, mc) -> {
				Fields f = Fields.of(req);
				BoundingBox box = box6(req.getAsJsonArray("box"));
				var load = RegionDev.load(f.optStr("load", "loaded"));
				return ServerTasks.callAsPlayer((level, player) -> VolumeSurvey.start(level, box, load, null).thenCompose(r ->
					dev.larattalabs.architect.apiimpl.SurveyImpl.upload(r).thenApply(v -> volumeJson(v, r.measure())))).thenCompose(x -> x).exceptionally(e -> {
						JsonObject o = new JsonObject();
						o.addProperty("refused", reason(e));
						return o;
					});
			});
		DevBridge.register("dev.region.ghost", 120_000, "{planId, stage?} | {off: true} | {} - phase 6b: the region ghost (previewRegion) on or off; "
			+ "{} reports it -> {on, planId, stage, tiles, tilesRequested, tilesShown, cellsShown, verdict, errors}; take shots with dev.screenshot",
			(req, mc) -> {
				Fields f = Fields.of(req);
				if (f.optBool("off", false)) {
					return DevBridge.onClient(mc, () -> {
						RegionGhost.hide();
						return RegionGhost.state();
					});
				}
				if (!req.has("planId")) {
					return DevBridge.onClient(mc, RegionGhost::state);
				}
				String planId = f.nonBlank("planId");
				String stage = f.optStr("stage", null);
				return DevBridge.onClient(mc, () -> RegionGhost.show(planId, stage)).thenCompose(x -> x).thenApply(p -> {
					JsonObject o = new JsonObject();
					o.addProperty("on", true);
					o.addProperty("planId", p.planId());
					o.addProperty("tiles", p.tiles().size());
					o.addProperty("verdict", p.verdict());
					return o;
				}).exceptionally(e -> {
					JsonObject o = new JsonObject();
					o.addProperty("refused", reason(e));
					return o;
				});
			});
		DevBridge.register("dev.scenario.cams", 60_000, "{scenario: <id or path to scenarios/<id>.json> | cams: {name: [x,y,z,yaw,pitch]}, cam?: name} - "
			+ "phase 6b: fixed time 6000 and clear weather, then (with cam) the camera as a spectator at that cam (dev.camera) for dev.screenshot "
			+ "-> {cams: [names], at?}", (req, mc) -> {
				Fields f = Fields.of(req);
				JsonObject cams = req.get("cams") instanceof JsonObject co ? co : camsOf(f.nonBlank("scenario"));
				String cam = f.optStr("cam", null);
				CompletableFuture<Void> world = ServerTasks.callOnServer(s -> {
					var src = s.createCommandSourceStack().withSuppressedOutput();
					s.getCommands().performPrefixedCommand(src, "time set 6000");
					s.getCommands().performPrefixedCommand(src, "weather clear 1000000");
					return null;
				});
				return world.thenCompose(v -> {
					JsonObject o = new JsonObject();
					JsonArray names = new JsonArray();
					cams.keySet().forEach(names::add);
					o.add("cams", names);
					if (cam == null) {
						return CompletableFuture.completedFuture(o);
					}
					if (!(cams.get(cam) instanceof JsonArray a) || a.size() != 5) {
						throw new DevBridge.DevException("no cam " + cam + " (a cam is [x,y,z,yaw,pitch])");
					}
					JsonObject c = new JsonObject();
					c.add("x", a.get(0));
					c.add("y", a.get(1));
					c.add("z", a.get(2));
					c.add("yaw", a.get(3));
					c.add("pitch", a.get(4));
					c.addProperty("mode", "spectator");
					return DevCommands.camera(c, mc).thenApply(r -> {
						o.addProperty("at", cam);
						o.add("camera", r);
						return o;
					});
				});
			});
		DevBridge.register("dev.region.drop", 30_000, "{planId, after: <tiles written>} | {off: true} - phase 6b (gate 10(a)): after the region of "
			+ "planId has written that many tiles, deletes the helper's plan dir (<data>/regions/plans/<planId>) and its cached blobs "
			+ "(<data>/regions/blobs/<sha>.bin of the plan's side blobs) and sends region.release {planId} (the helper drops its in-memory IR "
			+ "and blobs); the realise must resume through ir_unknown and blob_unknown -> {armed} ; dev.region.drop.state -> {dropped, at, deleted}",
			(req, mc) -> {
				Fields f = Fields.of(req);
				if (f.optBool("off", false)) {
					RegionsImpl.TILE_HOOK = null;
					return CompletableFuture.completedFuture(json("armed", false));
				}
				String planId = f.nonBlank("planId");
				int after = f.optInt("after", 1, 0, 1_000_000);
				new java.util.ArrayList<>(DROP.keySet()).forEach(DROP::remove);
				RegionsImpl.TILE_HOOK = (live, done) -> {
					if (!live.rec().planId.equals(planId) || done < after || DROP.has("dropped")) {
						return;
					}
					RegionsImpl.TILE_HOOK = null;
					DROP.addProperty("dropped", true);
					DROP.addProperty("at", done);
					DROP.add("deleted", dropPlan(planId, live.ir().blobShas()));
				};
				return CompletableFuture.completedFuture(json("armed", true));
			});
		DevBridge.register("dev.region.drop.state", 10_000, "{} - phase 6b: what dev.region.drop did", (req, mc) -> CompletableFuture.completedFuture(
			DROP.deepCopy()));
		DevBridge.register("dev.region.dump", 1_800_000, "{box: [x0,y0,z0,x1,y1,z1], light?: true, file} - phase 6b: the ARWD dump of the box "
			+ "(kit/REGIONS.md), sliced over ticks; file absolute or relative to the game dir -> {file, cells, bytes, rawBytes, sha, palette, light, "
			+ "unloadedChunks, ms, ticks, maxTickMs}", (req, mc) -> {
				Fields f = Fields.of(req);
				BoundingBox b = box6(req.getAsJsonArray("box"));
				boolean light = f.optBool("light", true);
				Path file = Path.of(f.nonBlank("file"));
				Path out = file.isAbsolute() ? file : FabricLoader.getInstance().getGameDir().resolve(file);
				int[] box = {b.minX(), b.minY(), b.minZ(), b.maxX(), b.maxY(), b.maxZ()};
				return ServerTasks.callAsPlayer((level, player) -> DumpJob.start(level, box, light, out)).thenCompose(x -> x).thenApply(m -> {
					JsonObject o = new JsonObject();
					m.forEach((k, v) -> {
						if (v instanceof Number n) {
							o.addProperty(k, n);
						} else if (v instanceof Boolean bo) {
							o.addProperty(k, bo);
						} else {
							o.addProperty(k, String.valueOf(v));
						}
					});
					return o;
				}).exceptionally(e -> json("refused", reason(e)));
			});
		DevBridge.register("dev.region.planStale", 60_000, "{at: accept|realise|resume, planId? (realise), region? (resume), format?, kitVersion?, "
			+ "requires?: [kind]} - phase 6b (gate 10(b)): doctors an IR so the PLAN_STALE gate fires. accept: the next plan's IR (then call "
			+ "dev.region.plan: it must refuse PLAN_STALE); realise: the held plan's IR (then dev.region.realise must refuse); resume: the "
			+ "region's IR in memory and ir.json (its items wait PLAN_STALE now and after a relog; dev.region.hash must not change) -> {doctored, "
			+ "stale}", (req, mc) -> {
				Fields f = Fields.of(req);
				String at = f.nonBlank("at");
				JsonObject members = new JsonObject();
				if (req.has("format")) {
					members.addProperty("format", req.get("format").getAsInt());
				}
				if (req.has("kitVersion")) {
					members.addProperty("kitVersion", req.get("kitVersion").getAsString());
				}
				if (req.get("requires") instanceof JsonArray r) {
					members.add("requires", r.deepCopy());
				}
				if (members.size() == 0) {
					members.addProperty("format", 3);
				}
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					switch (at) {
						case "accept" -> {
							RegionsImpl.DOCTOR_NEXT_PLAN = members;
							o.addProperty("doctored", true);
							o.addProperty("stale", RegionsImpl.staleReason(members));
						}
						case "realise" -> {
							String planId = f.nonBlank("planId");
							o.addProperty("doctored", RegionsImpl.doctorPlan(planId, members));
						}
						case "resume" -> {
							String region = f.nonBlank("region");
							o.addProperty("doctored", RegionsImpl.doctorRegion(region, members));
							RegionsImpl.Live l = RegionsImpl.live(region);
							if (l != null) {
								o.addProperty("stale", RegionsImpl.staleOf(l));
							}
						}
						default -> throw new DevBridge.DevException("at is accept | realise | resume");
					}
					return o;
				});
			});
		DevBridge.register("dev.region.progress", 10_000, "{planId} - phase 6b: the phases a plan went through (planning, checking, rendering, "
			+ "accepted)", (req, mc) -> {
				String planId = Fields.of(req).nonBlank("planId");
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				RegionsImpl.progressOf(planId).forEach(a::add);
				o.add("phases", a);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.tiles.resends", 10_000, "{reset?} - phase 6b: tile re-requests by reason (ir, blob)", (req, mc) -> {
			JsonObject o = new JsonObject();
			TileStream.RESENDS.forEach((k, v) -> o.addProperty(k, v.get()));
			if (Fields.of(req).optBool("reset", false)) {
				TileStream.RESENDS.clear();
			}
			return CompletableFuture.completedFuture(o);
		});
	}

	private static final JsonObject DROP = new JsonObject();

	/** Deletes the helper's plan dir and the plan's cached blobs, then asks it to release the plan from memory. */
	static JsonArray dropPlan(String planId, List<String> shas) {
		JsonArray deleted = new JsonArray();
		Path regions = Sidecar.dataDir().resolve("regions").toAbsolutePath().normalize();
		Path dir = regions.resolve("plans").resolve(planId).normalize();
		if (dir.startsWith(regions) && Files.isDirectory(dir)) {
			try (var w = Files.walk(dir)) {
				for (Path p : w.sorted(java.util.Comparator.reverseOrder()).toList()) {
					Files.deleteIfExists(p);
				}
				deleted.add(dir.toString());
			} catch (IOException e) {
				deleted.add("failed " + dir + ": " + e.getMessage());
			}
		}
		for (String sha : shas) {
			Path b = regions.resolve("blobs").resolve(sha + ".bin");
			try {
				if (Files.deleteIfExists(b)) {
					deleted.add(b.toString());
				}
			} catch (IOException e) {
				deleted.add("failed " + b + ": " + e.getMessage());
			}
		}
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.release");
		m.addProperty("planId", planId);
		m.addProperty("evict", true); // the IR goes even when another plan (an earlier run's) shares its sha
		Sidecar.link().send(m);
		return deleted;
	}

	static JsonObject camsOf(String scenario) {
		Path p = scenario.endsWith(".json") || scenario.contains("/") ? Path.of(scenario) : repo().resolve("scenarios").resolve(scenario + ".json");
		try {
			JsonObject o = JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8)).getAsJsonObject();
			if (!(o.get("cams") instanceof JsonObject c)) {
				throw new DevBridge.DevException(p + " has no cams");
			}
			return c;
		} catch (IOException e) {
			throw new DevBridge.DevException("scenario " + p + " unreadable: " + e.getMessage());
		}
	}

	/** The repository root: $ARCHITECT_REPO, else the dev run dir's grandparent (mod/run -> the checkout). */
	static Path repo() {
		String env = System.getenv("ARCHITECT_REPO");
		return env != null ? Path.of(env) : FabricLoader.getInstance().getGameDir().toAbsolutePath().normalize().getParent().getParent();
	}

	static CompletableFuture<JsonObject> waitDesign(String designId, long t0) {
		CompletableFuture<JsonObject> out = new CompletableFuture<>();
		java.util.concurrent.ScheduledExecutorService ex = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
			Thread t = new Thread(r, "dev.region.design wait");
			t.setDaemon(true);
			return t;
		});
		ex.scheduleAtFixedRate(() -> {
			if (out.isDone()) {
				return;
			}
			ServerTasks.callOnServer(s -> ArchitectApi.get().designs().get(designId).orElse(null)).whenComplete((d, e) -> {
				if (e != null || d == null || !d.status().isFinal()) {
					return;
				}
				JsonObject res = d.result().orElse(null);
				boolean fit = res != null && "PICKED".equals(str(res, "outcome")) && (!res.has("fits") || res.get("fits").getAsBoolean());
				if (d.status() == Design.Status.DONE && fit && !res.has("planId") && !res.has("planError")) {
					return; // the mod is planning the pick
				}
				out.complete(designJson(designId, d, t0));
			});
		}, 500, 1000, TimeUnit.MILLISECONDS);
		return out.orTimeout(1_790, TimeUnit.SECONDS).whenComplete((v, e) -> ex.shutdownNow());
	}

	static JsonObject designJson(String designId, Design d, long t0) {
		JsonObject o = new JsonObject();
		o.addProperty("designId", designId);
		if (d != null) {
			o.addProperty("status", d.status().name());
			o.addProperty("kind", d.kind().name());
			d.error().ifPresent(e -> o.addProperty("error", e));
			d.result().ifPresent(r -> o.add("result", r));
			o.addProperty("costUsd", d.cost().usd());
		}
		o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
		return o;
	}

	static JsonObject volumeJson(Volume v, VolumeSurvey.Measure m) {
		JsonObject o = new JsonObject();
		o.addProperty("sha", v.sha());
		o.addProperty("blobId", v.blobId());
		JsonObject c = new JsonObject();
		for (Map.Entry<VoxelClass, Long> e : v.counts().entrySet()) {
			c.addProperty(e.getKey().name(), e.getValue());
		}
		o.add("counts", c);
		o.addProperty("missingColumns", v.missingColumns());
		JsonObject st = new JsonObject();
		st.addProperty("surfaceColumns", v.stats().surfaceColumns());
		st.addProperty("meanSlope", v.stats().meanSlope());
		st.addProperty("steepFraction", v.stats().steepFraction());
		st.addProperty("overhangFraction", v.stats().overhangFraction());
		st.addProperty("treeCells", v.stats().treeCells());
		st.addProperty("caveCells", v.stats().caveCells());
		st.addProperty("trees", v.stats().trees());
		st.addProperty("caves", v.stats().caves());
		o.add("stats", st);
		o.addProperty("cells", m.cells());
		o.addProperty("ms", m.ms());
		o.addProperty("ticks", m.ticks());
		o.addProperty("maxTickMs", m.maxTickMs());
		o.addProperty("sampleMs", m.sampleMs());
		o.addProperty("cellsPerSecond", m.sampleMs() > 0 ? m.cells() / (m.sampleMs() / 1000) : 0);
		o.addProperty("bytes", m.bytes());
		o.addProperty("bytesPerCell", m.bytesPerCell());
		o.addProperty("file", m.file());
		o.addProperty("chunksLoaded", m.chunksLoaded());
		o.addProperty("maxCells", VolumeSurvey.MAX_CELLS);
		return o;
	}

	static String str(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : null;
	}

	static JsonObject json(String k, Object v) {
		JsonObject o = new JsonObject();
		if (v instanceof Boolean b) {
			o.addProperty(k, b);
		} else {
			o.addProperty(k, String.valueOf(v));
		}
		return o;
	}

	static Minecraft mc() {
		return Minecraft.getInstance();
	}
}
