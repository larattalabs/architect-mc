package dev.larattalabs.architect.region;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.AuthorRequest;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Reason;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.level.storage.LevelResource;
import org.jspecify.annotations.Nullable;

/**
 * (7c AU) Program authoring's mod half (docs/CONTRACT.md "Phase 7c" §3 row 13, "Slice AU as built"): {@code Regions.authorProgram}
 * surveys the claim in the Overworld and sends {@code region.author}; the helper's design (kind {@code program}, its id the authored
 * program's id) runs the checker-driven rounds. Here:
 * <ul>
 * <li><b>the world-local store</b>, {@code <world>/architect/authored/}: {@code <id>.mjs} the source's exact bytes and {@code <id>.json}
 * {@code {id, sha, owner, brief, claim, planId?, partId?, installedAt}}; installed when the design ends AUTHORED (before DESIGN_DONE fires),
 * once, after its sha is checked against the bytes; owned by the request's owner ({@link AuthorRequest#EXT_OWNER}, null: the player);</li>
 * <li><b>checkPlan</b>: the sources of the authored programs a plan names, the plan's owner's only, sent with {@code region.plan} (the kit
 * hashes them: a sha other than the plan's refuses AUTHORED_STALE, none installed NO_PROGRAM);</li>
 * <li><b>realiseApproved</b>: every program the artifact freezes ({@code authored [{part, id, sha}]}) re-hashed from the file now; a moved
 * or missing one refuses {@link Reason#AUTHORED_STALE} (detail: its id) before anything is written.</li>
 * </ul>
 * The record never vouches for the bytes: every check and realise hashes the file as it is.
 */
public final class Authors {
	/** The helper's feature (mapped to the API's {@code programAuthoring}). */
	public static final String FEATURE = "region.author";
	static final Pattern ID = Pattern.compile("[a-z][a-z0-9_]{0,47}");
	static final int SOURCE_MAX = 262144;
	static final int PER_PLAN = 4;

	private Authors() {
	}

	/** A string member, or null when absent or not a string. */
	static @Nullable String opt(JsonObject o, String k) {
		return o.get(k) instanceof JsonElement e && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString() : null;
	}

	/** The store: {@code <world>/architect/authored}. */
	public static Path dir(Path world) {
		return world.resolve("architect").resolve("authored");
	}

	static @Nullable Path world() {
		MinecraftServer s = RegionsImpl.server();
		return s == null ? null : s.getWorldPath(LevelResource.ROOT);
	}

	/** The request's owner ({@link AuthorRequest#EXT_OWNER}), or null (the player). */
	static @Nullable String ownerOf(AuthorRequest r) {
		return r.ext().get(AuthorRequest.EXT_OWNER) instanceof JsonElement e && e.isJsonPrimitive() && e.getAsJsonPrimitive().isString() ? e.getAsString()
			: null;
	}

