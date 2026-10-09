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
	/** (5a) the critique rounds reported by DESIGN_CRITIQUED ({@code designId@createdAt#n}), persisted with the rest. */
	private final Set<String> critiqued = new LinkedHashSet<>();
	/** (5a) report critiques of library entries waiting for their design ({@link #critique}). */
	private final PendingFutures<dev.larattalabs.architect.api.Critique> critiqueWaiting = new PendingFutures<>("critique", 10 * 60_000L);
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
			if (o.has("critiqued") && o.get("critiqued").isJsonArray()) {
				o.getAsJsonArray("critiqued").forEach(x -> critiqued.add(x.getAsString()));
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
		while (critiqued.size() > 4 * KEEP) {
			critiqued.remove(critiqued.iterator().next());
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
		JsonArray cr = new JsonArray();
		critiqued.forEach(cr::add);
		o.add("critiqued", cr);
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
			// 4c (only when set: a 4b helper sees the 4b shape)
			if (r.massing()) {
				o.addProperty("massing", true);
			}
			if (r.fromMassing() != null) {
				o.addProperty("fromMassing", r.fromMassing());
				if (r.massingVersion() != null) {
					o.addProperty("massingVersion", r.massingVersion());
				}
			}
			if (r.context() != null) {
				o.add("context", Wire4c.contextWire(r.context()));
			}
			// 5a (only when on: a design with critique off is sent exactly as in 4c)
			if (r.critique() != null && r.critique().on()) {
				o.add("critique", Wire5a.spec(r.critique()));
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
		String why = refusal4c(r, b.protocol(), b.sidecarFeatures());
		return why != null ? why : refusal5a(r.critique(), b.protocol(), b.sidecarFeatures());
	}

	/** Why a critique can't be sent (null: it can, or it is off). Pure. */
	static @Nullable String refusal5a(dev.larattalabs.architect.api.@Nullable CritiqueSpec c, int protocol, java.util.Set<String> features) {
		if (c == null || !c.on()) {
			return null;
		}
		if (protocol < 2 || !features.contains("critique")) {
			return "critique needs a helper with the critique loop (phase 5a); this one does not have it";
		}
		return null;
	}

	/** Why a group's critiques can't be sent (null: they can, or none is on). Pure. */
	static @Nullable String refusal5a(GroupRequest g, int protocol, java.util.Set<String> features) {
		String why = refusal5a(g.critique(), protocol, features);
		for (GroupRequest.Item it : g.items()) {
			if (why == null) {
				why = refusal5a(it.critique() != null ? it.critique() : it.request().critique(), protocol, features);
			}
		}
		return why;
	}

	/** Why the 4c fields can't be sent (null: they can). Pure. */
	static @Nullable String refusal4c(DesignRequest r, int protocol, java.util.Set<String> features) {
		boolean uses = r.massing() || r.fromMassing() != null || r.context() != null;
		if (uses && (protocol < 2 || !features.contains("massing"))) {
			return "massings, detail passes and context need a helper with the massing pass (phase 4c); this one does not have it";
		}
		if (r.massing() && r.fromMassing() != null) {
			return "a request is a massing or the detail of one, not both";
		}
		if (r.massingVersion() != null && r.fromMassing() == null) {
			return "massingVersion needs fromMassing";
		}
		if (r.fromMassing() != null && !Wire4c.MASSING_ID.matcher(r.fromMassing()).matches()) {
			return "fromMassing is not a massing id: " + r.fromMassing();
		}
		return Wire4c.contextProblem(r.context());
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

	/** (6b) A design started outside {@link #request} (a region design): its owner and ext are kept as for any API design. */
	public void remember(String id, @Nullable String owner, JsonObject ext) {
		synchronized (this) {
			meta.put(id, new Meta(owner, ext == null ? new JsonObject() : ext.deepCopy()));
		}
		save();
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
		// phase 6b: a region design (kind "region") carries its pick's result; Design.kind() reads request.kind
		Optional<JsonObject> result = Optional.empty();
		if ("region".equals(str(raw, "kind")) || "region".equals(str(req, "kind"))) {
			req.addProperty("kind", "region");
			JsonObject res = raw.has("result") && raw.get("result").isJsonObject() ? raw.getAsJsonObject("result").deepCopy() : null;
			String planId = id == null ? null : dev.larattalabs.architect.region.RegionDesigns.planIdOf(id);
			if (res != null && planId != null && !res.has("planId")) {
				res.addProperty("planId", planId);
			}
			String planError = id == null ? null : dev.larattalabs.architect.region.RegionDesigns.planErrorOf(id);
			if (res != null && planError != null) {
				res.addProperty("planError", planError);
			}
			result = Optional.ofNullable(res);
		}
		return new Design(id == null ? "?" : id, Design.Status.of(str(raw, "status")), str(raw, "step") == null ? "" : str(raw, "step"),
			Optional.ofNullable(str(raw, "blueprintId")), raw.has("cost") && raw.get("cost").isJsonObject() ? Cost.fromJson(raw.getAsJsonObject("cost"))
			: Cost.NONE, Optional.ofNullable(str(raw, "error")), req, Optional.ofNullable(owner), num(raw, "createdAt"), num(raw, "updatedAt"),
			Wire4c.designMassing(raw), Wire4c.conformance(raw.get("conformance")), Wire5a.record(raw.get("critique")), Optional.ofNullable(str(raw,
				"critiqueOf")), Wire5b.polish(raw.get("polish")), result);
	}

	/**
	 * A design changed (any source: the API, the Design tab, a snapshot). Server thread. Fires DESIGN_UPDATED; the first time a
	 * design is seen finished, copies the request's ext into its entry, reloads the library and fires DESIGN_DONE.
	 */
	void changed(MinecraftServer server, JsonObject raw) {
		load();
		Design d = view(raw);
		ApiEvents.designUpdated(d);
		fireCritiqued(d);
		if (d.kind() == Design.Kind.REGION) {
			dev.larattalabs.architect.region.RegionDesigns.changed(server, d); // phase 6b: a fit plans the picked program
		}
		if (!d.status().isFinal()) {
			return;
		}
		settleReport(d);
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
		applyPolish(server, raw, d);
	}

	/**
	 * A polish that installed a version with {@code apply.preview} false (API only): the deltas of its sites (listed, or every
	 * site standing at an older version of the entry) are queued as one batch with the caller as owner. With preview (the
	 * default) the sites only show "update available" ({@code SiteView.version} below {@code headVersion}).
	 */
	void applyPolish(MinecraftServer server, JsonObject raw, Design d) {
		if (d.status() != Design.Status.DONE || d.polish().isEmpty() || d.polish().get().installedVersion() == null) {
			return;
		}
		JsonObject p = raw.get("polish") instanceof JsonObject o ? o : null;
		JsonObject apply = p != null && p.get("apply") instanceof JsonObject a ? a : null;
		if (apply == null || !apply.has("preview") || apply.get("preview").getAsBoolean()) {
			return;
		}
		String entry = p.has("entryId") ? p.get("entryId").getAsString() : d.entryId().orElse(null);
		if (entry == null) {
			return;
		}
		int head = d.polish().get().installedVersion();
		java.util.Set<String> listed = new java.util.LinkedHashSet<>();
		if (apply.get("sites") instanceof com.google.gson.JsonArray ids) {
			ids.forEach(x -> listed.add(x.getAsString()));
		}
		List<dev.larattalabs.architect.api.Batch.Item> items = new ArrayList<>();
		String owner = d.owner().orElse(null);
		for (dev.larattalabs.architect.site.Site s : dev.larattalabs.architect.site.Sites.all()) {
			if (!s.blueprint().equals(entry) || !listed.isEmpty() && !listed.contains(s.id())) {
				continue;
			}
			if (dev.larattalabs.architect.site.SiteDeltas.versionOf(server, s) >= head) {
				continue;
			}
			items.add(dev.larattalabs.architect.api.Batch.Item.delta("polish-" + s.id(), new dev.larattalabs.architect.api.DeltaRequest(s.id(), head, null,
				null, null, false, new JsonObject(), owner), null, List.of()));
		}
		if (items.isEmpty()) {
			return;
		}
		try {
			String id = dev.larattalabs.architect.site.Batches.queue(server, dev.larattalabs.architect.api.Batch.of(owner, items));
			Architect.LOGGER.info("Polish {} of {}: {} site update(s) queued as batch {}", d.id(), entry, items.size(), id);
		} catch (RuntimeException e) {
			Architect.LOGGER.warn("Polish {} of {}: the site updates could not be queued ({})", d.id(), entry, e.getMessage());
		}
	}

	// ------------------------------------------------------------------ 5a: critique

	/** DESIGN_CRITIQUED for the rounds of {@code d} that got their verdict and were not reported yet (server thread). */
	private void fireCritiqued(Design d) {
		if (d.critique().isEmpty()) {
			return;
		}
		List<dev.larattalabs.architect.api.Critique.Round> fresh = new ArrayList<>();
		synchronized (this) {
			for (var r : Wire5a.verdictRounds(d.critique().get())) {
				if (critiqued.add(Wire5a.roundKey(d.id(), d.createdAt(), r.n()))) {
					fresh.add(r);
				}
			}
		}
		if (fresh.isEmpty()) {
			return;
		}
		save();
		fresh.forEach(r -> ApiEvents.designCritiqued(d.id(), r));
	}

	/** A report critique's design ended: its {@link #critique} future completes (or fails). */
	private void settleReport(Design d) {
		if (d.critiqueOf().isEmpty()) {
			return;
		}
		long now = System.currentTimeMillis();
		if (d.status() == Design.Status.DONE && d.critique().isPresent()) {
			critiqueWaiting.complete(d.id(), d.critique().get(), now);
		} else {
			critiqueWaiting.fail(d.id(), new IllegalStateException("the critique of " + d.critiqueOf().get() + " " + d.status().name().toLowerCase(
				java.util.Locale.ROOT) + d.error().map(e -> ": " + e).orElse("")), now);
		}
	}

	@Override
	public CompletableFuture<dev.larattalabs.architect.api.Critique> critique(String entryId, dev.larattalabs.architect.api.@Nullable CritiqueSpec spec) {
		JsonObject m;
		try {
			m = Wire5a.critiqueMessage(entryId, spec);
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		CompletableFuture<dev.larattalabs.architect.api.Critique> done = new CompletableFuture<>();
		ask("critique.report", "report critiques of library entries", m).whenComplete((res, err) -> {
			if (err != null) {
				done.completeExceptionally(err);
				return;
			}
			String id = res.has("designId") ? res.get("designId").getAsString() : null;
			if (id == null) {
				done.completeExceptionally(new IllegalStateException("the helper sent no designId"));
				return;
			}
			Architect.LOGGER.info("API: report critique {} of {} requested", id, entryId);
			critiqueWaiting.await(id, done, System.currentTimeMillis(), ApiTimeouts.CRITIQUE_MS);
			// it may have finished before the ack was processed (a design record already final)
			ClientBridge b = ApiImpl.bridge();
			if (b != null) {
				for (JsonObject raw : b.designs()) {
					if (id.equals(str(raw, "id"))) {
						Design d = view(raw);
						if (d.status().isFinal()) {
							settleReport(d);
						}
					}
				}
			}
		});
		return ApiImpl.onServerFuture(done);
	}

	/** Fails the critique futures past their timeout (any thread). */
	void expire(long now) {
		critiqueWaiting.expire(now);
	}

	/**
	 * A group with each item's critique filled from its design's record when this game has it (every round), else the item's
	 * summary as the helper sent it.
	 */
	Group withCritiques(Group g) {
		ClientBridge b = ApiImpl.bridge();
		if (b == null || g.items().stream().noneMatch(i -> i.critique().isPresent())) {
			return g;
		}
		Map<String, JsonObject> raws = new java.util.HashMap<>();
		for (JsonObject raw : b.designs()) {
			String id = str(raw, "id");
			if (id != null) {
				raws.put(id, raw);
			}
		}
		List<Group.Item> items = new ArrayList<>();
		for (Group.Item i : g.items()) {
			JsonObject raw = raws.get(i.designId());
			var full = raw == null ? java.util.Optional.<dev.larattalabs.architect.api.Critique>empty() : Wire5a.record(raw.get("critique"));
			items.add(full.isEmpty() ? i : new Group.Item(i.itemKey(), i.ext(), i.designId(), i.entryId(), i.status(), i.step(), i.cost(), i.wave(),
				i.role(), i.model(), i.type(), i.name(), i.error(), i.stage(), i.massing(), i.rounds(), i.designIds(), full));
		}
		return new Group(g.id(), g.name(), g.bible(), g.owner(), g.ext(), g.concurrency(), g.budgetUsd(), g.softBudgetFraction(), g.status(), g.reason(),
			items, g.wave(), g.done(), g.failed(), g.cost(), g.usageLimitUntil(), g.createdAt(), g.updatedAt(), g.massingFirst(), g.approvalUi(),
			g.maxRedirects(), g.context(), g.awaiting());
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
					JsonObject i = e.getAsJsonObject();
					b.append(RecordBook.str(i, "status")).append(':').append(RecordBook.str(i, "step")).append(':').append(RecordBook.str(i, "stage"))
						.append(':').append(Wire4c.ref(i.get("massing")).map(Object::toString).orElse("")).append(':').append(RecordBook.num(i, "rounds"))
						.append(':').append(RecordBook.str(i, "designId")).append('|');
				}
			}
		}
		JsonElement aw = g.get("awaiting");
		if (aw != null) {
			b.append("awaiting=").append(aw);
		}
		return b.toString();
	}

	/** A group's critique refusal against the connected helper (null: fine or not connected; the send reports that). */
	private static @Nullable String critiqueRefusal(GroupRequest r) {
		ClientBridge b = ApiImpl.bridge();
		return b == null || !b.connected() ? null : refusal5a(r, b.protocol(), b.sidecarFeatures());
	}

	/** Why 4b {@code feature} can't be used now, or null. */
	static @Nullable String unavailable4b(@Nullable ClientBridge b, String feature, String what) {
		if (b == null || !b.connected()) {
			return "the Architect helper is not running";
		}
		if (b.protocol() < 2 || !b.sidecarFeatures().contains(feature)) {
			String phase = switch (feature) {
				case "massing" -> "4c";
				case "critique", "critique.report", "job.images", "bible.admin", "bible.restraint" -> "5a";
				case "design.polish", "entry.versions", "entry.delta", "critique.polish" -> "5b";
				default -> "4b";
			};
			return what + " need a helper with phase " + phase + " (" + feature + "); this one does not have it";
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
		String why5a = critiqueRefusal(r);
		if (why5a != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException(why5a)));
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
		return g == null ? Optional.empty() : Optional.of(withCritiques(Wire4b.group(g)));
	}

	@Override
	public List<Group> listGroups(@Nullable String owner) {
		List<Group> out = new ArrayList<>();
		for (JsonObject g : groups.all()) {
			Group v = Wire4b.group(g);
			if (owner == null || owner.equals(v.owner().orElse(null))) {
				out.add(withCritiques(v));
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
		String why5a = critiqueRefusal(r);
		if (why5a != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException(why5a)));
		}
		return ask("estimates", "estimates", m).thenApply(Wire4b::estimate);
	}

	@Override
	public CompletableFuture<Estimate> estimate(DesignRequest r) {
		ClientBridge cb = ApiImpl.bridge();
		String why5a = cb == null ? null : refusal5a(r.critique(), cb.protocol(), cb.sidecarFeatures());
		if (why5a != null) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException(why5a)));
		}
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

	/**
	 * Server thread: GROUP_UPDATED when it changed, GROUP_AWAITING_APPROVAL when an item waits with a massing version not
	 * reported before (4c), GROUP_DONE once (after a library reload, so its entries are loaded).
	 */
	void fireGroup(JsonObject raw) {
		RecordBook.Firing f = groups.fire(raw);
		Group g = withCritiques(Wire4b.group(raw));
		boolean awaiting = awaitingFires(g);
		if (!f.updated() && !f.done() && !awaiting) {
			return;
		}
		if (f.updated()) {
			ApiEvents.groupUpdated(g);
		}
		if (awaiting) {
			ApiEvents.groupAwaitingApproval(g);
		}
		if (f.done()) {
			MinecraftServer s = ApiImpl.server();
			if (s != null && g.items().stream().anyMatch(i -> i.entryId().isPresent() && Blueprints.entry(i.entryId().get()) == null)) {
				Blueprints.reload(s);
			}
			ApiEvents.groupDone(g);
		}
	}

	/**
	 * A world loaded (server thread): GROUP_DONE for the groups that finished while none was, GROUP_AWAITING_APPROVAL for the
	 * ones that started waiting (4c), MASSING_DONE for the massing versions installed meanwhile (4c).
	 */
	void catchUpGroups() {
		groups.pendingDone().forEach(this::fireGroup);
		for (JsonObject raw : groups.all()) {
			Group g = Wire4b.group(raw);
			if (g.status() == Group.Status.AWAITING_APPROVAL && awaitingFires(g)) {
				ApiEvents.groupAwaitingApproval(g);
			}
		}
		massings.pendingDone().forEach(this::fireMassing);
	}

	// ------------------------------------------------------------------ 4c: massings, approval

	/** The massing versions seen (by {@code id@version}), the MASSING_DONE ledger; persisted in api-massings.json. */
	final RecordBook massings = new RecordBook("massing", Blueprints.gameDataDir().resolve("api-massings.json"), 300, m -> true,
		m -> new JobLedger.Mark("installed", Wire4c.ref(m.get("detail")).map(Object::toString).orElse(""), RecordBook.num(m, "createdAt"), 0),
		Wire4c::versionKey, Wire4c::doneKey);
	/** The GROUP_AWAITING_APPROVAL tokens reported, persisted in api-awaiting.json. */
	private final AwaitingLedger awaitingLedger = new AwaitingLedger();
	private boolean awaitingLoaded;

	private static Path awaitingFile() {
		return Blueprints.gameDataDir().resolve("api-awaiting.json");
	}

	/** Whether GROUP_AWAITING_APPROVAL fires for {@code g} now (and remembers it, persisted). */
	private synchronized boolean awaitingFires(Group g) {
		if (g.status() != Group.Status.AWAITING_APPROVAL) {
			return false;
		}
		if (!awaitingLoaded) {
			awaitingLoaded = true;
			try {
				Path f = awaitingFile();
				if (Files.exists(f)) {
					List<String> keys = new ArrayList<>();
					JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonArray("reported").forEach(e -> keys.add(e
						.getAsString()));
					awaitingLedger.restore(keys);
				}
			} catch (IOException | RuntimeException e) {
				Architect.LOGGER.warn("Could not read {}; GROUP_AWAITING_APPROVAL may fire again", awaitingFile(), e);
			}
		}
		if (!awaitingLedger.fire(JobLedger.key(g.id(), g.createdAt()), Wire4c.awaitingTokens(g))) {
			return false;
		}
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		awaitingLedger.keys().forEach(a::add);
		o.add("reported", a);
		try {
			Path f = awaitingFile();
			Files.createDirectories(f.getParent());
			Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
			Files.writeString(tmp, GSON.toJson(o), StandardCharsets.UTF_8);
			Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
		} catch (IOException e) {
			Architect.LOGGER.warn("Could not save {}", awaitingFile(), e);
		}
		return true;
	}

	/** {@code massing.upsert} or a snapshot's / massing.list's massing (any thread): merged; MASSING_DONE on the server thread. */
	void massingChanged(JsonObject raw, boolean fire) {
		JsonObject m = massings.merge(raw);
		if (m != null && fire) {
			ApiImpl.runOnServer(() -> fireMassing(m));
		}
	}

	/** {@code massing.removed {massingId}}: every version of it is forgotten. */
	void massingRemoved(String massingId) {
		massings.removeIf(m -> massingId.equals(RecordBook.str(m, "id")));
	}

	/** Server thread: MASSING_DONE once per installed version. */
	void fireMassing(JsonObject raw) {
		if (massings.fire(raw).done()) {
			ApiEvents.massingDone(Wire4c.massing(raw));
		}
	}

	/** Every version this game knows of {@code massingId}, ascending. */
	private List<JsonObject> versionsOf(String massingId) {
		List<JsonObject> out = new ArrayList<>();
		for (JsonObject m : massings.all()) {
			if (massingId.equals(RecordBook.str(m, "id"))) {
				out.add(m);
			}
		}
		out.sort(java.util.Comparator.comparingLong(m -> RecordBook.num(m, "version")));
		return out;
	}

	@Override
	public Optional<dev.larattalabs.architect.api.Massing> massing(String massingId) {
		List<JsonObject> vs = versionsOf(massingId);
		return vs.isEmpty() ? Optional.empty() : Optional.of(Wire4c.massing(vs.get(vs.size() - 1)));
	}

	@Override
	public Optional<dev.larattalabs.architect.api.Massing> massing(String massingId, int version) {
		List<JsonObject> vs = versionsOf(massingId);
		if (vs.isEmpty()) {
			return Optional.empty();
		}
		// an older version's record was stored when it was the latest: its versions list comes from the newest record
		JsonElement all = vs.get(vs.size() - 1).get("versions");
		return vs.stream().filter(m -> RecordBook.num(m, "version") == version).findFirst().map(m -> {
			JsonObject c = m.deepCopy();
			if (all != null) {
				c.add("versions", all.deepCopy());
			}
			return Wire4c.massing(c);
		});
	}

	@Override
	public List<dev.larattalabs.architect.api.Massing> listMassings(@Nullable String owner) {
		Map<String, JsonObject> latest = new LinkedHashMap<>();
		for (JsonObject m : massings.all()) {
			String id = RecordBook.str(m, "id");
			JsonObject had = latest.get(id);
			if (had == null || RecordBook.num(m, "version") > RecordBook.num(had, "version")) {
				latest.put(id, m);
			}
		}
		List<dev.larattalabs.architect.api.Massing> out = new ArrayList<>();
		for (JsonObject m : latest.values()) {
			dev.larattalabs.architect.api.Massing v = Wire4c.massing(m);
			if (owner == null || owner.equals(v.owner().orElse(null))) {
				out.add(v);
			}
		}
		out.sort((a, b) -> Long.compare(b.createdAt(), a.createdAt()));
		return out;
	}

	@Override
	public CompletableFuture<Group.Redirected> redirectMassing(String massingId, String notes, @Nullable String owner) {
		if (notes == null || notes.isBlank() || notes.strip().length() > 2000) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(new IllegalArgumentException("redirect notes are 1 to 2000 characters")));
		}
		JsonObject m = msg("massing.redirect");
		m.addProperty("massingId", massingId);
		m.addProperty("notes", notes.strip());
		if (owner != null) {
			m.addProperty("owner", owner);
		}
		return ask("massing", "massing redirects", m).thenApply(Wire4c::redirected);
	}

	@Override
	public CompletableFuture<Integer> deleteMassing(String massingId) {
		JsonObject m = msg("massing.delete");
		m.addProperty("massingId", massingId);
		return ask("massing", "massings", m).thenApply(r -> {
			// the ack's versions is a count (sidecar massings.ts delete); an array is counted too
			JsonElement e = r.get("versions");
			int n = e == null ? 0 : e.isJsonArray() ? e.getAsJsonArray().size() : e.isJsonPrimitive() ? e.getAsInt() : 0;
			massingRemoved(massingId);
			return n;
		});
	}

	@Override
	public CompletableFuture<Group.Approval> approveGroup(String groupId, List<String> approve, Map<String, String> redirect, List<String> cancel,
		@Nullable String owner) {
		JsonObject m = Wire4c.approveMessage(groupId, approve == null ? List.of() : approve, redirect == null ? Map.of() : redirect, cancel == null
			? List.of() : cancel, owner);
		return ask("massing", "group approvals", m).thenApply(Wire4c::approval);
	}

	/** On every connect (protocol 2, massing): {@code massing.list {}}, the latest version of every massing, merged (no events). */
	void refreshMassings() {
		ClientBridge b = ApiImpl.bridge();
		if (unavailable4b(b, "massing", "massings") != null) {
			return;
		}
		b.send(msg("massing.list")).thenAccept(ack -> {
			if (!ack.has("ok") || !ack.get("ok").getAsBoolean() || !ack.has("result")) {
				return;
			}
			JsonElement ms = ack.getAsJsonObject("result").get("massings");
			if (ms != null && ms.isJsonArray()) {
				for (JsonElement e : ms.getAsJsonArray()) {
					if (e.isJsonObject()) {
						massingChanged(e.getAsJsonObject(), true);
					}
				}
				massings.flush();
			}
		}).exceptionally(t -> {
			Architect.LOGGER.info("massing.list failed: {}", t.getMessage());
			return null;
		});
	}

	private static @Nullable String str(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() ? e.getAsString() : null;
	}

	private static long num(JsonObject o, String k) {
		JsonElement e = o.get(k);
		return e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isNumber() ? e.getAsLong() : 0L;
	}

	// ------------------------------------------------------------------ phase 5b: polish

	@Override
	public CompletableFuture<String> polish(dev.larattalabs.architect.api.PolishRequest r) {
		JsonObject m;
		try {
			m = Wire5b.polishMessage(r);
		} catch (IllegalArgumentException e) {
			return ApiImpl.onServerFuture(CompletableFuture.failedFuture(e));
		}
		return ask("design.polish", "polishing entries", m).thenApply(res -> {
			String id = res.has("designId") ? res.get("designId").getAsString() : null;
			if (id == null) {
				throw new IllegalStateException("the helper sent no designId");
			}
			synchronized (this) {
				meta.put(id, new Meta(r.owner(), r.ext().deepCopy()));
			}
			save();
			Architect.LOGGER.info("API: polish {} of {} requested", id, r.entryId());
			return id;
		});
	}

	@Override
	public CompletableFuture<Estimate> estimatePolish(dev.larattalabs.architect.api.PolishRequest r) {
		JsonObject m = msg("design.estimate");
		m.add("polish", Wire5b.spec(r));
		m.addProperty("entryId", r.entryId());
		return ask("design.polish", "polish estimates", m).thenApply(Wire5b::estimate);
	}
}
