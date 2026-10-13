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
		RegionPlanRequest rp = new RegionPlanRequest(PROGRAM, params, level, c, null, r.bible(), r.bibleVersion(), LoadPolicy.LOADED_ONLY, r.owner(), new JsonObject(),
			null);
		JsonObject extra = new JsonObject();
		extra.addProperty("planCache", r.owner() == null ? "player" : r.owner());
		JsonArray views = new JsonArray();
		views.add("siteplan");
		extra.add("previewViews", views);
		extra.addProperty("timeoutMs", Math.min(600_000, budget.maxMs() + GRACE_MS));
		extra.addProperty("heapMb", Math.max(64, budget.maxHeapMb()));
		CompletableFuture<PlanCheck> out = new CompletableFuture<>();
		RegionsImpl.progress(s, null, "planning");
		RegionSurvey.sample(level, c.minX(), c.minZ(), c.maxX(), c.maxZ(), 1, LoadPolicy.LOADED_ONLY).thenCompose(cols -> {
			byte[] survey = cols.encode();
			String surveySha = Packed.sha256(survey);
			return BlobPut.put(link, survey, "survey").thenCompose(blobId -> RegionsImpl.planOnce(link, rp, blobId, surveySha, survey, null, false, extra));
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
				}
				PlanCheck pc = fromPlanned(plan.planId(), planned);
				if (!out.isCancelled()) {
					keep(s, pc, planned, r, key, hash);
				}
				return pc;
			});
		})).thenCompose(f -> f).whenComplete((pc, e) -> {
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
				&& a.isJsonPrimitive() ? a.getAsString() : null, notes);
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

	private static Set<String> pins(Path dir, String sha) throws IOException {
		Set<String> out = new LinkedHashSet<>();
		JsonObject p = RegionStore.readJson(dir.resolve(sha + ".pins.json"));
		if (p != null && p.get("owners") instanceof JsonArray a) {
			a.forEach(e -> out.add(e.getAsString()));
		}
		return out;
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
			Set<String> pins = pins(dir, sha);
			boolean changed = on ? pins.add(owner) : pins.remove(owner);
			if (changed) {
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				pins.stream().sorted().forEach(a::add);
				o.add("owners", a);
				RegionStore.writeJson(dir.resolve(sha + ".pins.json"), o);
			}
			if (!on && pins.isEmpty() && regionsOf(sha).isEmpty()) {
				// no pin and no standing region refers to it: removed, a tombstone left (C22's pattern)
				JsonObject t = new JsonObject();
				t.addProperty("removedAt", System.currentTimeMillis());
				RegionStore.writeJson(dir.resolve(sha + ".removed.json"), t);
				Files.deleteIfExists(dir.resolve(sha + ".json"));
				Files.deleteIfExists(dir.resolve(sha + ".pins.json"));
				Architect.LOGGER.info("Artifact {} removed (no pin, no region)", sha.substring(0, 12));
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Artifact {} pins: {}", sha, e.toString());
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
		if (!p.irSha().equals(body.getAsJsonObject("region").get("irSha").getAsString())) {
			return refused(Reason.ARTIFACT_STALE, "artifact " + sha.substring(0, 12) + ": its plan's IR is not the artifact's");
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
		JsonObject ext = r.ext().deepCopy();
		ext.addProperty(EXT_ARTIFACT, sha);
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
		return RegionSurvey.sample(level, x0, z0, x1, z1, res, LoadPolicy.LOADED_ONLY).thenCompose(now -> RegionsImpl.onServer(s, () -> {
			String drift = terrainDiff(plan, now, body.getAsJsonObject("region").getAsJsonObject("tiles"), x0, z0, x1, z1);
			if (drift != null) {
				throw RegionsImpl.refusal(Reason.ARTIFACT_STALE, "the land under the plan's tiles changed since the check: " + drift);
			}
			return RegionsImpl.INSTANCE.realise(rr);
		})).thenCompose(f -> f);
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
			long cells = cells(id);
			if (cells > top) {
				return "lot " + e.getKey() + ": entry " + e.getValue() + " is " + cells + " cells, past the top of its approved cost range (" + top + "): approve again";
			}
		}
		return null;
	}

	/** The non-air blocks of an entry's template (0 when it can't be read). */
	static long cells(String id) {
		var t = Blueprints.template(id);
		if (t == null) {
			return 0;
		}
		var pals = ((dev.larattalabs.architect.mixin.StructureTemplateAccessor) t).architect$palettes();
		return pals.isEmpty() ? 0 : pals.get(0).blocks().stream().filter(b -> !b.state().isAir()).count();
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
