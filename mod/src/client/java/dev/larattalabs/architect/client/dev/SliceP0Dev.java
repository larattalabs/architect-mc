package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ApprovedRealise;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlanArtifact;
import dev.larattalabs.architect.api.PlanBudget;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.api.PreviewView;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.region.TileStream;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * Phase 6c slice P0 DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT P0 §8): a plan check through the API, its key, cancel and images, the
 * artifact, its pins, realiseApproved, and the sha of each tile a realise received. Pure server work: generated for the headless server
 * too.
 */
public final class SliceP0Dev {
	private SliceP0Dev() {
	}

	static String reason(Throwable e) {
		Throwable c = e;
		while ((c instanceof java.util.concurrent.CompletionException || c instanceof java.util.concurrent.ExecutionException) && c.getCause() != null) {
			c = c.getCause();
		}
		if (c instanceof dev.larattalabs.architect.api.ArchitectRefused r) {
			return r.reason() + ": " + r.getMessage();
		}
		if (c instanceof java.util.concurrent.CancellationException) {
			return "CANCELLED: the check was cancelled";
		}
		return String.valueOf(c.getMessage());
	}

	static <T> CompletableFuture<JsonObject> wrap(CompletableFuture<T> f, java.util.function.Function<T, JsonObject> ok) {
		return f.handle((v, e) -> {
			if (e != null) {
				JsonObject o = new JsonObject();
				String r = reason(e);
				o.addProperty("refused", r);
				o.addProperty("reason", r.contains(":") ? r.substring(0, r.indexOf(':')) : r);
				return o;
			}
			return ok.apply(v);
		});
	}

