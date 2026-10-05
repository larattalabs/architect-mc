package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.library.LibraryMeta;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Library} over {@link Blueprints} (reads) and the client's Library feature (delete, tags) and sidecar link
 * (variants). Internal.
 */
final class LibraryImpl implements Library {
	/** Variant jobs a {@link #makeVariant} waits for: variant id -> future. */
	private final Map<String, CompletableFuture<Entry>> waiting = new ConcurrentHashMap<>();

	@Override
	public List<Entry> list() {
		LibraryMeta.Overlay overlay = overlay();
		List<Entry> out = new ArrayList<>();
		for (Blueprints.Entry e : Blueprints.entries()) {
			out.add(view(e, overlay));
		}
		return List.copyOf(out);
	}

	@Override
	public Optional<Entry> get(String id) {
		Blueprints.Entry e = Blueprints.entry(id);
		return e == null ? Optional.empty() : Optional.of(view(e, e.bundled() ? overlay() : null));
	}

	private static LibraryMeta.Overlay overlay() {
		return new LibraryMeta.Overlay(Blueprints.gameDataDir().resolve("library-meta.json")).load();
	}

	private static Entry view(Blueprints.Entry e, LibraryMeta.@Nullable Overlay overlay) {
		LibraryMeta meta = e.bundled() && overlay != null ? overlay.get(e.blueprint().id()) : LibraryMeta.read(e.json());
		return Views.entry(e, meta);
	}

	@Override
	public void reload() {
		MinecraftServer s = ApiImpl.server();
		if (s == null) {
			return;
		}
		if (s.isSameThread()) {
			Blueprints.reload(s);
		} else {
			s.execute(() -> Blueprints.reload(s));
		}
	}

	@Override
	public CompletableFuture<Entry> makeVariant(String entryId, @Nullable JsonElement palette, @Nullable JsonObject values, @Nullable String name) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		JsonObject payload = new JsonObject();
		payload.addProperty("from", entryId);
		if (palette != null && !palette.isJsonNull()) {
			payload.add("palette", palette.deepCopy());
		}
		if (values != null && values.size() > 0) {
			payload.add("values", values.deepCopy());
		}
		if (name != null && !name.isBlank()) {
			payload.addProperty("name", name.strip());
		}
		CompletableFuture<Entry> done = new CompletableFuture<>();
		b.variantRequest(payload).whenComplete((id, err) -> {
			if (err != null) {
				ApiImpl.runOnServer(() -> done.completeExceptionally(err));
			} else {
				waiting.put(id, done);
			}
		});
		return done;
	}

	/** A variant job finished (from the client's sidecar state, server thread): reloads, then completes and fires VARIANT_DONE. */
	void variantFinished(MinecraftServer server, String variantId, boolean ok, @Nullable String blueprintId, @Nullable String error, boolean isImport) {
		CompletableFuture<Entry> f = waiting.remove(variantId);
		if (!ok || blueprintId == null) {
			if (f != null) {
				f.completeExceptionally(new IllegalStateException(error == null ? "the variant failed" : error));
			}
			return;
		}
		if (Blueprints.entry(blueprintId) == null) {
			Blueprints.reload(server);
		}
		Optional<Entry> e = get(blueprintId);
		if (e.isEmpty()) {
			if (f != null) {
				f.completeExceptionally(new IllegalStateException("variant " + blueprintId + " is not in the library after a reload"));
			}
			return;
		}
		if (f != null) {
			f.complete(e.get());
		}
		if (!isImport) {
			ApiEvents.variantDone(e.get());
		}
	}

	@Override
	public CompletableFuture<Boolean> delete(String entryId) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			return CompletableFuture.completedFuture(false);
		}
		return ApiImpl.onServerFuture(b.deleteEntry(entryId));
	}

	@Override
	public void setExt(String entryId, String key, @Nullable JsonElement value) {
		if (!ApiRules.extKeyValid(key)) {
			throw new IllegalArgumentException("ext keys are namespaced: <modid>:<key> (got " + key + ")");
		}
		Blueprints.Entry e = Blueprints.entry(entryId);
		if (e == null) {
			throw new IllegalArgumentException("no library entry " + entryId);
		}
		if (e.bundled() || e.dir() == null) {
			throw new IllegalArgumentException(entryId + " is bundled (read-only, in the jar): its ext can't change");
		}
		Path file = e.dir().resolve(entryId + Blueprints.SIDECAR_SUFFIX);
		try {
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject ext = o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject();
			if (value == null || value.isJsonNull()) {
				ext.remove(key);
			} else {
				ext.add(key, value.deepCopy());
			}
			if (ext.size() == 0) {
				o.remove("ext");
			} else {
				o.add("ext", ext);
			}
			LibraryMeta.writeAtomically(file, LibraryMeta.pretty(o));
		} catch (IOException | RuntimeException ex) {
			throw new IllegalStateException("could not write the ext of " + entryId + ": " + ex.getMessage(), ex);
		}
		Architect.LOGGER.info("Library: {} ext {} = {}", entryId, key, value);
		MinecraftServer s = ApiImpl.server();
		if (s != null && s.isSameThread()) {
			Blueprints.reload(s);
		} else {
			reload();
		}
	}

	/** Merges {@code ext} into a user entry's blueprint JSON (a design's request ext); false when bundled or unknown. */
	static boolean mergeExt(String entryId, JsonObject ext) {
		Blueprints.Entry e = Blueprints.entry(entryId);
		Path dir = e != null ? e.dir() : Blueprints.userDir().resolve(entryId);
		if (e != null && e.bundled() || dir == null) {
			return false;
		}
		Path file = dir.resolve(entryId + Blueprints.SIDECAR_SUFFIX);
		if (!Files.isRegularFile(file)) {
			return false;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(file, StandardCharsets.UTF_8)).getAsJsonObject();
			JsonObject cur = o.has("ext") && o.get("ext").isJsonObject() ? o.getAsJsonObject("ext") : new JsonObject();
			boolean changed = false;
			for (var en : ext.entrySet()) {
				if (!en.getValue().equals(cur.get(en.getKey()))) {
					cur.add(en.getKey(), en.getValue().deepCopy());
					changed = true;
				}
			}
			if (changed) {
				o.add("ext", cur);
				LibraryMeta.writeAtomically(file, LibraryMeta.pretty(o));
			}
			return true;
		} catch (IOException | RuntimeException ex) {
			Architect.LOGGER.warn("Could not copy the request's ext into {}", file, ex);
			return false;
		}
	}

	@Override
	public void setTags(String entryId, List<String> userTags) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			throw new IllegalStateException("tags are kept by the client's Library; no client here");
		}
		b.setTags(entryId, userTags == null ? List.of() : List.copyOf(userTags));
	}
}
