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
import dev.larattalabs.architect.api.Estimate;
import dev.larattalabs.architect.api.Group;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.placement.Blueprint;
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
	 * The wire form of a request: owner, ext, model, budgetUsd, bible, bibleVersion and profile only for protocol 2
	 * (design.request v2; a protocol-1 sidecar would drop them anyway). {@code group} is never sent: the 4b sidecar sets it
	 * for a group's items and refuses a design.request that carries it ({@link #request} refuses it first). {@code profile}
	 * only for an open (non-preset) type.
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
				if (r.bibleVersion() != null) {
					o.addProperty("bibleVersion", r.bibleVersion());
				}
			}
			if (!r.profile().isEmpty() && !Blueprint.TYPES.contains(r.type())) {
				JsonArray p = new JsonArray();
				r.profile().forEach(p::add);
				o.add("profile", p);
			}
		}
		return o;
	}

	/** Why the helper can't take this request (null: it can): a group set, an open type or a bible without 4b. */
	static @Nullable String refusal(DesignRequest r, ClientBridge b) {
		if (r.group() != null) {
			return "group is set by Designs.requestGroup; a single design request can't carry one";
		}
		if (!Blueprint.TYPES.contains(r.type()) && !b.sidecarFeatures().contains("open.types")) {
			return "the open type " + r.type() + " needs a helper with open types (phase 4b); this one takes only the 11 preset types";
		}
		if (r.bible() != null && !b.sidecarFeatures().contains("bibles")) {
			return "designing with a bible needs a helper with bibles (phase 4b)";
		}
		return null;
	}

	@Override
	public CompletableFuture<String> request(DesignRequest r) {
		load();
		ClientBridge b = ApiImpl.bridge();
		if (b == null || !b.connected()) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException("the design helper is not running")));
		}
		String why = refusal(r, b);
		if (why != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException(why)));
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

	// ------------------------------------------------------------------ groups (4b)

	/** The groups the helper reported (merged), the DONE ledger, persisted in api-groups.json. */
	final RecordBook groups = new RecordBook("group", Blueprints.gameDataDir().resolve("api-groups.json"), 100,
		g -> Group.Status.of(RecordBook.str(g, "status")).isFinal(), g -> new JobLedger.Mark(RecordBook.str(g, "status"), stepOf(g),
			RecordBook.num(g, "updatedAt"), Wire4b.cost(g).usd()));

	/** What changes a group's update besides its status: each item's status and step. */
	private static String stepOf(JsonObject g) {
		StringBuilder b = new StringBuilder();
		JsonElement is = g.get("items");
		if (is != null && is.isJsonArray()) {
			for (JsonElement e : is.getAsJsonArray()) {
				if (e.isJsonObject()) {
					b.append(RecordBook.str(e.getAsJsonObject(), "status")).append(':').append(RecordBook.str(e.getAsJsonObject(), "step")).append('|');
				}
			}
		}
		return b.toString();
	}

	/** Why 4b {@code feature} can't be used now, or null. */
	static @Nullable String unavailable4b(@Nullable ClientBridge b, String feature, String what) {
		if (b == null || !b.connected()) {
			return "the Architect helper is not running";
		}
		if (b.protocol() < 2 || !b.sidecarFeatures().contains(feature)) {
			return what + " need a helper with phase 4b (" + feature + "); this one does not have it";
		}
		return null;
	}

	/** Sends one message, completes with its ack's result (failed for an ok:false ack), on the server thread. */
	static CompletableFuture<JsonObject> ask(String feature, String what, JsonObject message) {
		ClientBridge b = ApiImpl.bridge();
		String why = unavailable4b(b, feature, what);
		if (why != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalStateException(why)));
		}
		return ApiImpl.onServerFuture(b.send(message).thenApply(ack -> {
			if (!ack.has("ok") || !ack.get("ok").getAsBoolean()) {
				throw new java.util.concurrent.CompletionException(new IllegalStateException(ack.has("error") ? ack.get("error").getAsString()
					: "refused by the helper"));
			}
			return ack.has("result") && ack.get("result").isJsonObject() ? ack.getAsJsonObject("result") : new JsonObject();
		}));
	}

	static JsonObject msg(String type) {
		JsonObject m = new JsonObject();
		m.addProperty("type", type);
		return m;
	}

	@Override
	public CompletableFuture<String> requestGroup(GroupRequest r) {
		JsonObject m = msg("design.group");
		try {
			m.add("group", Wire4b.group(r));
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		return ask("design.groups", "design groups", m).thenApply(res -> {
			String id = res.has("groupId") ? res.get("groupId").getAsString() : null;
			if (id == null) {
				throw new IllegalStateException("the helper sent no groupId");
			}
			Architect.LOGGER.info("API: design group {} ({} items{}) requested", id, r.items().size(), r.owner() == null ? "" : ", " + r.owner());
			return id;
		});
	}

	@Override
	public Optional<Group> group(String groupId) {
		JsonObject g = groups.get(groupId);
		return g == null ? Optional.empty() : Optional.of(Wire4b.group(g));
	}

	@Override
	public List<Group> listGroups(@Nullable String owner) {
		List<Group> out = new ArrayList<>();
		for (JsonObject g : groups.all()) {
			Group v = Wire4b.group(g);
			if (owner == null || owner.equals(v.owner().orElse(null))) {
				out.add(v);
			}
		}
		return out;
	}

	@Override
	public CompletableFuture<Void> cancelGroup(String groupId) {
		JsonObject m = msg("group.cancel");
		m.addProperty("groupId", groupId);
		return ask("design.groups", "design groups", m).thenApply(r -> null);
	}

	@Override
	public CompletableFuture<Void> extendGroup(String groupId, double budgetUsd) {
		JsonObject m = msg("group.extend");
		m.addProperty("groupId", groupId);
		m.addProperty("budgetUsd", budgetUsd);
		return ask("design.groups", "design groups", m).thenApply(r -> null);
	}

	@Override
	public CompletableFuture<Void> resumeGroup(String groupId) {
		JsonObject m = msg("group.resume");
		m.addProperty("groupId", groupId);
		return ask("design.groups", "design groups", m).thenApply(r -> null);
	}

	@Override
	public CompletableFuture<Estimate> estimate(GroupRequest r) {
		JsonObject m = msg("design.estimate");
		try {
			m.add("group", Wire4b.group(r));
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		return ask("estimates", "estimates", m).thenApply(Wire4b::estimate);
	}

	@Override
	public CompletableFuture<Estimate> estimate(DesignRequest r) {
		JsonObject m = msg("design.estimate");
		JsonObject w = wire(r, 2);
		m.add("request", w);
		return ask("estimates", "estimates", m).thenApply(Wire4b::estimate);
	}

	/** {@code group.upsert} or a snapshot's group (any thread): merged; the events fire on the server thread. */
	void groupChanged(JsonObject raw) {
		JsonObject g = groups.merge(raw);
		if (g != null) {
			ApiImpl.runOnServer(() -> fireGroup(g));
		}
	}

	/** Server thread: GROUP_UPDATED when it changed, GROUP_DONE once (after a library reload, so its entries are loaded). */
	void fireGroup(JsonObject raw) {
		RecordBook.Firing f = groups.fire(raw);
		if (!f.updated() && !f.done()) {
			return;
		}
		Group g = Wire4b.group(raw);
		if (f.updated()) {
			ApiEvents.groupUpdated(g);
		}
		if (f.done()) {
			MinecraftServer s = ApiImpl.server();
			if (s != null && g.items().stream().anyMatch(i -> i.entryId().isPresent() && Blueprints.entry(i.entryId().get()) == null)) {
				Blueprints.reload(s);
			}
			ApiEvents.groupDone(g);
		}
	}

	/** A world loaded (server thread): GROUP_DONE for the groups that finished while none was. */
	void catchUpGroups() {
		groups.pendingDone().forEach(this::fireGroup);
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