	static JsonObject checkJson(PlanCheck pc) {
		JsonObject o = new JsonObject();
		o.addProperty("checkId", pc.checkId());
		o.addProperty("planSha", pc.planSha());
		o.addProperty("surveySha", pc.surveySha());
		o.addProperty("kitVersion", pc.kitVersion());
		o.addProperty("schemaVersion", pc.schemaVersion());
		o.addProperty("overall", pc.overall().name());
		JsonArray parts = new JsonArray();
		pc.parts().forEach(parts::add);
		o.add("parts", parts);
		o.add("cost", pc.cost());
		o.add("preview", pc.preview());
		o.addProperty("catalogueEntries", pc.catalogue().get("entries") instanceof JsonArray a ? a.size() : 0);
		if (pc.artifactSha() != null) {
			o.addProperty("artifactSha", pc.artifactSha());
		}
		JsonArray n = new JsonArray();
		pc.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static JsonObject artifactJson(PlanArtifact a, boolean body) {
		JsonObject o = new JsonObject();
		o.addProperty("sha", a.artifactSha());
		o.addProperty("planId", a.planId());
		o.addProperty("removed", a.removed());
		o.addProperty("removedAt", a.removedAt());
		JsonArray p = new JsonArray();
		a.pinnedBy().forEach(p::add);
		o.add("pinnedBy", p);
		JsonArray r = new JsonArray();
		a.regions().forEach(r::add);
		o.add("regions", r);
		if (body && a.body() != null) {
			o.add("body", a.body());
		}
		return o;
	}

	public static void init() {
		DevBridge.register("dev.region.checkPlan", 900_000, "{plan, claim: [x0,z0,x1,z1], anchors?: {name: [x,y,z]}, owner?, bible?, bibleVersion?, budget?: {maxNodes, maxEdges, "
			+ "maxCells, maxMs, maxHeapMb}, opKey?, cancelAfterMs?} - (6c P0) Regions.checkPlan -> {check: {checkId, overall, parts, cost, preview, artifactSha, ...}, ms} "
			+ "or {refused, reason}; cancelAfterMs cancels the future that long after the call (the answer is then CANCELLED)", (req, mc) -> {
				Fields f = Fields.of(req);
				JsonObject plan = req.getAsJsonObject("plan");
				JsonArray c = req.getAsJsonArray("claim");
				Map<String, BlockPos> anchors = new LinkedHashMap<>();
				if (req.get("anchors") instanceof JsonObject an) {
					an.entrySet().forEach(e -> {
						JsonArray a = e.getValue().getAsJsonArray();
						anchors.put(e.getKey(), new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
					});
				}
				String owner = f.optStr("owner", null);
				String bible = f.optStr("bible", null);
				Integer bibleVersion = req.has("bibleVersion") ? req.get("bibleVersion").getAsInt() : null;
				PlanBudget budget = null;
				if (req.get("budget") instanceof JsonObject b) {
					budget = new PlanBudget(b.has("maxNodes") ? b.get("maxNodes").getAsInt() : 0, b.has("maxEdges") ? b.get("maxEdges").getAsInt() : 0,
						b.has("maxCells") ? b.get("maxCells").getAsLong() : 0, b.has("maxMs") ? b.get("maxMs").getAsInt() : 0, b.has("maxHeapMb") ? b.get("maxHeapMb")
							.getAsInt() : 0);
				}
				PlanBudget bud = budget;
				String key = f.optStr("opKey", null);
				long cancelAfter = f.optLong("cancelAfterMs", -1, -1, 600_000);
				long t0 = System.nanoTime();
				return ServerTasks.callAsPlayer((level, player) -> {
					CompletableFuture<PlanCheck> fut = ArchitectApi.get().regions().checkPlan(new PlanRequest(plan, level, new BoundingBox(c.get(0).getAsInt(), level.getMinY(), c
						.get(1).getAsInt(), c.get(2).getAsInt(), level.getMaxY(), c.get(3).getAsInt()), anchors, owner, bible, bibleVersion, bud, key, new JsonObject()));
					if (cancelAfter >= 0) {
						CompletableFuture.delayedExecutor(cancelAfter, java.util.concurrent.TimeUnit.MILLISECONDS).execute(() -> fut.cancel(true));
					}
					return fut;
				}).thenCompose(x -> wrap(x, pc -> {
					JsonObject o = new JsonObject();
					o.add("check", checkJson(pc));
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				}));
			});
		DevBridge.register("dev.region.cancelCheck", 10_000, "{owner?, opKey} - (6c P0) Regions.cancelCheck -> {cancelled}", (req, mc) -> {
			Fields f = Fields.of(req);
			String owner = f.optStr("owner", null), key = f.nonBlank("opKey");
			return ServerTasks.callAsPlayer((level, player) -> {
				JsonObject o = new JsonObject();
				o.addProperty("cancelled", ArchitectApi.get().regions().cancelCheck(owner, key));
				return o;
			});
		});
		DevBridge.register("dev.region.checkByKey", 10_000, "{owner?, opKey} - (6c P0) Regions.checkByKey -> {check} (null when none)", (req, mc) -> {
			Fields f = Fields.of(req);
			String owner = f.optStr("owner", null), key = f.nonBlank("opKey");
			return ServerTasks.callAsPlayer((level, player) -> {
				JsonObject o = new JsonObject();
				ArchitectApi.get().regions().checkByKey(owner, key).ifPresentOrElse(pc -> o.add("check", checkJson(pc)), () -> o.add("check", null));
				return o;
			});
		});
		DevBridge.register("dev.region.planImages", 300_000, "{checkId, views?: [top|section|iso|siteplan]} - (6c P0) Regions.planImages -> {images: {view: [path]}}", (req, mc) -> {
			Fields f = Fields.of(req);
			String id = f.nonBlank("checkId");
			Set<PreviewView> views = EnumSet.noneOf(PreviewView.class);
			if (req.get("views") instanceof JsonArray a) {
				a.forEach(e -> views.add(PreviewView.valueOf(e.getAsString().toUpperCase(Locale.ROOT))));
			}
			return ServerTasks.callAsPlayer((level, player) -> ArchitectApi.get().regions().planImages(id, views)).thenCompose(x -> wrap(x, p -> {
				JsonObject o = new JsonObject();
				JsonObject im = new JsonObject();
				p.images().forEach((k, v) -> {
					JsonArray a = new JsonArray();
					v.forEach(path -> a.add(path.toString()));
					im.add(k.name().toLowerCase(Locale.ROOT), a);
				});
				o.add("images", im);
				return o;
			}));
		});
		DevBridge.register("dev.region.artifact", 10_000, "{sha, body?: false} - (6c P0) Regions.artifact -> {artifact: {sha, planId, removed, removedAt, pinnedBy, regions, body?}} "
			+ "(null when unknown)", (req, mc) -> {
				Fields f = Fields.of(req);
				String sha = f.nonBlank("sha");
				boolean body = f.optBool("body", false);
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					ArchitectApi.get().regions().artifact(sha).ifPresentOrElse(a -> o.add("artifact", artifactJson(a, body)), () -> o.add("artifact", null));
					return o;
				});
			});
		DevBridge.register("dev.region.pinArtifact", 10_000, "{sha, owner, on?: true} - (6c P0) Regions.pinArtifact / unpinArtifact -> {artifact}", (req, mc) -> {
			Fields f = Fields.of(req);
			String sha = f.nonBlank("sha"), owner = f.nonBlank("owner");
			boolean on = f.optBool("on", true);
			return ServerTasks.callAsPlayer((level, player) -> {
				if (on) {
					ArchitectApi.get().regions().pinArtifact(sha, owner);
				} else {
					ArchitectApi.get().regions().unpinArtifact(sha, owner);
				}
				JsonObject o = new JsonObject();
				ArchitectApi.get().regions().artifact(sha).ifPresentOrElse(a -> o.add("artifact", artifactJson(a, false)), () -> o.add("artifact", null));
				return o;
			});
		});
		DevBridge.register("dev.region.realiseApproved", 300_000, "{sha, lotEntries?: {lot: entry}, fill?: [entry...] (every provisional lot, the first that fits), opKey?} - "
			+ "(6c P0) Regions.realiseApproved -> {region} or {refused, reason}", (req, mc) -> {
				Fields f = Fields.of(req);
				String sha = f.nonBlank("sha");
				String key = f.optStr("opKey", null);
				Map<String, String> lots = new LinkedHashMap<>();
				if (req.get("lotEntries") instanceof JsonObject le) {
					le.entrySet().forEach(e -> lots.put(e.getKey(), e.getValue().getAsString()));
				}
				List<String> fill = new java.util.ArrayList<>();
				if (req.get("fill") instanceof JsonArray a) {
					a.forEach(e -> fill.add(e.getAsString()));
				}
				return ServerTasks.callAsPlayer((level, player) -> {
					if (!fill.isEmpty()) {
						ArchitectApi.get().regions().artifact(sha).ifPresent(a -> RegionsImpl.fitLots(a.planId(), fill).forEach(lots::putIfAbsent));
					}
					return ArchitectApi.get().regions().realiseApproved(new ApprovedRealise(sha, Mode.INSTANT, null, lots, key, new JsonObject()));
				}).thenCompose(x -> wrap(x, id -> {
					JsonObject o = new JsonObject();
					o.addProperty("region", id);
					return o;
				}));
			});
		DevBridge.register("dev.region.realiseByKey", 10_000, "{owner?, opKey} - (6c X C20 / P0 item 6) Regions.realiseByKey -> {region: {id, state, irSha, planId}} "
			+ "(null when none)", (req, mc) -> {
				Fields f = Fields.of(req);
				String owner = f.optStr("owner", null), key = f.nonBlank("opKey");
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					ArchitectApi.get().regions().realiseByKey(owner, key).ifPresentOrElse(v -> {
						JsonObject r = new JsonObject();
						r.addProperty("id", v.id());
						r.addProperty("state", v.state().name());
						r.addProperty("irSha", v.irSha());
						r.addProperty("planId", v.planId());
						o.add("region", r);
					}, () -> o.add("region", null));
					return o;
				});
			});
		// (C37b) Library.Entry.cells() against PlanChecks.cells (what realiseApproved compares with costRange[1]) and the sum of the Part cells
		DevBridge.register("dev.library.cells", 30_000, "{ids?: [entry]} - (C37b) per entry {id, entryCells (Library.Entry.cells()), planCells (PlanChecks.cells), partSum (the Part cells summed: NOT the count)} "
			+ "-> {entries: [...]} (every entry when ids is absent)", (req, mc) -> {
				java.util.Set<String> want = new java.util.HashSet<>();
				if (req.has("ids") && req.get("ids").isJsonArray()) {
					req.getAsJsonArray("ids").forEach(e -> want.add(e.getAsString()));
				}
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					JsonArray a = new JsonArray();
					for (var e : ArchitectApi.get().library().list()) {
						if (!want.isEmpty() && !want.contains(e.id())) {
							continue;
						}
						JsonObject r = new JsonObject();
						r.addProperty("id", e.id());
						r.addProperty("entryCells", e.cells());
						r.addProperty("planCells", dev.larattalabs.architect.region.PlanChecks.cells(e.id()));
						r.addProperty("partSum", e.parts().values().stream().mapToLong(p -> p.cells()).sum());
						a.add(r);
					}
					o.add("entries", a);
					return o;
				});
			});
		DevBridge.register("dev.region.tileShas", 10_000, "{region} - (6c P0) the sha of every tile a realise of the region received -> {tiles: {stage|set|key: sha}}",
			(req, mc) -> {
				String region = Fields.of(req).nonBlank("region");
				JsonObject o = new JsonObject();
				JsonObject t = new JsonObject();
				new TreeMap<>(TileStream.TILE_SHAS).forEach((k, v) -> {
					if (k.startsWith(region + "|")) {
						t.addProperty(k.substring(region.length() + 1), v);
					}
				});
				o.add("tiles", t);
				return CompletableFuture.completedFuture(o);
			});
	}

	static JsonElement nul() {
		return com.google.gson.JsonNull.INSTANCE;
	}
}
