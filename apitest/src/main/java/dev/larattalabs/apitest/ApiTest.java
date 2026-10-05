package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.Design;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.Library;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.PlaceResult;
import dev.larattalabs.architect.api.Refusal;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.RemoveResult;
import dev.larattalabs.architect.api.Sample;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.SiteView;
import dev.larattalabs.architect.api.Verdict;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A dev-only test mod for Architect's public API (docs/CONTRACT.md "Phase 4a gate"). It uses nothing of Architect but
 * {@code dev.larattalabs.architect.api}. Driven through {@code /apitest <step> <args...>} (tools/apitest.mjs runs them over
 * the DevBridge's {@code dev.command}); every step answers with one JSON line, and async steps store their result under a
 * key that {@code /apitest get <key>} prints later. Every Architect event is recorded ({@code /apitest events}).
 */
public class ApiTest implements ModInitializer {
	public static final String OWNER = "apitest:village/1";
	static final Logger LOG = LoggerFactory.getLogger("apitest");
	/** Results of async steps, by key. */
	public static final Map<String, JsonElement> RESULTS = new ConcurrentHashMap<>();
	/** Every event seen, in order. */
	static final List<JsonObject> EVENTS = java.util.Collections.synchronizedList(new ArrayList<>());
	/** A preview request for the client side: {bp, x, y, z, turns} or {"clear"}. */
	public static final AtomicReference<String[]> PREVIEW = new AtomicReference<>();

	@Override
	public void onInitialize() {
		// registered at init, before any world: the events are static (and ArchitectApi.get() works in any init order)
		LOG.info("apitest: Architect API {}", ArchitectApi.VERSION);
		SiteEvents.SITE_PLACED.register(v -> event("SITE_PLACED", site(v)));
		SiteEvents.SITE_REMOVED.register((v, r) -> {
			JsonObject o = site(v);
			o.add("result", removeJson(r));
			event("SITE_REMOVED", o);
		});
		SiteEvents.SITE_MOVED.register((a, b) -> event("SITE_MOVED", site(b)));
		SiteEvents.PLACE_FAILED.register((r, why) -> {
			JsonObject o = new JsonObject();
			o.addProperty("blueprint", r.blueprintId());
			o.addProperty("mode", r.mode().name());
			o.addProperty("owner", r.owner());
			o.add("refusals", refusals(why));
			event("PLACE_FAILED", o);
		});
		SiteEvents.SITE_PROGRESS.register(v -> event("SITE_PROGRESS", site(v)));
		SiteEvents.SITE_BUILT.register(v -> event("SITE_BUILT", site(v)));
		SiteEvents.DESIGN_UPDATED.register(d -> event("DESIGN_UPDATED", design(d)));
		SiteEvents.DESIGN_DONE.register(d -> event("DESIGN_DONE", design(d)));
		SiteEvents.VARIANT_DONE.register(e -> event("VARIANT_DONE", entry(e)));
		SiteEvents.JOB_UPDATED.register(j -> event("JOB_UPDATED", ApiTestJobs.job(j)));
		SiteEvents.JOB_DONE.register(j -> event("JOB_DONE", ApiTestJobs.job(j)));
		ApiTestJobs.init();
		ApiTestSets.init();
		CommandRegistrationCallback.EVENT.register((d, ctx, env) -> d.register(Commands.literal("apitest")
			.then(Commands.argument("args", StringArgumentType.greedyString()).executes(ApiTest::run))));
	}

	static void event(String type, JsonObject data) {
		data.addProperty("event", type);
		data.addProperty("t", System.currentTimeMillis());
		data.addProperty("serverThread", Thread.currentThread().getName());
		EVENTS.add(data);
		LOG.info("apitest event {}", data);
	}

	private static int run(CommandContext<CommandSourceStack> ctx) {
		CommandSourceStack src = ctx.getSource();
		String[] a = StringArgumentType.getString(ctx, "args").trim().split("\\s+");
		JsonElement out;
		try {
			out = step(src, a);
		} catch (Exception e) {
			JsonObject err = new JsonObject();
			err.addProperty("error", e.toString());
			out = err;
		}
		String text = out.toString();
		LOG.info("apitest {} -> {}", String.join(" ", a), text.length() > 2000 ? text.substring(0, 2000) + "..." : text);
		src.sendSuccess(() -> Component.literal(text), false);
		return 1;
	}

	/** Stores a future's result under {@code key} (or its error) and answers {"pending": key}. */
	static JsonObject later(String key, CompletableFuture<? extends JsonElement> f) {
		RESULTS.remove(key);
		f.whenComplete((v, e) -> {
			if (e != null) {
				JsonObject err = new JsonObject();
				err.addProperty("error", (e.getCause() != null ? e.getCause() : e).toString());
				RESULTS.put(key, err);
			} else {
				RESULTS.put(key, v);
			}
			JsonObject th = new JsonObject();
			th.addProperty("completedOn", Thread.currentThread().getName());
			RESULTS.put(key + ".thread", th);
		});
		JsonObject o = new JsonObject();
		o.addProperty("pending", key);
		return o;
	}

	private static JsonElement step(CommandSourceStack src, String[] a) throws Exception {
		ArchitectApi api = ArchitectApi.get();
		var server = src.getServer();
		ServerPlayer player = src.getPlayer();
		switch (a[0]) {
			case "version": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				JsonArray f = new JsonArray();
				api.features().stream().sorted().forEach(f::add);
				o.add("features", f);
				o.addProperty("jobsAvailable", api.jobs().available());
				return o;
			}
			case "jobs": {
				// a minimal structured job: refused by a protocol-1 helper, run by a protocol-2 one
				return later("jobs", api.jobs().run(ApiTestJobs.spec("structured", List.of())).thenApply(id -> new com.google.gson.JsonPrimitive(id)));
			}
			case "jobrun":
			case "job":
			case "joblist":
			case "jobcancel":
			case "blobput":
			case "release":
			case "toolstats":
			case "ticks": {
				return ApiTestJobs.step(src, a);
			}
			case "bible":
			case "biblerevise":
			case "bibleestimate":
			case "biblejob":
			case "bibleget":
			case "bibles":
			case "estimate":
			case "estimate1":
			case "group":
			case "groupget":
			case "groups":
			case "groupcancel":
			case "groupextend":
			case "groupresume":
			case "opentype":
			case "reskin":
			case "reskinvariant":
			case "survival": {
				return ApiTestSets.step(src, a);
			}
			case "place":
			case "check": {
				// place <bp> <x> <y> <z> <AUTO|INSTANT|CONSTRUCTION> <owned|unowned> <actor|noactor> [rotation 0-3]
				PlaceRequest r = request(src, a, player);
				if (a[0].equals("check")) {
					return verdict(api.sites(server).check(r));
				}
				String key = "place:" + a[2] + "," + a[3] + "," + a[4] + ":" + a[5] + ":" + a[7];
				return later(key, api.sites(server).place(r).thenApply(ApiTest::placeJson));
			}
			case "remove": {
				// remove <site> <requester|-> <force|noforce>
				String requester = a[2].equals("-") ? null : a[2];
				return later("remove:" + a[1] + ":" + a[2] + ":" + a[3], api.sites(server).remove(a[1], new RemoveOptions(a[3].equals("force"), requester))
					.thenApply(ApiTest::removeJson));
			}
			case "sites": {
				JsonObject o = new JsonObject();
				JsonArray all = new JsonArray();
				api.sites(server).list().forEach(v -> all.add(site(v)));
				o.add("all", all);
				JsonArray mine = new JsonArray();
				api.sites(server).list(OWNER).forEach(v -> mine.add(site(v)));
				o.add("owned", mine);
				JsonArray player0 = new JsonArray();
				api.sites(server).list(null).forEach(v -> player0.add(site(v)));
				o.add("players", player0);
				return o;
			}
			case "survey": {
				// survey <x1> <z1> <x2> <z2> <resolution> [loaded|bounded:<n>]
				int[] n = Arrays.stream(a, 1, 6).mapToInt(Integer::parseInt).toArray();
				LoadPolicy load = a.length > 6 && a[6].startsWith("bounded:") ? LoadPolicy.LOAD_BOUNDED(Integer.parseInt(a[6].substring(8)))
					: LoadPolicy.LOADED_ONLY;
				BoundingBox box = new BoundingBox(n[0], src.getLevel().getMinY(), n[1], n[2], src.getLevel().getMaxY(), n[3]);
				long t0 = System.nanoTime();
				return later("survey:" + String.join(",", Arrays.copyOfRange(a, 1, a.length)), api.survey().sample(src.getLevel(), box, n[4], load)
					.thenApply(s -> sampleJson(s, (System.nanoTime() - t0) / 1_000_000)));
			}
			case "design": {
				// design <name>: a request with owner and ext through the API (the stub sidecar "designs" by copying)
				JsonObject ext = new JsonObject();
				ext.addProperty("apitest:request", "r1");
				ext.addProperty("apitest:lot", "L2");
				DesignRequest r = new DesignRequest("cabin", "rustic", "spruce", List.of("porch"), new BlockSize(15, 12, 15), a[1], "via the API", null,
					OWNER, ext, null, null, null, null);
				return later("design:" + a[1], api.designs().request(r).thenApply(com.google.gson.JsonPrimitive::new));
			}
			case "designs": {
				JsonArray arr = new JsonArray();
				api.designs().list(a.length > 1 ? a[1] : null).forEach(d -> arr.add(design(d)));
				return arr;
			}
			case "entry": {
				return api.library().get(a[1]).map(ApiTest::entry).map(e -> (JsonElement) e).orElse(com.google.gson.JsonNull.INSTANCE);
			}
			case "entries": {
				JsonArray arr = new JsonArray();
				api.library().list().forEach(e -> arr.add(e.id()));
				return arr;
			}
			case "variant": {
				// variant <from> <palette> [name]
				return later("variant:" + a[1] + ":" + a[2], api.library().makeVariant(a[1], new com.google.gson.JsonPrimitive(a[2]), null,
					a.length > 3 ? a[3] : null).thenApply(ApiTest::entry));
			}
			case "setext": {
				// setext <id> <key> <json|null>
				api.library().setExt(a[1], a[2], a[3].equals("null") ? null : JsonParser.parseString(a[3]));
				return api.library().get(a[1]).map(ApiTest::entry).map(e -> (JsonElement) e).orElse(com.google.gson.JsonNull.INSTANCE);
			}
			case "settags": {
				api.library().setTags(a[1], Arrays.asList(Arrays.copyOfRange(a, 2, a.length)));
				JsonObject o = new JsonObject();
				o.addProperty("sent", true);
				return o;
			}
			case "delete": {
				return later("delete:" + a[1], api.library().delete(a[1]).thenApply(com.google.gson.JsonPrimitive::new));
			}
			case "preview": {
				// preview <bp> <x> <y> <z> [turns] | preview clear: handed to the client side (ApiTestClient)
				PREVIEW.set(a[1].equals("clear") ? new String[] {"clear"} : Arrays.copyOfRange(a, 1, a.length));
				return later("preview", new CompletableFuture<>());
			}
			case "get": {
				JsonElement v = RESULTS.get(a[1]);
				JsonObject o = new JsonObject();
				o.add("value", v);
				JsonElement th = RESULTS.get(a[1] + ".thread");
				o.add("thread", th);
				return o;
			}
			case "events": {
				JsonArray arr = new JsonArray();
				synchronized (EVENTS) {
					int from = a.length > 1 ? Integer.parseInt(a[1]) : 0;
					for (int i = from; i < EVENTS.size(); i++) {
						arr.add(EVENTS.get(i));
					}
				}
				return arr;
			}
			case "clear": {
				EVENTS.clear();
				RESULTS.clear();
				JsonObject o = new JsonObject();
				o.addProperty("cleared", true);
				return o;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	private static PlaceRequest request(CommandSourceStack src, String[] a, ServerPlayer player) {
		BlockPos origin = new BlockPos(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer.parseInt(a[4]));
		Mode mode = Mode.valueOf(a[5]);
		boolean owned = a[6].equals("owned");
		boolean actor = a[7].equals("actor");
		Rotation rot = a.length > 8 ? Rotation.values()[Integer.parseInt(a[8])] : Rotation.NONE;
		JsonObject ext = new JsonObject();
		if (owned) {
			ext.addProperty("apitest:lot", "L1");
			JsonObject nested = new JsonObject();
			nested.addProperty("plan", 7);
			ext.add("apitest:data", nested);
		}
		return new PlaceRequest(a[1], src.getLevel(), origin, rot, mode, owned ? OWNER : null, ext, false, actor ? player : null);
	}

	// ------------------------------------------------------------------ JSON views

	static JsonObject site(SiteView v) {
		JsonObject o = new JsonObject();
		o.addProperty("id", v.id());
		o.addProperty("blueprint", v.blueprintId());
		o.addProperty("owner", v.owner());
		o.add("ext", v.ext());
		o.addProperty("box", v.box().toString());
		o.addProperty("restoreBox", v.restoreBox().toString());
		o.addProperty("rotation", v.rotation().name());
		o.addProperty("dimension", v.dimension().identifier().toString());
		o.addProperty("state", v.state().name());
		o.addProperty("built", v.built());
		o.addProperty("queued", v.queued());
		return o;
	}

	static JsonArray refusals(List<Refusal> rs) {
		JsonArray arr = new JsonArray();
		for (Refusal r : rs) {
			JsonObject o = new JsonObject();
			o.addProperty("reason", r.reason().name());
			o.addProperty("message", r.message());
			arr.add(o);
		}
		return arr;
	}

	static JsonObject placeJson(PlaceResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("placed", r.placed());
		o.addProperty("siteId", r.siteId().orElse(null));
		o.add("refusals", refusals(r.refusals()));
		JsonArray n = new JsonArray();
		r.notes().forEach(n::add);
		o.add("notes", n);
		return o;
	}

	static JsonObject removeJson(RemoveResult r) {
		JsonObject o = new JsonObject();
		o.addProperty("removed", r.removed());
		JsonArray b = new JsonArray();
		r.blockers().forEach(b::add);
		o.add("blockers", b);
		o.add("refund", items(r.refund()));
		int total = r.refund().values().stream().mapToInt(Integer::intValue).sum();
		o.addProperty("refundTotal", total);
		return o;
	}

	static JsonObject items(Map<Item, Integer> m) {
		JsonObject o = new JsonObject();
		m.entrySet().stream().sorted(Map.Entry.comparingByKey((x, y) -> BuiltInRegistries.ITEM.getKey(x).compareTo(BuiltInRegistries.ITEM.getKey(y))))
			.forEach(e -> o.addProperty(BuiltInRegistries.ITEM.getKey(e.getKey()).toString(), e.getValue()));
		return o;
	}

	static JsonObject verdict(Verdict v) {
		JsonObject o = new JsonObject();
		o.addProperty("ok", v.ok());
		o.add("refusals", refusals(v.refusals()));
		JsonArray n = new JsonArray();
		v.notes().forEach(n::add);
		o.add("notes", n);
		o.addProperty("construction", v.construction());
		o.add("bom", items(v.bom()));
		o.addProperty("box", v.box().map(Object::toString).orElse(null));
		o.addProperty("restoreBox", v.restoreBox().map(Object::toString).orElse(null));
		return o;
	}

	static JsonObject sampleJson(Sample s, long ms) {
		JsonObject o = new JsonObject();
		o.addProperty("ms", ms);
		o.addProperty("resolution", s.resolution());
		o.addProperty("width", s.width());
		o.addProperty("depth", s.depth());
		o.addProperty("missing", s.missing().cardinality());
		o.addProperty("missingChunks", s.missingChunks().size());
		o.addProperty("chunksLoaded", s.chunksLoaded());
		o.addProperty("water", s.water().cardinality());
		o.addProperty("tree", s.tree().cardinality());
		o.addProperty("natural", s.natural().cardinality());
		JsonArray bl = new JsonArray();
		s.blocks().forEach(bl::add);
		o.add("blocks", bl);
		JsonArray bi = new JsonArray();
		s.biomes().forEach(bi::add);
		o.add("biomes", bi);
		o.addProperty("summary", s.summary());
		o.addProperty("jsonBytes", s.toJson().toString().length());
		// a few columns, as world x, z, height, top
		JsonArray cols = new JsonArray();
		for (int k = 0; k < Math.min(4, s.width()); k++) {
			if (!s.isMissing(k, 0)) {
				cols.add(s.worldX(k) + "," + s.worldZ(0) + " h" + s.height()[s.index(k, 0)] + " floor" + s.floor()[s.index(k, 0)] + " " + s.topBlock(k, 0));
			}
		}
		o.add("columns", cols);
		return o;
	}

	static JsonObject design(Design d) {
		JsonObject o = new JsonObject();
		o.addProperty("id", d.id());
		o.addProperty("status", d.status().name());
		o.addProperty("step", d.step());
		o.addProperty("entryId", d.entryId().orElse(null));
		o.addProperty("owner", d.owner().orElse(null));
		o.addProperty("error", d.error().orElse(null));
		o.add("request", d.request());
		return o;
	}

	static JsonObject entry(Library.Entry e) {
		JsonObject o = new JsonObject();
		o.addProperty("id", e.id());
		o.addProperty("name", e.name());
		o.addProperty("type", e.type());
		o.addProperty("size", e.size().x() + "x" + e.size().y() + "x" + e.size().z());
		JsonArray t = new JsonArray();
		e.tags().forEach(t::add);
		o.add("tags", t);
		o.addProperty("source", e.source().orElse(null));
		o.add("ext", e.ext());
		JsonObject ports = new JsonObject();
		e.ports().forEach((n, p) -> ports.addProperty(n, p.kind() + " " + p.offset().toShortString() + " " + p.facing().getName()));
		o.add("ports", ports);
		o.addProperty("bundled", e.bundled());
		o.addProperty("imported", e.imported());
		o.addProperty("variantOf", e.variantOf().orElse(null));
		o.addProperty("palette", e.palette().map(Object::toString).orElse(null));
		o.addProperty("bible", e.bible().map(b -> b.id() + "@" + b.version()).orElse(null));
		o.addProperty("group", e.group().orElse(null));
		o.addProperty("groupItem", e.groupItem().orElse(null));
		JsonObject parts = new JsonObject();
		e.parts().forEach((n, p) -> parts.addProperty(n, p.cells()));
		o.add("parts", parts);
		return o;
	}
}
