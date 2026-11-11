package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Designs.FollowResult;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.Library.Derivation;
import dev.larattalabs.architect.api.Library.Follower;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.placement.Blueprints;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * Slice 6d FS on the mod side (docs/CONTRACT.md "Phase 6d slice FS"): {@link Library#followers} from the loaded entries, and
 * {@code entry.follow} / {@code entry.followAll} to the helper. The helper acks at once with the operation ({@code {id, status,
 * results}}); its results come as {@code follow.upsert {follow}} while it runs ({@code status: "done"} last). A future completes on the
 * server thread after the library reloaded. A future pending when the link drops fails; the same {@code opKey} gets the saved results.
 * Internal.
 */
public final class WireFS {
	/** The helper's feature, and the API's name for it. */
	public static final String FEATURE = "entry.follow";
	public static final String API_FEATURE = "followSource";
	/** a backstop: an operation that never reports done */
	static final long TIMEOUT_MIN = 60;

	private static final Map<String, CompletableFuture<JsonObject>> PENDING = new ConcurrentHashMap<>();
	/** recently finished operations, by id (an upsert that raced the ack) */
	private static final Map<String, JsonObject> DONE = java.util.Collections.synchronizedMap(new LinkedHashMap<>() {
		@Override
		protected boolean removeEldestEntry(Map.Entry<String, JsonObject> e) {
			return size() > 64;
		}
	});

	private WireFS() {
	}

	// ------------------------------------------------------------------ followers (no helper)

	/** Every entry whose head derives from {@code source}, sorted by id. */
	static List<Follower> followers(Library lib, String source) {
		int sourceHead = lib.get(source).map(Library.Entry::version).orElse(0);
		List<Follower> out = new ArrayList<>();
		for (Library.Entry e : lib.list()) {
			Optional<Derivation> d = e.derivation();
			if (d.isEmpty() || !source.equals(d.get().source())) {
				continue;
			}
			Derivation.Kind kind = d.get().kind();
			int sv = d.get().sourceVersion();
			out.add(new Follower(e.id(), kind, sv, e.version(), sourceHead, kind == Derivation.Kind.COPY && sourceHead > 0 && sv < sourceHead));
		}
		out.sort(Comparator.comparing(Follower::entryId));
		return List.copyOf(out);
	}

	// ------------------------------------------------------------------ follow, followAll

	static CompletableFuture<FollowResult> follow(Library lib, String copyEntryId, int toSourceVersion, @Nullable String opKey) {
		Optional<Library.Entry> e = lib.get(copyEntryId);
		if (e.isEmpty()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new ArchitectRefused(Reason.UNKNOWN_BLUEPRINT, "no library entry " + copyEntryId,
				"no_entry")));
		}
		// a SITE entry follows in 7b (answered here, also without a helper)
		Optional<Derivation> d = e.get().derivation();
		if (d.isPresent() && d.get().kind() == Derivation.Kind.SITE) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new ArchitectRefused(Reason.NOT_ALLOWED, copyEntryId
				+ " is a site-adapted entry: it follows its source in 7b, with its fit parameters", "until_7b")));
		}
		JsonObject m = DesignsImpl.msg("entry.follow");
		m.addProperty("entryId", copyEntryId);
		m.addProperty("toSourceVersion", Math.max(0, toSourceVersion));
		if (opKey != null) {
			m.addProperty("opKey", opKey);
		}
		return send(m).thenApply(op -> {
			List<FollowResult> rs = results(op);
			if (rs.isEmpty()) {
				throw new IllegalStateException("the helper's follow of " + copyEntryId + " ended without a result");
			}
			return rs.get(0);
		});
	}

	static CompletableFuture<List<FollowResult>> followAll(String sourceEntryId, int toSourceVersion, @Nullable String opKey) {
		JsonObject m = DesignsImpl.msg("entry.followAll");
		m.addProperty("sourceEntryId", sourceEntryId);
		m.addProperty("toSourceVersion", Math.max(0, toSourceVersion));
		if (opKey != null) {
			m.addProperty("opKey", opKey);
		}
		return send(m).thenApply(WireFS::results);
	}

	/** Sends, then completes with the finished operation after the library reloaded (server thread). */
	private static CompletableFuture<JsonObject> send(JsonObject m) {
		return DesignsImpl.ask(FEATURE, "updates that follow the source", m).thenCompose(ack -> {
			String id = Wire4b.str(ack, "id");
			if (id == null) {
				return CompletableFuture.failedFuture(new IllegalStateException("the helper's follow ack names no operation"));
			}
			CompletableFuture<JsonObject> done;
			if ("done".equals(Wire4b.str(ack, "status"))) {
				done = CompletableFuture.completedFuture(ack);
			} else {
				done = PENDING.computeIfAbsent(id, k -> new CompletableFuture<>());
				JsonObject raced = DONE.get(id);
				if (raced != null) {
					PENDING.remove(id);
					done.complete(raced);
				}
				done.orTimeout(TIMEOUT_MIN, TimeUnit.MINUTES).whenComplete((v, t) -> PENDING.remove(id, done));
			}
			return ApiImpl.onServerFuture(done.thenCompose(WireFS::reloaded));
		});
	}

	/** The library reloads (the new versions), on the server thread, before the future completes. */
	private static CompletableFuture<JsonObject> reloaded(JsonObject op) {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return CompletableFuture.completedFuture(op);
		}
		boolean any = results(op).stream().anyMatch(FollowResult::followed);
		CompletableFuture<JsonObject> out = new CompletableFuture<>();
		s.execute(() -> {
			try {
				if (any) {
					Blueprints.reload(s);
					Versioned.catchUp(s);
				}
			} catch (RuntimeException e) {
				dev.larattalabs.architect.Architect.LOGGER.warn("API: reload after a follow failed", e);
			}
			out.complete(op);
		});
		return out;
	}

	/** {@code follow.upsert {follow}} (any thread). */
	public static void changed(JsonObject follow) {
		String id = Wire4b.str(follow, "id");
		if (id == null || !"done".equals(Wire4b.str(follow, "status"))) {
			return;
		}
		DONE.put(id, follow.deepCopy());
		CompletableFuture<JsonObject> f = PENDING.remove(id);
		if (f != null) {
			f.complete(follow.deepCopy());
		}
	}

	/** The link dropped: pending follows fail (the same opKey gets the saved results). */
	static void linkLost() {
		for (String id : List.copyOf(PENDING.keySet())) {
			CompletableFuture<JsonObject> f = PENDING.remove(id);
			if (f != null) {
				f.completeExceptionally(new IllegalStateException("the helper disconnected during follow " + id
					+ "; it resumes when the helper restarts: call again with the same opKey for its results"));
			}
		}
	}

	static List<FollowResult> results(JsonObject op) {
		List<FollowResult> out = new ArrayList<>();
		JsonElement rs = op.get("results");
		if (rs instanceof JsonArray a) {
			for (JsonElement el : a) {
				if (el.isJsonObject()) {
					out.add(result(el.getAsJsonObject()));
				}
			}
		}
		return List.copyOf(out);
	}

	static FollowResult result(JsonObject r) {
		String refused = r.has("refused") && r.get("refused").isJsonPrimitive() ? r.get("refused").getAsString() : null;
		return new FollowResult(Wire4b.str(r, "entryId", "?"), bool(r, "followed"), num(r, "fromVersion"), num(r, "newVersion"), num(r,
			"sourceVersion"), refused, bool(r, "alreadyFollowed"), Wire4b.str(r, "message", ""));
	}

	private static boolean bool(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() && o.get(k).getAsBoolean();
	}

	private static int num(JsonObject o, String k) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsInt() : 0;
	}
}
