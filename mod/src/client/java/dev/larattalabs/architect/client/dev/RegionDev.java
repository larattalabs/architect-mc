package dev.larattalabs.architect.client.dev;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CoveredPolicy;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PrepareRequest;
import dev.larattalabs.architect.api.RealiseRequest;
import dev.larattalabs.architect.api.RegionPlanRequest;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.ChunkGen;
import dev.larattalabs.architect.region.GenCounter;
import dev.larattalabs.architect.region.Prepare;
import dev.larattalabs.architect.region.RegionHash;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 6a DevBridge hooks (docs/DEVBRIDGE.md): regions (plan, prepare, realise, state, remove), sliced region hashes, snaps
 * and diffs, the chunk generation counter and chunk-status cost, the MSPT trace and the heap after a GC.
 */
public final class RegionDev {
	private static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

	private RegionDev() {
	}

	static JsonObject json(Object o) {
		return JsonParser.parseString(GSON.toJson(o)).getAsJsonObject();
	}

	static LoadPolicy load(String s) {
		if (s == null || s.equals("loaded")) {
			return LoadPolicy.LOADED_ONLY;
		}
		if (s.startsWith("generated:")) {
			return LoadPolicy.GENERATED_ONLY(Integer.parseInt(s.substring(10)));
		}
		if (s.startsWith("bounded:")) {
			return LoadPolicy.LOAD_BOUNDED(Integer.parseInt(s.substring(8)));
		}
		throw new DevBridge.DevException("load is loaded | generated:<n> | bounded:<n>");
	}

