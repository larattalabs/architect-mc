package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ComposeRequest;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.PlanCheck;
import dev.larattalabs.architect.api.PlanRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionPlanRequest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7c CO) The standalone composer's mod half (docs/CONTRACT.md "Phase 7c" §3 row 12, "Slice CO as built"): {@code Regions.compose}
 * surveys the claim in the Overworld (as {@code Regions.design} does: the ARSV columns, the survey summary, TC's frozen claim volume) and
 * sends {@code region.compose}; the helper's design (kind {@code settlement}) then follows {@code design.upsert}. Two things happen here as
 * it changes:
 * <ul>
 * <li>a round waits for its check ({@code settlement.awaiting {round, plan}}, status CHECKING): the mod runs {@link
 * dev.larattalabs.architect.api.Regions#checkPlan} over the plan (the Overworld, the claim, the built-in {@code claim_*} anchors and the
 * caller's own from {@code ComposeRequest.EXT_HINTS}'s {@code anchors}, owner null (the player), the design's Style as the bible) and answers {@code region.compose.checked {designId,
 * round, check}} (or {@code refused} with the reason), once per round per session; after a restart the next snapshot asks again;</li>
 * <li>a PICKED design (a template fits) has its program planned over the claim ({@code Regions.plan}, as 6b's {@link RegionDesigns}), and
 * its {@code planId} joins the result.</li>
 * </ul>
 */
public final class Composes {
	/** The helper's feature (mapped to the API's {@code compose}). */
	public static final String FEATURE = "region.compose";
	private static final Map<String, String> PLAN_OF = new ConcurrentHashMap<>();
	private static final Map<String, String> PLAN_ERROR = new ConcurrentHashMap<>();
	private static final Set<String> PLANNING = ConcurrentHashMap.newKeySet();
	/** designId#round: checks started this session. */
	private static final Set<String> CHECKING = ConcurrentHashMap.newKeySet();

	private Composes() {
	}

	/** The plan the mod ran for a PICKED settlement design, or null. */
	public static @Nullable String planIdOf(String designId) {
		return PLAN_OF.get(designId);
	}

	/** Why a PICKED settlement design's plan failed, or null. */
	public static @Nullable String planErrorOf(String designId) {
		return PLAN_ERROR.get(designId);
	}

	static CompletableFuture<String> start(ComposeRequest r) {
		MinecraftServer s = RegionsImpl.server();
		TileStream.Link link = TileStream.link;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world is open"));
		}
		if (link == null || !link.connected()) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected"));
		}
		if (!ArchitectApi.get().features().contains("compose")) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.SIDECAR_UNAVAILABLE, "the helper has no composer (feature region.compose)"));
		}
		if (r.brief().isBlank()) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("the brief is empty"));
		}
		String key;
		try {
			key = dev.larattalabs.architect.apiimpl.Wire0a.opKey(r.opKey());
		} catch (IllegalArgumentException e) {
			return CompletableFuture.failedFuture(e);
		}
		BoundingBox c = r.claim();
		if (c.getXSpan() > 1024 || c.getZSpan() > 1024) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.REGION_LIMIT, "the claim is " + c.getXSpan() + "x" + c.getZSpan()
				+ " columns (at most 1024x1024)"));
		}
		return RegionsImpl.onServer(s, s::overworld).thenCompose(level -> {
			int res = (long) c.getXSpan() * c.getZSpan() <= 256L * 256 ? 1 : 4;
			CompletableFuture<String> summary = ArchitectApi.get().survey().sample(level, c, res, LoadPolicy.LOADED_ONLY).thenApply(
				dev.larattalabs.architect.api.Sample::summary).exceptionally(e -> "");
			return summary.thenCompose(sum -> RegionSurvey.sample(level, c.minX(), c.minZ(), c.maxX(), c.maxZ(), res, LoadPolicy.LOADED_ONLY).thenCompose(
				cols -> BlobPut.put(link, cols.encode(), "survey").thenCompose(blobId -> RegionDesigns.claimVolume(level, c, cols).thenCompose(vol -> link.send(
					withBuilds(message(r, key, level.getMinY(), level.getMaxY(), blobId, sum, vol), level, c)))))).thenCompose(ack -> {
						if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
							String err = opt(ack, "error");
							return CompletableFuture.failedFuture(err != null && err.startsWith("op_key_conflict") ? new RegionsImpl.RegionException(Reason.OP_KEY_CONFLICT,
								err) : new IllegalStateException("the helper refused the compose request: " + err));
						}
						JsonObject res2 = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
						String id = res2.get("designId").getAsString();
						dev.larattalabs.architect.apiimpl.ApiImpl.rememberDesign(id, null, r.ext().deepCopy());
						Architect.LOGGER.info("Settlement design {} requested (compose): {}", id, r.brief());
						return RegionsImpl.onServer(s, () -> id);
					});
		});
	}

	/** The {@code region.compose} message. Pure. */
	static JsonObject message(ComposeRequest r, @Nullable String opKey, int minY, int maxY, String surveyBlobId, String surveySummary,
		dev.larattalabs.architect.api.@Nullable Volume volume) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.compose");
		m.addProperty("brief", r.brief());
		BoundingBox c = r.claim();
		JsonObject cl = new JsonObject();
		cl.addProperty("minX", c.minX());
		cl.addProperty("minZ", c.minZ());
		cl.addProperty("maxX", c.maxX());
		cl.addProperty("maxZ", c.maxZ());
		cl.addProperty("minY", minY);
		cl.addProperty("maxY", maxY);
		m.add("claim", cl);
		m.addProperty("surveyBlobId", surveyBlobId);
		if (volume != null) {
			JsonObject v = new JsonObject();
			v.addProperty("blobId", volume.blobId());
			v.addProperty("sha", volume.sha());
			m.add("volume", v);
		}
		if (r.styleId() != null) {
			m.addProperty("style", r.styleId());
		}
		m.addProperty("images", r.images());
		if (r.budgetUsd() != null) {
			m.addProperty("budgetUsd", r.budgetUsd());
		}
		if (opKey != null) {
			m.addProperty("opKey", opKey);
		}
		if (r.ext().size() > 0) {
			m.add("ext", r.ext().deepCopy());
		}
		return m;
	}

	/**
	 * The message with the players' builds meeting the claim (6c PT: {@code BuildViews.planJson}, what {@link
	 * dev.larattalabs.architect.api.Regions#checkPlan} keeps every part clear of), at most 64, so the composer can build round them; nothing
	 * when there are none.
	 */
	static JsonObject withBuilds(JsonObject m, ServerLevel level, BoundingBox c) {
		JsonArray b = dev.larattalabs.architect.placed.BuildViews.planJson(dev.larattalabs.architect.site.Sites.dimensionId(level), new int[] {c.minX(), level
			.getMinY(), c.minZ(), c.maxX(), level.getMaxY(), c.maxZ()});
		if (!b.isEmpty()) {
			JsonArray keep = new JsonArray();
			for (int i = 0; i < Math.min(64, b.size()); i++) {
				keep.add(b.get(i));
			}
			m.add("builds", keep);
		}
		return m;
	}

	/** A settlement design changed (server thread): a round's plan is checked; a PICKED design is planned once. */
	public static void changed(MinecraftServer server, Design d, JsonObject raw) {
		JsonObject st = raw.get("settlement") instanceof JsonObject o ? o : null;
		if (st == null) {
			return;
		}
		if (d.status() == Design.Status.CHECKING && st.get("awaiting") instanceof JsonObject aw && aw.get("plan") instanceof JsonObject plan && aw.get(
			"round") instanceof JsonElement re && re.isJsonPrimitive()) {
			check(server, d.id(), re.getAsInt(), plan, st);
			return;
		}
		if (d.status() == Design.Status.DONE && d.result().isPresent() && "PICKED".equals(RegionsImpl.str(d.result().get(), "outcome"))) {
			plan(server, d, st);
		}
	}

	/** The claim a settlement record names, over the level's height; null when malformed. */
	static @Nullable BoundingBox claimOf(JsonObject st, ServerLevel level) {
		if (!(st.get("claim") instanceof JsonObject c)) {
			return null;
		}
		try {
			return new BoundingBox(c.get("minX").getAsInt(), level.getMinY(), c.get("minZ").getAsInt(), c.get("maxX").getAsInt(), level.getMaxY(), c.get(
				"maxZ").getAsInt());
		} catch (RuntimeException e) {
			return null;
		}
	}

	/** The PlanRequest a round's plan is checked with (the Overworld, the claim, the record's anchors and Style). Pure. */
	static PlanRequest checkRequest(JsonObject plan, ServerLevel level, BoundingBox claim, JsonObject st) {
		String bible = null;
		Integer version = null;
		if (st.get("style") instanceof JsonObject sty) {
			bible = opt(sty, "id");
			version = sty.get("version") instanceof JsonElement v && v.isJsonPrimitive() ? v.getAsInt() : null;
		}
		// the caller's anchors (ComposeRequest.EXT_HINTS's {anchors: {name: [x, y, z]}}, the helper validated them into the record)
		Map<String, net.minecraft.core.BlockPos> anchors = new java.util.TreeMap<>();
		if (st.get("anchors") instanceof JsonObject an) {
			for (Map.Entry<String, JsonElement> e : an.entrySet()) {
				if (e.getValue() instanceof JsonArray a && a.size() == 3) {
					anchors.put(e.getKey(), new net.minecraft.core.BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
				}
			}
		}
		return new PlanRequest(plan.deepCopy(), level, claim, anchors, opt(st, "owner"), bible, version, null, null, new JsonObject(), null);
	}

	/** A check as {@code region.compose.checked} carries it: the PlanCheck's members without the catalogue and the light preview. Pure. */
	static JsonObject checkWire(PlanCheck pc) {
		JsonObject o = PlanChecks.toJson(pc);
		o.remove("catalogue");
		JsonObject pv = o.get("preview") instanceof JsonObject p ? p : new JsonObject();
		o.remove("preview");
		if (pv.get("malformed") instanceof JsonObject m) {
			o.add("malformed", m.deepCopy());
		}
		return o;
	}

	private static void check(MinecraftServer server, String id, int round, JsonObject plan, JsonObject st) {
		if (!CHECKING.add(id + "#" + round)) {
			return;
		}
		ServerLevel level = server.overworld();
		BoundingBox claim = claimOf(st, level);
		CompletableFuture<PlanCheck> fut = claim == null ? CompletableFuture.failedFuture(new IllegalArgumentException("the design's claim is malformed"))
			: RegionsImpl.INSTANCE.checkPlan(checkRequest(plan, level, claim, st));
		Architect.LOGGER.info("Settlement design {}: checking round {}'s plan", id, round);
		fut.whenComplete((pc, e) -> server.execute(() -> {
			JsonObject m = new JsonObject();
			m.addProperty("type", "region.compose.checked");
			m.addProperty("designId", id);
			m.addProperty("round", round);
			if (e != null) {
				Throwable c = e instanceof java.util.concurrent.CompletionException && e.getCause() != null ? e.getCause() : e;
				m.addProperty("refused", (c instanceof dev.larattalabs.architect.api.RegionRefused rr ? rr.reason().name() + ": " : "") + c.getMessage());
			} else {
				m.add("check", checkWire(pc));
			}
			Architect.LOGGER.info("Settlement design {}: round {} checked: {}", id, round, e != null ? "refused " + RegionsImpl.str(m, "refused") : pc.overall());
			TileStream.Link link = TileStream.link;
			if (link == null || !link.connected()) {
				CHECKING.remove(id + "#" + round); // asked again once the helper is back (its snapshot)
				return;
			}
			link.send(m).whenComplete((ack, x) -> {
				if (x != null || ack == null || ack.has("ok") && !ack.get("ok").getAsBoolean()) {
					Architect.LOGGER.warn("Settlement design {}: the helper did not take round {}'s check: {}", id, round, x != null ? x.getMessage()
						: ack == null ? "no answer" : RegionsImpl.str(ack, "error"));
				}
			});
		}));
	}

	private static void plan(MinecraftServer server, Design d, JsonObject st) {
		JsonObject res = d.result().get();
		if (PLAN_OF.containsKey(d.id()) || res.has("planId") || !res.has("program") || !res.get("program").isJsonPrimitive() || !PLANNING.add(d.id())) {
			return;
		}
		ServerLevel level = server.overworld();
		BoundingBox claim = claimOf(st, level);
		if (claim == null) {
			return;
		}
		JsonObject params = res.get("params") instanceof JsonObject p ? p : new JsonObject();
		String bible = st.get("style") instanceof JsonObject sty ? opt(sty, "id") : null;
		RegionPlanRequest pr = new RegionPlanRequest(res.get("program").getAsString(), params, level, claim, null, bible, null, LoadPolicy.LOADED_ONLY,
			opt(st, "owner"), new JsonObject());
		Architect.LOGGER.info("Settlement design {}: planning the pick {} {}", d.id(), pr.program(), params);
		RegionsImpl.INSTANCE.plan(pr).whenComplete((p, e) -> server.execute(() -> {
			if (e != null) {
				Throwable c = e.getCause() != null ? e.getCause() : e;
				PLAN_ERROR.put(d.id(), c instanceof RegionsImpl.RegionException re ? re.reason + ": " + c.getMessage() : String.valueOf(c.getMessage()));
				Architect.LOGGER.warn("Settlement design {}: the pick's plan failed: {}", d.id(), PLAN_ERROR.get(d.id()));
			} else {
				PLAN_OF.put(d.id(), p.planId());
			}
			ArchitectApi.get().designs().get(d.id()).ifPresent(dev.larattalabs.architect.apiimpl.ApiEvents::designUpdated);
		}));
	}

	/** A string member, or null when absent or not a string. */
	private static @Nullable String opt(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null;
	}

	/** World closed. */
	public static void reset() {
		PLANNING.clear();
		CHECKING.clear();
	}
}