	static CompletableFuture<String> start(AuthorRequest r) {
		MinecraftServer s = RegionsImpl.server();
		TileStream.Link link = TileStream.link;
		if (s == null) {
			return CompletableFuture.failedFuture(new IllegalStateException("no world is open"));
		}
		if (link == null || !link.connected()) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.SIDECAR_UNAVAILABLE, "the helper (sidecar) is not connected"));
		}
		if (!ArchitectApi.get().features().contains("programAuthoring")) {
			return CompletableFuture.failedFuture(new RegionsImpl.RegionException(Reason.SIDECAR_UNAVAILABLE, "the helper has no program authoring (feature region.author)"));
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
				cols -> BlobPut.put(link, cols.encode(), "survey").thenCompose(blobId -> link.send(message(r, key, level.getMinY(), level.getMaxY(), blobId, sum)))))
				.thenCompose(ack -> {
					if (ack.has("ok") && !ack.get("ok").getAsBoolean()) {
						String err = opt(ack, "error");
						return CompletableFuture.failedFuture(err != null && err.startsWith("op_key_conflict") ? new RegionsImpl.RegionException(Reason.OP_KEY_CONFLICT,
							err) : new IllegalStateException("the helper refused the authoring request: " + err));
					}
					JsonObject res2 = ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : ack;
					String id = res2.get("designId").getAsString();
					dev.larattalabs.architect.apiimpl.ApiImpl.rememberDesign(id, ownerOf(r), r.ext().deepCopy());
					Architect.LOGGER.info("Program design {} requested (authorProgram): {}", id, r.brief());
					// an adopted design (the same key and body) may have ended AUTHORED in another world (the helper's data spans the
					// worlds): installed into this one now, as its end would have; idempotent
					return RegionsImpl.onServer(s, () -> {
						ArchitectApi.get().designs().get(id).ifPresent(d -> changed(s, d));
						return id;
					});
				});
		});
	}

	/** The {@code region.author} message. Pure. */
	static JsonObject message(AuthorRequest r, @Nullable String opKey, int minY, int maxY, String surveyBlobId, String surveySummary) {
		JsonObject m = new JsonObject();
		m.addProperty("type", "region.author");
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
		if (!surveySummary.isEmpty()) {
			m.addProperty("surveySummary", surveySummary.length() > 8000 ? surveySummary.substring(0, 8000) : surveySummary);
		}
		if (r.ext().get(AuthorRequest.EXT_STYLE) instanceof JsonElement st && st.isJsonPrimitive()) {
			m.addProperty("style", st.getAsString());
		}
		if (r.planId() != null) {
			m.addProperty("planId", r.planId());
		}
		if (r.partId() != null) {
			m.addProperty("partId", r.partId());
		}
		if (r.budgetUsd() != null) {
			m.addProperty("budgetUsd", r.budgetUsd());
		}
		if (opKey != null) {
			m.addProperty("opKey", opKey);
		}
		String owner = ownerOf(r);
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		if (r.ext().size() > 0) {
			m.add("ext", r.ext().deepCopy());
		}
		return m;
	}

	// ------------------------------------------------------------------ the store

	/** sha256 (hex) of bytes. */
	static String sha(byte[] b) {
		return Packed.sha256(b);
	}

	/** A source that round-trips through UTF-8 (no lone surrogate), so its sha is the same every time it is read. */
	static boolean wellFormed(String s) {
		for (int i = 0; i < s.length(); i++) {
			char ch = s.charAt(i);
			if (Character.isHighSurrogate(ch)) {
				if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) {
					return false;
				}
				i++;
			} else if (Character.isLowSurrogate(ch)) {
				return false;
			}
		}
		return true;
	}

	/** A program design changed (server thread): an AUTHORED one is installed once, before DESIGN_DONE fires. */
	public static void changed(MinecraftServer server, Design d) {
		if (d.status() != Design.Status.DONE || d.result().isEmpty() || !"AUTHORED".equals(opt(d.result().get(), "outcome"))) {
			return;
		}
		Path world = server.getWorldPath(LevelResource.ROOT);
		try {
			String err = install(world, d.id(), d.result().get(), d.owner().orElse(null), d.request());
			if (err != null) {
				Architect.LOGGER.warn("Program design {}: not installed: {}", d.id(), err);
			}
		} catch (IOException e) {
			Architect.LOGGER.warn("Program design {}: install failed: {}", d.id(), e.toString());
		}
	}

	/**
	 * Installs an AUTHORED result ({@code source}, {@code sha}) as {@code id} for {@code owner}: refused (a message, nothing written) when the
	 * id is not a program id, the source is too long, not well formed or does not hash to the sha. Idempotent: an id already installed is
	 * left as it is (its first install wins; the store never overwrites). Synchronized: one install at a time.
	 */
	static synchronized @Nullable String install(Path world, String id, JsonObject result, @Nullable String owner, @Nullable JsonObject request)
		throws IOException {
		if (!ID.matcher(id).matches()) {
			return "the design id " + id + " is not a program id";
		}
		String source = opt(result, "source");
		String sha = opt(result, "sha");
		if (source == null || sha == null) {
			return "the result has no source or sha";
		}
		if (!wellFormed(source)) {
			return "the source has a lone UTF-16 surrogate";
		}
		byte[] bytes = source.getBytes(StandardCharsets.UTF_8);
		if (bytes.length > SOURCE_MAX) {
			return "the source is " + bytes.length + " bytes (at most " + SOURCE_MAX + ")";
		}
		if (!sha(bytes).equals(sha)) {
			return "the source hashes to " + sha(bytes).substring(0, 12) + ", not the result's " + sha.substring(0, Math.min(12, sha.length()));
		}
		Path dir = dir(world);
		Files.createDirectories(dir);
		Path rec = dir.resolve(id + ".json");
		if (Files.exists(rec)) {
			return null;
		}
		Path src = dir.resolve(id + ".mjs");
		Path tmp = dir.resolve(id + ".mjs.tmp");
		Files.write(tmp, bytes);
		Files.move(tmp, src, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		JsonObject o = new JsonObject();
		o.addProperty("id", id);
		o.addProperty("sha", sha);
		if (owner != null) {
			o.addProperty("owner", owner);
		}
		for (String k : new String[] {"planId", "partId"}) {
			if (opt(result, k) != null) {
				o.addProperty(k, opt(result, k));
			}
		}
		if (request != null && opt(request, "notes") != null) {
			o.addProperty("brief", opt(request, "notes"));
		}
		o.addProperty("installedAt", System.currentTimeMillis());
		Path rtmp = dir.resolve(id + ".json.tmp");
		Files.writeString(rtmp, o.toString());
		Files.move(rtmp, rec, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		Architect.LOGGER.info("Authored program {} installed ({} bytes, sha {}){}", id, bytes.length, sha.substring(0, 12), owner == null ? "" : " for " + owner);
		return null;
	}

	/** An installed program's record (its {@code <id>.json}), or null. */
	static @Nullable JsonObject record(Path world, String id) {
		if (!ID.matcher(id).matches()) {
			return null;
		}
		try {
			return RegionStore.readJson(dir(world).resolve(id + ".json"));
		} catch (IOException | RuntimeException e) {
			return null;
		}
	}

	/** The installed source's bytes now, or null when it is not installed. */
	static byte @Nullable [] bytes(Path world, String id) {
		if (!ID.matcher(id).matches()) {
			return null;
		}
		try {
			Path f = dir(world).resolve(id + ".mjs");
			return Files.isRegularFile(f) ? Files.readAllBytes(f) : null;
		} catch (IOException e) {
			return null;
		}
	}

	/** The authored program ids a plan's zones name ({@code program {template: authored, params: {id}}}), in order, at most PER_PLAN + 1. */
	static java.util.List<String> named(JsonObject plan) {
		java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
		if (plan.get("zones") instanceof JsonArray zs) {
			for (JsonElement z : zs) {
				if (z instanceof JsonObject zo && zo.get("program") instanceof JsonObject p && "authored".equals(opt(p, "template")) && p.get(
					"params") instanceof JsonObject pa && opt(pa, "id") instanceof String id && ID.matcher(id).matches()) {
					out.add(id);
					if (out.size() > PER_PLAN) {
						break;
					}
				}
			}
		}
		return java.util.List.copyOf(out);
	}

	/**
	 * The sources a plan check sends ({@code region.plan}'s {@code authored}: {@code {id: {source}}}): each named program installed for
	 * {@code owner}, as its file's bytes are now. Another owner's program, or one not installed, is left out (the kit answers NO_PROGRAM).
	 */
	static JsonObject sourcesFor(Path world, JsonObject plan, @Nullable String owner) {
		JsonObject out = new JsonObject();
		for (String id : named(plan)) {
			JsonObject rec = record(world, id);
			byte[] b = bytes(world, id);
			if (rec == null || b == null || !Objects.equals(opt(rec, "owner"), owner) || out.size() >= PER_PLAN) {
				continue;
			}
			JsonObject s = new JsonObject();
			s.addProperty("source", new String(b, StandardCharsets.UTF_8));
			out.add(id, s);
		}
		return out;
	}

	/**
	 * The first program an approved artifact freezes ({@code authored [{part, id, sha}]}) whose installed file does not hash to the frozen sha
	 * now (moved, or gone): {@code [id, why]}, or null when every one holds (or the artifact names none).
	 */
	static String @Nullable [] stale(Path world, JsonObject artifactBody) {
		if (!(artifactBody.get("authored") instanceof JsonArray as)) {
			return null;
		}
		for (JsonElement e : as) {
			if (!(e instanceof JsonObject a)) {
				continue;
			}
			String id = opt(a, "id");
			String frozen = opt(a, "sha");
			byte[] b = id == null ? null : bytes(world, id);
			if (b == null) {
				return new String[] {String.valueOf(id), "authored program " + id + " is not installed"};
			}
			String now = sha(b);
			if (!now.equals(frozen)) {
				return new String[] {id, "authored program " + id + " is " + now.substring(0, 12) + " now, not the approved " + String.valueOf(frozen).substring(0, Math.min(12,
					String.valueOf(frozen).length()))};
			}
		}
		return null;
	}
}
