package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Batch;
import dev.larattalabs.architect.api.BatchView;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.ItemEvent;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.LotFit;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.OverlapMargin;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.SiteEvents;
import dev.larattalabs.architect.api.SiteGroup;
import dev.larattalabs.architect.api.Sites;
import dev.larattalabs.architect.api.Stage;
import dev.larattalabs.architect.api.Stock;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * The phase 4d API checks (docs/CONTRACT.md "Phase 4d gate"): batches, site groups, stages, the group stock, lot fitting.
 * Steps (tools/gate4d.mjs runs them through {@code dev.command}):
 * <pre>
 * bqueue &lt;json&gt;                    queue a batch (see {@link #batch}) -> pending "bq:&lt;id|n&gt;" (the batch id or the refusal)
 * batch &lt;id&gt; | batches             BatchView(s)
 * bcancel &lt;id&gt;                     cancelBatch -> pending "bcancel:&lt;id&gt;"
 * sgroups | sgroup &lt;id&gt;             SiteGroup(s)
 * sgremove &lt;id&gt; [force] [requester] removeGroup -> pending "sgremove:&lt;id&gt;"
 * sapprove|sskip &lt;group&gt; &lt;stage&gt;    approveStage / skipStage (the refusal as {"error"})
 * sreorder &lt;group&gt; &lt;a,b,c&gt;         reorderStages
 * sundo &lt;group&gt; &lt;stage&gt; [force]     undoStage -> pending "sundo:&lt;group&gt;:&lt;stage&gt;"
 * stock &lt;group&gt;                    Stock
 * fit &lt;bp&gt; &lt;minX,minY,minZ,maxX,maxY,maxZ&gt; &lt;north|east|south|west&gt; [into] [box] [setback=N]
 * margin &lt;bp&gt;                      overlapMargin
 * </pre>
 */
final class ApiTestBatch {
	private ApiTestBatch() {
	}

	static void init() {
		SiteEvents.BATCH_PROGRESS.register(b -> ApiTest.event("BATCH_PROGRESS", batchBrief(b)));
		SiteEvents.BATCH_DONE.register(b -> ApiTest.event("BATCH_DONE", batch(b)));
		SiteEvents.ITEM_PLACED.register(e -> ApiTest.event("ITEM_PLACED", item(e)));
		SiteEvents.ITEM_FAILED.register(e -> ApiTest.event("ITEM_FAILED", item(e)));
		SiteEvents.ITEM_WAITING.register(e -> ApiTest.event("ITEM_WAITING", item(e)));
		SiteEvents.STAGE_STATE.register((g, st) -> {
			JsonObject o = stage(st);
			o.addProperty("group", g);
			ApiTest.event("STAGE_STATE", o);
		});
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		Sites sites = ArchitectApi.get().sites(src.getServer());
		ServerPlayer player = src.getPlayer();
		try {
			switch (a[0]) {
				case "bqueue": {
					JsonObject spec = JsonParser.parseString(a[1]).getAsJsonObject();
					Batch b = batch(src, spec, player);
					String key = "bq:" + (b.id() != null ? b.id() : spec.has("tag") ? spec.get("tag").getAsString() : "last");
					return ApiTest.later(key, sites.queue(b).thenApply(JsonPrimitive::new));
				}
				case "batch":
					return sites.batch(a[1]).map(ApiTestBatch::batch).map(x -> (JsonElement) x).orElse(err("no batch " + a[1]));
				case "batches": {
					JsonArray arr = new JsonArray();
					sites.batches(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(b -> arr.add(batch(b)));
					return arr;
				}
				case "bcancel":
					return ApiTest.later("bcancel:" + a[1], sites.cancelBatch(a[1]).thenApply(ApiTestBatch::batch));
				case "sgroups": {
					JsonArray arr = new JsonArray();
					sites.groups(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(g -> arr.add(group(g)));
					return arr;
				}
				case "sgroup":
					return sites.group(a[1]).map(ApiTestBatch::group).map(x -> (JsonElement) x).orElse(err("no group " + a[1]));
				case "sgremove": {
					boolean force = a.length > 2 && a[2].equals("force");
					String requester = a.length > 3 && !a[3].equals("-") ? a[3] : null;
					dev.larattalabs.architect.api.CoveredPolicy cov = a.length > 4 ? dev.larattalabs.architect.api.CoveredPolicy.valueOf(a[4].toUpperCase(
						java.util.Locale.ROOT)) : null;
					return ApiTest.later("sgremove:" + a[1], sites.removeGroup(a[1], new RemoveOptions(force, requester, cov)).thenApply(ApiTest::removeJson));
				}
				case "sapprove":
					return stage(sites.approveStage(a[1], a[2]));
				case "sskip":
					return stage(sites.skipStage(a[1], a[2]));
				case "sreorder": {
					JsonArray arr = new JsonArray();
					sites.reorderStages(a[1], List.of(a[2].split(","))).forEach(s -> arr.add(stage(s)));
					return arr;
				}
				case "sundo":
					return ApiTest.later("sundo:" + a[1] + ":" + a[2], sites.undoStage(a[1], a[2], a.length > 3 && a[3].equals("force"))
						.thenApply(ApiTest::removeJson));
				case "stock":
					return stock(sites.stock(a[1]));
				case "fit": {
					String[] c = a[2].split(",");
					BoundingBox lot = new BoundingBox(Integer.parseInt(c[0]), Integer.parseInt(c[1]), Integer.parseInt(c[2]), Integer.parseInt(c[3]),
						Integer.parseInt(c[4]), Integer.parseInt(c[5]));
					FitOptions o = FitOptions.DEFAULT.withLevel(src.getLevel());
					for (int i = 4; i < a.length; i++) {
						if (a[i].equals("into")) {
							o = o.withApproachIntoStreet(true);
						} else if (a[i].equals("box")) {
							o = o.withCentreOn(FitOptions.CentreOn.BOX);
						} else if (a[i].startsWith("setback=")) {
							o = o.withSetback(Integer.parseInt(a[i].substring(8)));
						}
					}
					return fit(sites.fitToLot(a[1], lot, Direction.byName(a[3]), o));
				}
				case "margin": {
					OverlapMargin m = sites.overlapMargin(a[1]);
					JsonObject o = new JsonObject();
					o.addProperty("front", m.front());
					o.addProperty("sides", m.sides());
					o.addProperty("back", m.back());
					return o;
				}
				default:
					return err("unknown step " + a[0]);
			}
		} catch (RuntimeException e) {
			return err(e.toString());
		}
	}

	private static JsonObject err(String msg) {
		JsonObject o = new JsonObject();
		o.addProperty("error", msg);
		return o;
	}

	/**
	 * A batch from JSON: {@code {id?, owner?, group?, ext?, items: [{key, bp, at: [x,y,z], rot?: 0-3, mode?, stage?, after?, ext?,
	 * force?, actor?: bool}], stages?: [{name, items}], autoApprove?, waitSeconds?, loadChunks?, proximity?, stopOnFailure?,
	 * sharedCrate?, crateAt?}}. {@code actor: true} = the player running the command (default: no actor).
	 */
	static Batch batch(CommandSourceStack src, JsonObject j, ServerPlayer player) {
		List<Batch.Item> items = new ArrayList<>();
		for (JsonElement e : j.getAsJsonArray("items")) {
			JsonObject it = e.getAsJsonObject();
			List<String> after0 = new ArrayList<>();
			if (it.has("after")) {
				it.getAsJsonArray("after").forEach(x -> after0.add(x.getAsString()));
			}
			String stage0 = it.has("stage") ? it.get("stage").getAsString() : null;
			if (it.has("road")) {
				items.add(Batch.Item.road(it.get("key").getAsString(), ApiTestJournal.road(src, it.getAsJsonObject("road"), player), stage0, after0));
				continue;
			}
			if (it.has("delta")) {
				// phase 5b: {site, version?, playerEdits?, overlap?, owner?, force?, actor?}
				JsonObject d = it.getAsJsonObject("delta");
				items.add(Batch.Item.delta(it.get("key").getAsString(), new dev.larattalabs.architect.api.DeltaRequest(d.get("site").getAsString(), d.has(
					"version") ? d.get("version").getAsInt() : 0, d.has("playerEdits") ? dev.larattalabs.architect.api.PlayerEdits.valueOf(d.get(
						"playerEdits").getAsString()) : null, d.has("overlap") ? dev.larattalabs.architect.api.OverlapPolicy.valueOf(d.get("overlap")
							.getAsString()) : null, d.has("actor") && d.get("actor").getAsBoolean() ? player : null, d.has("force") && d.get("force").getAsBoolean(),
					new JsonObject(), d.has("owner") ? d.get("owner").getAsString() : null), stage0, after0));
				continue;
			}
			if (it.has("cells")) {
				items.add(Batch.Item.cells(it.get("key").getAsString(), ApiTestJournal.cells(src, it.getAsJsonObject("cells"), player), stage0, after0));
				continue;
			}
			JsonArray at = it.getAsJsonArray("at");
			JsonObject ext = it.has("ext") ? it.getAsJsonObject("ext") : new JsonObject();
			PlaceRequest r = new PlaceRequest(it.get("bp").getAsString(), src.getLevel(), new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(),
				at.get(2).getAsInt()), Rotation.values()[it.has("rot") ? it.get("rot").getAsInt() : 0], it.has("mode") ? Mode.valueOf(it.get("mode")
					.getAsString()) : Mode.AUTO, null, ext, it.has("force") && it.get("force").getAsBoolean(), it.has("actor") && it.get("actor")
					.getAsBoolean() ? player : null, it.has("overlap") ? dev.larattalabs.architect.api.OverlapPolicy.valueOf(it.get("overlap").getAsString()) : null);
			List<String> after = new ArrayList<>();
			if (it.has("after")) {
				it.getAsJsonArray("after").forEach(x -> after.add(x.getAsString()));
			}
			items.add(new Batch.Item(it.get("key").getAsString(), r, it.has("stage") ? it.get("stage").getAsString() : null, after));
		}
		List<Batch.StageSpec> stages = new ArrayList<>();
		if (j.has("stages")) {
			for (JsonElement e : j.getAsJsonArray("stages")) {
				JsonObject s = e.getAsJsonObject();
				List<String> keys = new ArrayList<>();
				if (s.has("items")) {
					s.getAsJsonArray("items").forEach(x -> keys.add(x.getAsString()));
				}
				stages.add(new Batch.StageSpec(s.get("name").getAsString(), keys));
			}
		}
		BlockPos crateAt = null;
		if (j.has("crateAt")) {
			JsonArray c = j.getAsJsonArray("crateAt");
			crateAt = new BlockPos(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt());
		}
		return new Batch(j.has("id") ? j.get("id").getAsString() : null, j.has("owner") ? j.get("owner").getAsString() : null,
			j.has("ext") ? j.getAsJsonObject("ext") : new JsonObject(), j.has("group") ? j.get("group").getAsString() : null, items, stages,
			new Batch.WaitPolicy(j.has("waitSeconds") ? j.get("waitSeconds").getAsInt() : 600),
			j.has("loadChunks") && j.get("loadChunks").getAsInt() > 0 ? LoadPolicy.LOAD_BOUNDED(j.get("loadChunks").getAsInt()) : LoadPolicy.LOADED_ONLY,
			j.has("proximity") && !j.get("proximity").isJsonNull() ? j.get("proximity").getAsBoolean() : null,
			j.has("stopOnFailure") && j.get("stopOnFailure").getAsBoolean(), j.has("autoApprove") && j.get("autoApprove").getAsBoolean(),
			j.has("sharedCrate") && j.get("sharedCrate").getAsBoolean(), crateAt, j.has("overlap") ? dev.larattalabs.architect.api.OverlapPolicy.valueOf(
				j.get("overlap").getAsString()) : null);
	}

	static JsonObject batchBrief(BatchView b) {
		JsonObject o = new JsonObject();
		o.addProperty("batch", b.id());
		o.addProperty("status", b.status().name());
		for (BatchView.ItemStatus s : BatchView.ItemStatus.values()) {
			o.addProperty(s.name().toLowerCase(java.util.Locale.ROOT), b.count(s));
		}
		return o;
	}

	static JsonObject batch(BatchView b) {
		JsonObject o = batchBrief(b);
		o.addProperty("owner", b.owner());
		o.add("ext", b.ext());
		o.addProperty("group", b.group());
		JsonArray st = new JsonArray();
		b.stages().forEach(st::add);
		o.add("stages", st);
		o.addProperty("createdAt", b.createdAt());
		b.doneAt().ifPresent(t -> o.addProperty("doneAt", t));
		JsonArray items = new JsonArray();
		for (BatchView.ItemView i : b.items()) {
			JsonObject x = new JsonObject();
			x.addProperty("key", i.itemKey());
			x.addProperty("stage", i.stage());
			x.addProperty("status", i.status().name());
			x.addProperty("mode", i.mode().name());
			i.siteId().ifPresent(s -> x.addProperty("site", s));
			i.reason().ifPresent(r -> x.addProperty("reason", r.name()));
			x.addProperty("message", i.message());
			x.add("ext", i.ext());
			items.add(x);
		}
		o.add("items", items);
		return o;
	}

	static JsonObject item(ItemEvent e) {
		JsonObject o = new JsonObject();
		o.addProperty("batch", e.batchId());
		o.addProperty("key", e.itemKey());
		o.add("ext", e.ext());
		e.siteId().ifPresent(s -> o.addProperty("site", s));
		e.reason().ifPresent(r -> o.addProperty("reason", r.name()));
		o.addProperty("message", e.message());
		return o;
	}

	static JsonObject stage(Stage s) {
		JsonObject o = new JsonObject();
		o.addProperty("name", s.name());
		o.addProperty("state", s.state().name());
		o.addProperty("batchId", s.batchId());
		JsonArray items = new JsonArray();
		s.items().forEach(items::add);
		o.add("items", items);
		JsonArray sites = new JsonArray();
		s.sites().forEach(sites::add);
		o.add("sites", sites);
		return o;
	}

	static JsonObject group(SiteGroup g) {
		JsonObject o = new JsonObject();
		o.addProperty("group", g.id());
		o.addProperty("owner", g.owner());
		o.add("ext", g.ext());
		o.addProperty("state", g.state().name());
		JsonArray sites = new JsonArray();
		g.sites().forEach(sites::add);
		o.add("sites", sites);
		JsonArray st = new JsonArray();
		g.stages().forEach(s -> st.add(stage(s)));
		o.add("stages", st);
		g.crate().ifPresent(c -> o.addProperty("crate", c.getX() + "," + c.getY() + "," + c.getZ()));
		return o;
	}

	private static JsonObject counts(Map<Item, Integer> m) {
		JsonObject o = new JsonObject();
		new java.util.TreeMap<>(m.entrySet().stream().collect(java.util.stream.Collectors.toMap(e -> BuiltInRegistries.ITEM.getKey(e.getKey()).toString(),
			Map.Entry::getValue))).forEach(o::addProperty);
		return o;
	}

	static JsonObject stock(Stock s) {
		JsonObject o = new JsonObject();
		o.addProperty("group", s.groupId());
		o.add("delivered", counts(s.delivered()));
		o.add("credit", counts(s.credit()));
		JsonObject by = new JsonObject();
		s.outstandingBySite().forEach((k, v) -> by.add(k, counts(v)));
		o.add("outstandingBySite", by);
		o.add("outstanding", counts(s.outstanding()));
		s.crate().ifPresent(c -> o.addProperty("crate", c.getX() + "," + c.getY() + "," + c.getZ()));
		return o;
	}

	static JsonObject fit(LotFit f) {
		JsonObject o = new JsonObject();
		o.addProperty("origin", f.origin().getX() + "," + f.origin().getY() + "," + f.origin().getZ());
		JsonArray at = new JsonArray();
		at.add(f.origin().getX());
		at.add(f.origin().getY());
		at.add(f.origin().getZ());
		o.add("at", at);
		o.addProperty("rotation", f.rotation().name());
		o.addProperty("rot", f.rotation().ordinal());
		o.add("box", box(f.box()));
		f.predictedRestoreBox().ifPresent(b -> o.add("predictedRestoreBox", box(b)));
		o.addProperty("ok", f.ok());
		o.add("refusals", ApiTest.refusals(f.verdict().refusals()));
		return o;
	}

	static JsonArray box(BoundingBox b) {
		JsonArray a = new JsonArray();
		a.add(b.minX());
		a.add(b.minY());
		a.add(b.minZ());
		a.add(b.maxX());
		a.add(b.maxY());
		a.add(b.maxZ());
		return a;
	}
}