	private static String reason(Throwable e) {
		Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
		if (c instanceof RegionsImpl.RegionException r) {
			return r.reason + ": " + r.getMessage();
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

	public static void init() {
		DevBridge.register("dev.region.plan", 300_000, "{program, params?, claim: [x0,z0,x1,z1], seed?, surveyLoad?: loaded|generated:<n>|bounded:<n>, "
			+ "owner?} - phase 6a: Regions.plan -> the RegionPlan (+ ms) or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String program = f.nonBlank("program");
				JsonObject params = req.has("params") ? req.getAsJsonObject("params") : new JsonObject();
				JsonArray c = req.getAsJsonArray("claim");
				Long seed = req.has("seed") ? Long.parseUnsignedLong(req.get("seed").getAsString()) : null;
				LoadPolicy load = load(f.optStr("surveyLoad", "loaded"));
				String owner = f.optStr("owner", null);
				long t0 = System.nanoTime();
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> ArchitectApi.get().regions().plan(new RegionPlanRequest(program,
					params, level, new BoundingBox(c.get(0).getAsInt(), level.getMinY(), c.get(1).getAsInt(), c.get(2).getAsInt(), level.getMaxY(), c.get(3)
						.getAsInt()), seed, null, null, load, owner, new JsonObject())))).thenCompose(x -> x).thenCompose(x -> x).thenApply(x -> x).handle((p, e) -> {
							JsonObject o = e != null ? new JsonObject() : json(p);
							if (e != null) {
								o.addProperty("refused", reason(e));
							} else {
								int[] c = RegionsImpl.planClaim(p.planId());
								if (c != null) {
									JsonArray y = new JsonArray();
									y.add(c[1]);
									y.add(c[4]);
									o.add("claimY", y);
								}
							}
							o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
							return o;
						});
			});
		DevBridge.register("dev.region.prepare", 4 * 3_600_000L, "{planId, inFlight?, wait?: false} - phase 6a: Regions.prepare; with wait the "
			+ "answer comes when it is done -> PrepareView + the governor's numbers", (req, mc) -> {
				Fields f = Fields.of(req);
				String planId = f.nonBlank("planId");
				Integer inFlight = req.has("inFlight") ? req.get("inFlight").getAsInt() : null;
				boolean wait = f.optBool("wait", false);
				CompletableFuture<JsonObject> started = DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> ArchitectApi.get().regions()
					.prepare(new PrepareRequest(planId, inFlight)))).thenCompose(x -> x).thenApply(fut -> {
						if (!wait) {
							JsonObject o = new JsonObject();
							o.addProperty("started", true);
							return CompletableFuture.completedFuture(o);
						}
						return wrap(fut, v -> {
							JsonObject o = json(v);
							JsonObject st = Prepare.stats(planId);
							if (st != null) {
								o.add("stats", st);
							}
							return o;
						});
					}).thenCompose(x -> x);
				return started;
			});
		DevBridge.register("dev.region.prepare.state", 10_000, "{planId} - phase 6a: the prepare's view and governor numbers", (req, mc) -> {
			String planId = Fields.of(req).nonBlank("planId");
			return ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				ArchitectApi.get().regions().prepareState(planId).ifPresent(v -> o.add("view", json(v)));
				JsonObject st = Prepare.stats(planId);
				if (st != null) {
					o.add("stats", st);
				}
				return o;
			});
		});
		DevBridge.register("dev.region.cancelPrepare", 10_000, "{planId} - phase 6a: Regions.cancelPrepare", (req, mc) -> {
			String planId = Fields.of(req).nonBlank("planId");
			return ServerTasks.callOnServer(s -> {
				ArchitectApi.get().regions().cancelPrepare(planId);
				JsonObject o = new JsonObject();
				o.addProperty("cancelled", true);
				return o;
			});
		});
		DevBridge.register("dev.region.realise", 120_000, "{planId, lots?: {lotId: entry}, lotEntries?: [entry...] (every lot, round robin), "
			+ "load?: generated:<n>|loaded|bounded:<n> (default: generated, the bound from the items), autoApprove?: true, stages?, force?} - phase 6a: "
			+ "Regions.realise -> {region} or {refused}", (req, mc) -> {
				Fields f = Fields.of(req);
				String planId = f.nonBlank("planId");
				boolean auto = f.optBool("autoApprove", true);
				boolean force = f.optBool("force", false);
				LoadPolicy load = req.has("load") ? load(req.get("load").getAsString()) : null;
				List<String> stages = null;
				if (req.has("stages")) {
					stages = new ArrayList<>();
					for (JsonElement e : req.getAsJsonArray("stages")) {
						stages.add(e.getAsString());
					}
				}
				List<String> st = stages;
				return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> {
					Map<String, String> lots = new LinkedHashMap<>();
					if (req.has("lots")) {
						req.getAsJsonObject("lots").entrySet().forEach(e -> lots.put(e.getKey(), e.getValue().getAsString()));
					}
					if (req.has("lotEntries")) {
						List<String> entries = new ArrayList<>();
						req.getAsJsonArray("lotEntries").forEach(e -> entries.add(e.getAsString()));
						var plan = RegionsImpl.planLots(planId);
						for (int i = 0; i < plan.size(); i++) {
							lots.putIfAbsent(plan.get(i), entries.get(i % entries.size()));
						}
					}
					return wrap(ArchitectApi.get().regions().realise(new RealiseRequest(planId, Mode.INSTANT, null, lots, load, auto, st, force, new JsonObject())),
						id -> {
							JsonObject o = new JsonObject();
							o.addProperty("region", id);
							return o;
						});
				})).thenCompose(x -> x).thenCompose(x -> x);
			});
		DevBridge.register("dev.region.state", 10_000, "{region} - phase 6a: the RegionView, its record's numbers, the queue's item counts, "
			+ "writer starvation, tile streaming and generation counters", (req, mc) -> {
				String region = Fields.of(req).nonBlank("region");
				return ServerTasks.callOnServer(s -> RegionsImpl.devState(region));
			});
		DevBridge.register("dev.region.list", 10_000, "{} - phase 6a: every region (RegionView)", (req, mc) -> ServerTasks.callOnServer(s -> {
			JsonObject o = new JsonObject();
			JsonArray a = new JsonArray();
			ArchitectApi.get().regions().list(null).forEach(v -> a.add(json(v)));
			o.add("regions", a);
			return o;
		}));
		DevBridge.register("dev.region.remove", 4 * 3_600_000L, "{region, covered?: keep|cascade|refuse, force?} - phase 6a: Regions.remove (the group undo) "
			+ "-> RemoveResult + seconds", (req, mc) -> {
				Fields f = Fields.of(req);
				String region = f.nonBlank("region");
				CoveredPolicy cp = CoveredPolicy.valueOf(f.optStr("covered", "keep").toUpperCase(java.util.Locale.ROOT));
				boolean force = f.optBool("force", false);
				long t0 = System.nanoTime();
				return ServerTasks.callOnServer(s -> ArchitectApi.get().regions().remove(region, new RemoveOptions(force, null, cp))).thenCompose(x -> wrap(x,
					r -> {
						JsonObject o = json(r);
						o.addProperty("seconds", (System.nanoTime() - t0) / 1e9);
						return o;
					}));
			});
		DevBridge.register("dev.region.hash", 4 * 3_600_000L, "{box | region (its claim + margin), margin?: 8, ySpan?: [y0,y1], exclude?, mode?: hash|snap|diff, "
			+ "file?, cells?} - phase 4e/6a: SHA-256 over states and BE NBT; sliced over ticks per 64x64 tile (snap: to a file; diff: against one, "
			+ "every mismatch classified); a small box without region/mode answers at once as in 4e", (req, mc) -> {
				Fields f = Fields.of(req);
				String mode = f.optStr("mode", null);
				String region = f.optStr("region", null);
				if (mode == null && region == null && req.has("box")) {
					int[] b = JournalDev.six(req.get("box"));
					long volume = (long) (b[3] - b[0] + 1) * (b[4] - b[1] + 1) * (b[5] - b[2] + 1);
					if (volume <= 8_000_000) {
						return JournalDev.hashNow(mc, req);
					}
				}
				return ServerTasks.callOnServer(s -> {
					int[] box;
					if (region != null) {
						RegionsImpl.Live l = RegionsImpl.live(region);
						if (l == null) {
							throw new DevBridge.DevException("no region " + region);
						}
						int m = req.has("margin") ? req.get("margin").getAsInt() : 8;
						int[] c = l.rec().claim;
						box = new int[] {c[0] - m, c[1], c[2] - m, c[3] + m, c[4], c[5] + m};
					} else {
						box = JournalDev.six(req.get("box"));
					}
					if (req.has("ySpan")) {
						JsonArray ys = req.getAsJsonArray("ySpan");
						box[1] = ys.get(0).getAsInt();
						box[4] = ys.get(1).getAsInt();
					}
					List<int[]> ex = new ArrayList<>();
					if (req.has("exclude")) {
						req.getAsJsonArray("exclude").forEach(e -> ex.add(JournalDev.six(e)));
					}
					Path file = req.has("file") ? Path.of(req.get("file").getAsString()) : null;
					ServerLevel level = s.overworld();
					return RegionHash.start(level, box, ex, mode == null ? "hash" : mode, file).thenApply(o -> {
						JsonArray bb = new JsonArray();
						for (int v : box) {
							bb.add(v);
						}
						o.add("box", bb);
						return o;
					});
				}).thenCompose(x -> x);
			});
		DevBridge.register("dev.chunks.generated", 10_000, "{} - phase 6a: chunks generated this session: terrain (any status), full, and while a region "
			+ "item held tickets (the gate's counter: diff two answers)", (req, mc) -> {
				JsonObject o = new JsonObject();
				o.addProperty("terrain", GenCounter.terrain());
				o.addProperty("full", GenCounter.full());
				o.addProperty("whileHeld", GenCounter.whileHeld());
				o.addProperty("loads", GenCounter.loads());
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.chunks.status", 600_000, "{box: [x0,z0,x1,z1] (blocks)} - phase 6a: how many chunks of the box were fully generated, "
			+ "read without loading them (ChunkGen: the chunk map, then the stored Status through the IO worker), and the cost per chunk", (req, mc) -> {
				JsonArray b = req.getAsJsonArray("box");
				int x0 = b.get(0).getAsInt() >> 4;
				int z0 = b.get(1).getAsInt() >> 4;
				int x1 = b.get(2).getAsInt() >> 4;
				int z1 = b.get(3).getAsInt() >> 4;
				return ServerTasks.callOnServer(s -> {
					ServerLevel level = s.overworld();
					List<CompletableFuture<Boolean>> qs = new ArrayList<>();
					int loaded = 0;
					long t0 = System.nanoTime();
					for (int cx = x0; cx <= x1; cx++) {
						for (int cz = z0; cz <= z1; cz++) {
							long k = ChunkPos.pack(cx, cz);
							if (level.getChunkSource().getChunkNow(cx, cz) != null) {
								loaded++;
							}
							qs.add(ChunkGen.query(level, k));
						}
					}
					int loadedNow = loaded;
					return CompletableFuture.allOf(qs.toArray(new CompletableFuture[0])).thenApply(v -> {
						long ms = System.nanoTime() - t0;
						int gen = 0;
						for (CompletableFuture<Boolean> q : qs) {
							gen += q.join() ? 1 : 0;
						}
						double[] st = ChunkGen.stats();
						JsonObject o = new JsonObject();
						o.addProperty("chunks", qs.size());
						o.addProperty("generated", gen);
						o.addProperty("loaded", loadedNow);
						o.addProperty("wallMs", ms / 1e6);
						o.addProperty("usPerChunkWall", ms / 1e3 / Math.max(1, qs.size()));
						o.addProperty("scans", st[0]);
						o.addProperty("usPerScanMean", st[1]);
						return o;
					});
				}).thenCompose(x -> x);
			});
		DevBridge.register("dev.mspt.trace", 10_000, "{start | stop: true} - phase 6a: per-tick times: the whole tick, Architect's write slices, the rest; "
			+ "stop answers max, p99, ticks over 50 ms, and the same for ticks with no Architect write slice (lighting and chunk sending)", (req, mc) -> {
				boolean stop = Fields.of(req).optBool("stop", false);
				return CompletableFuture.completedFuture(stop ? dev.larattalabs.architect.region.MsptTrace.stop() : dev.larattalabs.architect.region.MsptTrace
					.start());
			});
		DevBridge.register("dev.heap.gc", 120_000, "{} - phase 6a: used heap (MB) after a forced GC (System.gc twice), and the max", (req, mc) -> {
			System.gc();
			System.gc();
			JsonObject o = new JsonObject();
			o.addProperty("usedMb", java.lang.management.ManagementFactory.getMemoryMXBean().getHeapMemoryUsage().getUsed() / 1048576.0);
			o.addProperty("maxMb", Runtime.getRuntime().maxMemory() / 1048576.0);
			return CompletableFuture.completedFuture(o);
		});
		DevBridge.register("dev.undo.mark", 120_000, "{sites: [...] | region + lotStage?} - phase 6a: remember what the sites' entries give back on undo",
			(req, mc) -> ServerTasks.callOnServer(s -> {
				List<String> sites = new ArrayList<>();
				if (req.has("sites")) {
					req.getAsJsonArray("sites").forEach(e -> sites.add(e.getAsString()));
				}
				try {
					return dev.larattalabs.architect.site.UndoCheck.mark(sites);
				} catch (java.io.IOException e) {
					throw new DevBridge.DevException(e.getMessage());
				}
			}));
		DevBridge.register("dev.undo.check", 120_000, "{} - phase 6a: the marked cells against the world now (mismatches)", (req, mc) -> ServerTasks
			.callOnServer(s -> dev.larattalabs.architect.site.UndoCheck.check(s.overworld())));
		DevBridge.register("dev.tiles.stats", 10_000, "{reset?} - phase 6a: tiles received, wire bytes and cells (bytes per cell)", (req, mc) -> {
			JsonObject o = new JsonObject();
			o.addProperty("received", TileStream.RECEIVED.get());
			o.addProperty("wireBytes", TileStream.WIRE_BYTES.get());
			o.addProperty("wireCells", TileStream.WIRE_CELLS.get());
			o.addProperty("bytesPerCell", TileStream.WIRE_BYTES.get() / Math.max(1.0, TileStream.WIRE_CELLS.get()));
			double[] l;
			synchronized (TileStream.LATENCY) {
				l = TileStream.LATENCY.stream().mapToDouble(Double::doubleValue).toArray();
				if (Fields.of(req).optBool("reset", false)) {
					TileStream.LATENCY.clear();
					TileStream.RECEIVED.set(0);
					TileStream.WIRE_BYTES.set(0);
					TileStream.WIRE_CELLS.set(0);
				}
			}
			java.util.Arrays.sort(l);
			o.addProperty("latencyP50Ms", l.length == 0 ? 0 : l[l.length / 2]);
			o.addProperty("latencyP99Ms", l.length == 0 ? 0 : l[Math.min(l.length - 1, (int) Math.floor(l.length * 0.99))]);
			return CompletableFuture.completedFuture(o);
		});
	}
}
