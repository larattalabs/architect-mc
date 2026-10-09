package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RegionDesignRequest;
import dev.larattalabs.architect.api.RegionPlanRequest;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * Region designs (docs/CONTRACT.md phase 6b §7, template-first): {@code Regions.design} surveys the claim, sends
 * {@code region.design {brief, card?, claim, surveyBlobId, surveySummary, bible?, mustPass, model?, budgetUsd?, requireFit,
 * plan: false}} and answers the design id; the design ({@code Design.Kind.REGION}) then follows {@code design.upsert}. When the
 * pick fits ({@code result.outcome == "PICKED"}, {@code fits}), the mod plans the picked program over the claim itself
 * ({@code Regions.plan}, no further model call) and names its {@code planId} in the design's result (DESIGN_UPDATED fires
 * again). The mod plans rather than the helper ({@code plan: false}) so the plan arrives through the ordinary
 * {@code Regions.plan} path (the mod's plan record, its PLAN_STALE gate, the claim's chunk estimate). Without a fit the
 * result offers the closest program ({@code fits: false}, S-6b-3) and nothing is planned.
 */
public final class RegionDesigns {
	private static final Map<String, String> PLAN_OF = new ConcurrentHashMap<>();
	private static final Map<String, String> PLAN_ERROR = new ConcurrentHashMap<>();
	private static final Map<String, RegionDesignRequest> PENDING = new ConcurrentHashMap<>();
	private static final Set<String> PLANNING = ConcurrentHashMap.newKeySet();

	private RegionDesigns() {
	}

	/** The plan the mod ran for design {@code designId}'s pick, or null. */
	public static @Nullable String planIdOf(String designId) {
		return PLAN_OF.get(designId);
	}

	/** Why the plan of a fitting pick failed, or null. */
	public static @Nullable String planErrorOf(String designId) {
		return PLAN_ERROR.get(designId);
	}

	static CompletableFuture<String> start(RegionDesignRequest r) {
		MinecraftServer s = r.level().getServer();
		TileStream.Link link = TileStream.link;
		if (link == null || !link.connected()) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected"));
		}
		if (r.brief() == null || r.brief().isBlank()) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("the brief is empty"));
		}
		BoundingBox c = r.claim();
		int res = (long) c.getXSpan() * c.getZSpan() <= 256L * 256 ? 1 : 4;
		CompletableFuture<String> summary = ArchitectApi.get().survey().sample(r.level(), c, res, LoadPolicy.LOADED_ONLY).thenApply(
			dev.larattalabs.architect.api.Sample::summary).exceptionally(e -> "");
		return summary.thenCompose(sum -> RegionSurvey.sample(r.level(), c.minX(), c.minZ(), c.maxX(), c.maxZ(), res, LoadPolicy.LOADED_ONLY).thenCompose(
			cols -> BlobPut.put(link, cols.encode(), "survey")).thenCompose(blobId -> link.send(message(r, blobId, sum)))).thenCompose(ack -> {
				if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
					return CompletableFuture.failedFuture(new IllegalStateException("the helper refused the design: " + RegionsImpl.str(ack, "error")));
				}
				JsonObject res2 = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
				String id = res2.get("designId").getAsString();
				PENDING.put(id, r);
				JsonObject ext = r.ext().deepCopy();
				dev.larattalabs.architect.apiimpl.ApiImpl.rememberDesign(id, r.owner(), ext);
				Architect.LOGGER.info("Region design {} requested: {}", id, r.brief());
				return RegionsImpl.onServer(s, () -> id);
			});
	}

	/** The {@code region.design} message. Pure. */
	static JsonObject message(RegionDesignRequest r, String surveyBlobId, String surveySummary) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.design");
		m.addProperty("brief", r.brief());
		if (r.card() != null) {
			JsonObject card = new JsonObject();
			if (r.card().site() != null) {
				card.addProperty("site", r.card().site());
			}
			if (r.card().purpose() != null) {
				card.addProperty("purpose", r.card().purpose());
			}
			if (r.card().style() != null) {
				card.addProperty("style", r.card().style());
			}
			card.addProperty("text", r.card().text() != null ? r.card().text() : r.brief());
			m.add("card", card);
		}
		BoundingBox c = r.claim();
		JsonObject cl = new JsonObject();
		cl.addProperty("minX", c.minX());
		cl.addProperty("minZ", c.minZ());
		cl.addProperty("maxX", c.maxX());
		cl.addProperty("maxZ", c.maxZ());
		cl.addProperty("minY", r.level().getMinY());
		cl.addProperty("maxY", r.level().getMaxY());
		m.add("claim", cl);
		m.addProperty("surveyBlobId", surveyBlobId);
		if (!surveySummary.isEmpty()) {
			m.addProperty("surveySummary", surveySummary);
		}
		if (r.bible() != null) {
			m.addProperty("bible", r.bible());
		}
		JsonArray must = new JsonArray();
		r.mustPass().forEach(must::add);
		m.add("mustPass", must);
		if (r.model() != null) {
			m.addProperty("model", r.model());
		}
		if (r.budgetUsd() != null) {
			m.addProperty("budgetUsd", r.budgetUsd());
		}
		m.addProperty("requireFit", r.requireFit());
		m.addProperty("plan", false); // the mod plans a fit itself (Regions.plan): see the class comment
		if (r.owner() != null) {
			m.addProperty("owner", r.owner());
		}
		return m;
	}

	/** A region design changed (server thread): a finished fitting pick is planned once. */
	public static void changed(MinecraftServer server, Design d) {
		if (d.status() != Design.Status.DONE || d.result().isEmpty() || PLAN_OF.containsKey(d.id()) || !PLANNING.add(d.id())) {
			return;
		}
		JsonObject res = d.result().get();
		RegionDesignRequest r = PENDING.get(d.id());
		boolean fits = "PICKED".equals(RegionsImpl.str(res, "outcome")) && (!res.has("fits") || res.get("fits").getAsBoolean());
		if (r == null || !fits || !res.has("program") || res.has("planId")) {
			if (r == null && fits && !res.has("planId")) {
				Architect.LOGGER.info("Region design {}: picked {} but the request is not from this session (not planned)", d.id(), RegionsImpl.str(res,
					"program"));
			}
			return;
		}
		JsonObject params = res.has("params") && res.get("params").isJsonObject() ? res.getAsJsonObject("params") : new JsonObject();
		RegionPlanRequest pr = new RegionPlanRequest(res.get("program").getAsString(), params, r.level(), r.claim(), null, r.bible(), null,
			LoadPolicy.LOADED_ONLY, r.owner(), r.ext());
		Architect.LOGGER.info("Region design {}: planning the pick {} {}", d.id(), pr.program(), params);
		RegionsImpl.INSTANCE.plan(pr).whenComplete((p, e) -> server.execute(() -> {
			if (e != null) {
				Throwable c = e.getCause() != null ? e.getCause() : e;
				PLAN_ERROR.put(d.id(), c instanceof RegionsImpl.RegionException re ? re.reason + ": " + c.getMessage() : String.valueOf(c.getMessage()));
				Architect.LOGGER.warn("Region design {}: the pick's plan failed: {}", d.id(), PLAN_ERROR.get(d.id()));
			} else {
				PLAN_OF.put(d.id(), p.planId());
			}
			ArchitectApi.get().designs().get(d.id()).ifPresent(dev.larattalabs.architect.apiimpl.ApiEvents::designUpdated);
		}));
	}

	/** World closed. */
	public static void reset() {
		PENDING.clear();
		PLANNING.clear();
	}
}
