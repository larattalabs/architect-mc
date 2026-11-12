package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.SiteSpec;
import dev.larattalabs.architect.placement.Blueprints;
import dev.larattalabs.architect.region.volume.VolumeSurvey;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (7b DS) Site-aware design on the mod side (docs/CONTRACT.md "Phase 7b", slice DS): {@code DesignRequest.site} and
 * {@link dev.larattalabs.architect.api.Designs#siteVariant}.
 * <ul>
 * <li>Before a design, a group or a site variant goes out, every {@code site} in the message gets a helper blob of its frozen volume: this
 * world's {@code architect/volumes/<sha>.bin} (where {@code Survey.volume}/{@code Survey.site} freeze it) is uploaded and its blob id
 * replaces the spec's {@code volumeBlobId}. A volume not in this world keeps the spec's id, which must then be a helper blob (a
 * {@code local:} id refuses: nothing to send). The helper keeps the volume by its sha, so a re-sent request (an opKey) is the same.</li>
 * <li>{@code siteVariant}: {@code site.variant {entryId, site, opKey, owner?}}; the helper acks with its operation and reports it done
 * through {@code follow.upsert} (WireFS's operation channel); the library reloads, then the future completes with the new entry id, or
 * fails {@link ArchitectRefused} with the helper's code ({@code SITE_UNFIT} with the failing site rule id, {@code SITE_UNSUPPORTED} with
 * {@code no_program} or {@code not_site_aware}) and detail.</li>
 * </ul>
 * Internal.
 */
public final class SiteDesigns {
	/** The helper's feature, and the API's name for it. */
	public static final String FEATURE = "site.design";
	public static final String API_FEATURE = "siteDesign";

	private SiteDesigns() {
	}

	/** Every site object in a message: {@code request.site}, {@code group.items[].site}, a {@code site.variant}'s {@code site}. Pure. */
	static List<JsonObject> sitesIn(JsonObject message) {
		List<JsonObject> out = new ArrayList<>();
		if (message.get("site") instanceof JsonObject s) {
			out.add(s);
		}
		if (message.get("request") instanceof JsonObject r && r.get("site") instanceof JsonObject s) {
			out.add(s);
		}
		if (message.get("group") instanceof JsonObject g && g.get("items") instanceof JsonArray items) {
			for (JsonElement e : items) {
				if (e instanceof JsonObject it && it.get("site") instanceof JsonObject s) {
					out.add(s);
				}
			}
		}
		return out;
	}

	/** Does the message carry a site? Pure. */
	static boolean hasSite(JsonObject message) {
		return !sitesIn(message).isEmpty();
	}

	/**
	 * Give every site in {@code message} a helper blob of its volume (in place), then complete with the message. Reads the frozen files on
	 * the server thread; uploads through the helper link.
	 */
	static CompletableFuture<JsonObject> resolve(JsonObject message) {
		List<JsonObject> sites = sitesIn(message);
		if (sites.isEmpty()) {
			return CompletableFuture.completedFuture(message);
		}
		CompletableFuture<JsonObject> chain = CompletableFuture.completedFuture(message);
		for (JsonObject s : sites) {
			chain = chain.thenCompose(m -> blobOf(s).thenApply(id -> {
				s.addProperty("volumeBlobId", id);
				return m;
			}));
		}
		return chain;
	}

	/** The blob id a site's volume goes by: the world's frozen file uploaded, else the spec's own (refused when it is local). */
	private static CompletableFuture<String> blobOf(JsonObject site) {
		String sha = Wire4b.str(site, "volumeSha");
		String given = Wire4b.str(site, "volumeBlobId", "");
		byte[] gz = sha == null ? null : frozenBytes(sha);
		if (gz != null) {
			return RegionBridge.put(gz, "region.volume");
		}
		if (given.startsWith("local:") || given.isEmpty()) {
			return CompletableFuture.failedFuture(new IllegalArgumentException("the site's frozen volume " + (sha == null ? "?" : sha.substring(0, Math.min(12,
				sha.length()))) + " is not in this world (architect/volumes/<sha>.bin) and its blob id is local: freeze it with Survey.site or Survey.volume"
				+ " first"));
		}
		return CompletableFuture.completedFuture(given);
	}

	/** This world's frozen volume file (gzip ARVX) by sha, or null. */
	static byte @Nullable [] frozenBytes(String sha) {
		MinecraftServer s = ApiImpl.server();
		if (s == null || !sha.matches("[0-9a-f]{64}")) {
			return null;
		}
		Path f = s.getWorldPath(LevelResource.ROOT).resolve(VolumeSurvey.STANDALONE_DIR).resolve(sha + ".bin");
		try {
			return Files.isRegularFile(f) ? Files.readAllBytes(f) : null;
		} catch (IOException e) {
			Architect.LOGGER.warn("API: the frozen volume {} can't be read: {}", f, e.toString());
			return null;
		}
	}

	/** The {@code site.variant} message. Throws {@link IllegalArgumentException} for a bad argument. Pure. */
	static JsonObject message(String entryId, SiteSpec site, String opKey, @Nullable String owner) {
		if (entryId == null || !entryId.matches("[a-z0-9_]{1,64}")) {
			throw new IllegalArgumentException("siteVariant needs a library entry id (got " + entryId + ")");
		}
		if (site == null) {
			throw new IllegalArgumentException("siteVariant needs a site");
		}
		List<String> problems = site.problems();
		if (!problems.isEmpty()) {
			throw new IllegalArgumentException("the site is invalid: " + String.join("; ", problems));
		}
		if (opKey == null) {
			throw new IllegalArgumentException("siteVariant needs an opKey");
		}
		Wire0a.opKey(opKey);
		JsonObject m = DesignsImpl.msg("site.variant");
		m.addProperty("entryId", entryId);
		m.add("site", site.wire());
		m.addProperty("opKey", opKey);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		return m;
	}

	/** A finished operation as the API answers it: the new entry id, or the typed refusal. Pure. */
	static String outcome(JsonObject op) {
		String id = Wire4b.str(op, "newEntryId");
		if (id != null) {
			return id;
		}
		if (op.get("refused") instanceof JsonObject r) {
			String code = Wire4b.str(r, "code", "OTHER");
			Reason reason;
			try {
				reason = Reason.valueOf(code);
			} catch (IllegalArgumentException e) {
				reason = Reason.OTHER;
			}
			throw new ArchitectRefused(reason, Wire4b.str(r, "message", code), Wire4b.str(r, "detail", ""));
		}
		throw new IllegalStateException("the helper's site variant " + Wire4b.str(op, "id", "?") + " ended without an entry or a refusal");
	}

	/** {@code Designs.siteVariant}. */
	static CompletableFuture<String> siteVariant(String entryId, SiteSpec site, String opKey, @Nullable String owner) {
		JsonObject m;
		try {
			m = message(entryId, site, opKey, owner);
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		String why = DesignsImpl.unavailable4b(ApiImpl.bridge(), FEATURE, "site variants");
		if (why != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(why)));
		}
		CompletableFuture<JsonObject> resolved = new CompletableFuture<>();
		ApiImpl.runOnServer(() -> resolve(m).whenComplete((x, e) -> {
			if (e != null) {
				resolved.completeExceptionally(e);
			} else {
				resolved.complete(x);
			}
		}));
		return ApiImpl.onServerFuture(resolved.thenCompose(msg -> DesignsImpl.ask(FEATURE, "site variants", msg)).thenCompose(ack -> {
			CompletableFuture<JsonObject> done = "done".equals(Wire4b.str(ack, "status")) ? CompletableFuture.completedFuture(ack) : WireFS.awaitOp(
				Wire4b.str(ack, "id", ""), "site variant");
			return done.thenCompose(SiteDesigns::reloaded);
		}).thenApply(op -> {
			String id = outcome(op);
			Architect.LOGGER.info("API: site variant of {} on site {}: {}", entryId, site.volumeSha().substring(0, 12), id);
			return id;
		}));
	}

	/** The library reloads (the new entry), on the server thread, before the future completes. */
	private static CompletableFuture<JsonObject> reloaded(JsonObject op) {
		MinecraftServer s = ApiImpl.server();
		if (s == null || Wire4b.str(op, "newEntryId") == null) {
			return CompletableFuture.completedFuture(op);
		}
		CompletableFuture<JsonObject> out = new CompletableFuture<>();
		s.execute(() -> {
			try {
				Blueprints.reload(s);
			} catch (RuntimeException e) {
				Architect.LOGGER.warn("API: reload after a site variant failed", e);
			}
			out.complete(op);
		});
		return out;
	}
}
