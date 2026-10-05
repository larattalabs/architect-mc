package dev.larattalabs.architect.apiimpl;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.api.Cost;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Designs;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.MinecraftServer;
import org.jspecify.annotations.Nullable;

/**
 * {@link Designs} over the client's sidecar link ({@code design.request}, protocol 1 or 2). The request's {@code owner} and
 * {@code ext} are kept here, in {@code <gameDir>/architect/api-designs.json}, because a protocol-1 sidecar drops them: they
 * answer {@link #list(String)} and are copied into the new entry's blueprint JSON when the design is done (a protocol-2
 * sidecar merges ext into the entry itself; the copy then finds nothing to change). Finished designs
 * already reported are remembered there too, so a reconnect's snapshot does not fire {@code DESIGN_DONE} twice. Internal.
 */
final class DesignsImpl implements Designs {
	private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();
	/** How many finished designs to remember (beyond that, the oldest are forgotten). */
	private static final int KEEP = 500;

	private record Meta(@Nullable String owner, JsonObject ext) {
	}

	private final Map<String, Meta> meta = new LinkedHashMap<>();
	private final Set<String> handled = new LinkedHashSet<>();
	private boolean loaded;

	private static Path file() {
		return Blueprints.gameDataDir().resolve("api-designs.json");
	}

	private synchronized void load() {
		if (loaded) {
			return;
		}
		loaded = true;
		Path f = file();
		if (!Files.exists(f)) {
			return;
		}
		try {
			JsonObject o = JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject();
			if (o.has("designs") && o.get("designs").isJsonObject()) {
				for (var e : o.getAsJsonObject("designs").entrySet()) {
					JsonObject m = e.getValue().getAsJsonObject();
					meta.put(e.getKey(), new Meta(m.has("owner") ? m.get("owner").getAsString() : null,
						m.has("ext") && m.get("ext").isJsonObject() ? m.getAsJsonObject("ext") : new JsonObject()));
				}
			}
			if (o.has("done") && o.get("done").isJsonArray()) {
				o.getAsJsonArray("done").forEach(x -> handled.add(x.getAsString()));
			}
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("Could not read {}; design owners start empty", f, e);
		}
	}

	private synchronized void save() {
		while (meta.size() > KEEP) {
			meta.remove(meta.keySet().iterator().next());
		}
		while (handled.size() > KEEP) {
			handled.remove(handled.iterator().next());
		}
		JsonObject o = new JsonObject();
		JsonObject ds = new JsonObject();
		meta.forEach((id, m) -> {
			JsonObject j = new JsonObject();
			if (m.owner() != null) {
				j.addProperty("owner", m.owner());
			}
			j.add("ext", m.ext());
			ds.add(id, j);
		});
		o.add("designs", ds);
		JsonArray done = new JsonArray();
		handled.forEach(done::add);
		o.add("done", done);
		Path f = file();
		try {
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", f, e);
		}
	}

	/**
	 * The wire form of a request: owner, ext, model, budgetUsd, bible and group only for protocol 2 (design.request v2; a
	 * protocol-1 sidecar would drop them anyway). bible and group are reserved for 4b: the sidecar accepts and ignores them.
	 */
	static JsonObject wire(DesignRequest r, int protocol) {
		JsonObject o = new JsonObject();
		o.addProperty("type", r.type());
		o.addProperty("style", r.style() == null ? "" : r.style());
		if (r.materials() != null && !r.materials().isBlank()) {
			o.addProperty("materials", r.materials());
		}
		JsonArray f = new JsonArray();
		r.features().forEach(f::add);
		o.add("features", f);
		JsonObject size = new JsonObject();
		size.addProperty("x", r.maxSize().x());
		size.addProperty("y", r.maxSize().y());
		size.addProperty("z", r.maxSize().z());
		o.add("maxSize", size);
		if (r.name() != null && !r.name().isBlank()) {
			o.addProperty("name", r.name());
		}
		if (r.notes() != null && !r.notes().isBlank()) {
			o.addProperty("notes", r.notes());
		}
		if (r.remix() != null && !r.remix().isBlank()) {
			o.addProperty("remix", r.remix());
		}
		if (protocol >= 2) {
			if (r.owner() != null) {
				o.addProperty("owner", r.owner());
			}
			if (r.ext().size() > 0) {
				o.add("ext", r.ext().deepCopy());
			}
			if (r.model() != null) {
				o.addProperty("model", r.model());
			}
			if (r.budgetUsd() != null) {
				o.addProperty("budgetUsd", r.budgetUsd());
			}
			if (r.bible() != null) {
				o.addProperty("bible", r.bible());
			}
			if (r.group() != null) {
				o.addProperty("group", r.group());
			}
		}
		return o;
	}

	@Override
	public CompletableFuture<String> request(DesignRequest r) {
		load();
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		CompletableFuture<String> out = b.designRequest(wire(r, b.protocol())).thenApply(id -> {
			synchronized (this) {
				meta.put(id, new Meta(r.owner(), r.ext().deepCopy()));
			}
			save();
			return id;
		});
		// completes at the ack: the link's ack timeout and a dropped link already fail it; this is the backstop
		return ApiImpl.onServerFuture(out.orTimeout(ApiTimeouts.DESIGN_MS, java.util.concurrent.TimeUnit.MILLISECONDS));
	}

	/**
	 * A world loaded (server thread): DESIGN_DONE for the designs that finished while no world was loaded (their changes were
	 * dropped then). Designs reported before are skipped (the persisted done set).
	 */
	void catchUp(MinecraftServer server, List<JsonObject> raws) {
		load();
		for (JsonObject raw : raws) {
			Design d = view(raw);
			boolean seen;
			synchronized (this) {
				seen = handled.contains(d.id() + "@" + d.createdAt());
			}
			if (d.status().isFinal() && !seen) {
				changed(server, raw);
			}
		}
	}

	@Override
	public void cancel(String designId) {
		ClientBridge b = ApiImpl.bridge();
		if (b != null) {
			b.designCancel(designId);
		}
	}

	@Override
	public Optional<Design> get(String designId) {
		return all().stream().filter(d -> d.id().equals(designId)).findFirst();
	}

	@Override
	public List<Design> list(@Nullable String owner) {
		return all().stream().filter(d -> owner == null || owner.equals(d.owner().orElse(null))).toList();
	}

	private List<Design> all() {
		load();
		ClientBridge b = ApiImpl.bridge();
		if (b == null) {
			return List.of();
		}
		List<Design> out = new ArrayList<>();
		for (JsonObject raw : b.designs()) {
			out.add(view(raw));
		}
		out.sort((x, y) -> Long.compare(y.createdAt(), x.createdAt()));
		return out;
	}

	synchronized Design view(JsonObject raw) {
		String id = str(raw, "id");
		Meta m = id == null ? null : meta.get(id);
		JsonObject req = raw.has("request") && raw.get("request").isJsonObject() ? raw.getAsJsonObject("request").deepCopy() : new JsonObject();
		String owner = m != null ? m.owner() : str(req, "owner");
		if (m != null) {
			if (m.owner() != null) {
				req.addProperty("owner", m.owner());
			}
			if (m.ext().size() > 0) {
				req.add("ext", m.ext().deepCopy());
			}
		}
		return new Design(id == null ? "?" : id, Design.Status.of(str(raw, "status")), str(raw, "step") == null ? "" : str(raw, "step"),
			Optional.ofNullable(str(raw, "blueprintId")), raw.has("cost") && raw.get("cost").isJsonObject() ? Cost.fromJson(raw.getAsJsonObject("cost"))
			: Cost.NONE, Optional.ofNullable(str(raw, "error")), req, Optional.ofNullable(owner), num(raw, "createdAt"), num(raw, "updatedAt"));
	}

	/**
	 * A design changed (any source: the API, the Design tab, a snapshot). Server thread. Fires DESIGN_UPDATED; the first time a
	 * design is seen finished, copies the request's ext into its entry, reloads the library and fires DESIGN_DONE.
	 */
	void changed(MinecraftServer server, JsonObject raw) {
		load();
		Design d = view(raw);
		ApiEvents.designUpdated(d);
		if (!d.status().isFinal()) {
			return;
		}
		String key = d.id() + "@" + d.createdAt();
		synchronized (this) {
			if (!handled.add(key)) {
				return;
			}
		}
		if (d.status() == Design.Status.DONE && d.entryId().isPresent()) {
			Meta m;
			synchronized (this) {
				m = meta.get(d.id());
			}
			if (m != null && m.ext().size() > 0) {
				LibraryImpl.mergeExt(d.entryId().get(), m.ext());
			}
			Blueprints.reload(server);
		}
		save();
		ApiEvents.designDone(d);
	}

	private static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	private static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0L;
	}
}
