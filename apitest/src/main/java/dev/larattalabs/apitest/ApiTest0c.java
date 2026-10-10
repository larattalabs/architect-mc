package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.Extension;
import dev.larattalabs.architect.api.FitOptions;
import dev.larattalabs.architect.api.LoadPolicy;
import dev.larattalabs.architect.api.LotSize;
import dev.larattalabs.architect.api.ProtectedArea;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RoadSpan;
import dev.larattalabs.architect.api.Sample;
import dev.larattalabs.architect.api.Sites;
import dev.larattalabs.architect.api.Volume;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.Direction;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import net.minecraft.world.phys.AABB;

/**
 * The 6c slice 0c API checks (docs/CONTRACT.md "Phase 6c slice 0c", API 1.12.0), through dev.larattalabs.architect.api only:
 * <pre>
 * api112                         version, the appended reasons, the features
 * protect &lt;json&gt;                 Sites.protect {owner, id, x0, z0, x1, z1, label?} (the player's dimension)
 * unprotect &lt;owner&gt; &lt;id&gt;         Sites.unprotect
 * areas [owner|-]                Sites.protectedAreas
 * minlot &lt;bp&gt; [setback=N] [into] [lot=minX,minY,minZ,maxX,maxY,maxZ] [side=north|..]   Sites.minLotSize (+ LotSize.at)
 * ground &lt;x1&gt; &lt;z1&gt; &lt;x2&gt; &lt;z2&gt; &lt;y0&gt; &lt;y1&gt;   Survey.sample (resolution 1) and Survey.volume over the box: ground vs height on
 *                                trunk columns, the rest, and Sample.ground vs Volume.ground per column -> pending "ground:&lt;args&gt;"
 * extend &lt;group&gt; &lt;budget&gt;        Designs.extend -> pending "extend:&lt;group&gt;"
 * tagged &lt;x&gt; &lt;y&gt; &lt;z&gt; &lt;radius&gt;   the entities near a point: type, uuid, alive, tags, name
 * </pre>
 */
final class ApiTest0c {
	private ApiTest0c() {
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		Sites sites = api.sites(src.getServer());
		switch (a[0]) {
			case "api112": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				Reason[] r = Reason.values();
				o.addProperty("last2", r[r.length - 2].name() + "," + r[r.length - 1].name());
				JsonArray f = new JsonArray();
				api.features().stream().sorted().forEach(f::add);
				o.add("features", f);
				return o;
			}
			case "protect": {
				JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
				ProtectedArea p = sites.protect(new ProtectedArea(j.get("owner").getAsString(), j.get("id").getAsString(), src.getLevel().dimension(), j.get(
					"x0").getAsInt(), j.get("z0").getAsInt(), j.get("x1").getAsInt(), j.get("z1").getAsInt(), j.has("label") ? j.get("label").getAsString() : ""));
				return area(p);
			}
			case "unprotect": {
				JsonObject o = new JsonObject();
				o.addProperty("lifted", sites.unprotect(a[1], a[2]));
				return o;
			}
			case "areas": {
				JsonArray out = new JsonArray();
				sites.protectedAreas(a.length > 1 && !a[1].equals("-") ? a[1] : null).forEach(p -> out.add(area(p)));
				return out;
			}
			case "minlot": {
				FitOptions o = FitOptions.DEFAULT.withLevel(src.getLevel());
				BoundingBox lot = null;
				Direction side = Direction.NORTH;
				for (int i = 2; i < a.length; i++) {
					if (a[i].equals("into")) {
						o = o.withApproachIntoStreet(true);
					} else if (a[i].startsWith("setback=")) {
						o = o.withSetback(Integer.parseInt(a[i].substring(8)));
					} else if (a[i].startsWith("lot=")) {
						String[] c = a[i].substring(4).split(",");
						lot = new BoundingBox(Integer.parseInt(c[0]), Integer.parseInt(c[1]), Integer.parseInt(c[2]), Integer.parseInt(c[3]), Integer.parseInt(c[4]),
							Integer.parseInt(c[5]));
					} else if (a[i].startsWith("side=")) {
						side = Direction.byName(a[i].substring(5));
					}
				}
				LotSize s = sites.minLotSize(a[1], o);
				JsonObject out = new JsonObject();
				out.addProperty("alongStreet", s.alongStreet());
				out.addProperty("deep", s.deep());
				out.addProperty("setback", s.setback());
				out.addProperty("frontMargin", s.frontMargin());
				if (lot != null) {
					out.add("at", ApiTestBatch.box(s.at(lot, side)));
				}
				return out;
			}
			case "ground": {
				int[] n = java.util.Arrays.stream(a, 1, 7).mapToInt(Integer::parseInt).toArray();
				BoundingBox area = new BoundingBox(n[0], src.getLevel().getMinY(), n[1], n[2], src.getLevel().getMaxY(), n[3]);
				BoundingBox vbox = new BoundingBox(n[0], n[4], n[1], n[2], n[5], n[3]);
				CompletableFuture<Sample> sf = api.survey().sample(src.getLevel(), area, 1, LoadPolicy.LOADED_ONLY);
				CompletableFuture<JsonElement> f = sf.thenCompose(s -> api.survey().volume(src.getLevel(), vbox, LoadPolicy.LOADED_ONLY).thenApply(v -> ground(s,
					v)));
				return ApiTest.later("ground:" + String.join(",", java.util.Arrays.copyOfRange(a, 1, 7)), f);
			}
			case "extend":
				return ApiTest.later("extend:" + a[1], api.designs().extend(a[1], Double.parseDouble(a[2])).thenApply(ApiTest0c::extension));
			case "tagged": {
				double x = Double.parseDouble(a[1]);
				double y = Double.parseDouble(a[2]);
				double z = Double.parseDouble(a[3]);
				double r = Double.parseDouble(a[4]);
				JsonArray out = new JsonArray();
				for (Entity e : src.getLevel().getEntities((Entity) null, new AABB(x - r, y - r, z - r, x + r, y + r, z + r), e -> true)) {
					JsonObject o = new JsonObject();
					o.addProperty("type", net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
					o.addProperty("uuid", e.getStringUUID());
					o.addProperty("alive", e.isAlive());
					o.addProperty("removed", e.isRemoved());
					JsonArray t = new JsonArray();
					e.entityTags().stream().sorted().forEach(t::add);
					o.add("tags", t);
					o.addProperty("pos", e.blockPosition().toShortString());
					out.add(o);
				}
				return out;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	static JsonObject area(ProtectedArea p) {
		JsonObject o = new JsonObject();
		o.addProperty("owner", p.owner());
		o.addProperty("id", p.id());
		o.addProperty("dimension", p.dimension().identifier().toString());
		o.addProperty("x0", p.x0());
		o.addProperty("z0", p.z0());
		o.addProperty("x1", p.x1());
		o.addProperty("z1", p.z1());
		o.addProperty("label", p.label());
		return o;
	}

	static JsonArray spans(List<RoadSpan> spans) {
		JsonArray out = new JsonArray();
		for (RoadSpan s : spans) {
			JsonObject o = new JsonObject();
			o.addProperty("from", s.fromPoint());
			o.addProperty("to", s.toPoint());
			o.addProperty("reason", s.reason().name());
			o.addProperty("message", s.message());
			o.addProperty("at", s.at().toShortString());
			out.add(o);
		}
		return out;
	}

	static JsonObject extension(Extension e) {
		JsonObject o = new JsonObject();
		o.addProperty("group", e.group() == null ? null : e.group().id());
		o.addProperty("spentUsd", e.spentUsd());
		o.addProperty("softLineUsd", e.softLineUsd());
		o.addProperty("pausesAgain", e.pausesAgain());
		o.addProperty("minBudgetUsd", e.minBudgetUsd());
		return o;
	}

	/** §4's in-game bar: on trunk columns ground < height, elsewhere ground == height, and Sample.ground == Volume.ground per column. */
	static JsonObject ground(Sample s, Volume v) {
		int columns = 0;
		int trunk = 0;
		int trunkBelow = 0;
		int other = 0;
		int otherEqual = 0;
		int leafy = 0;
		int compared = 0;
		int same = 0;
		JsonArray firstDiff = new JsonArray();
		JsonArray firstOther = new JsonArray();
		for (int j = 0; j < s.depth(); j++) {
			for (int i = 0; i < s.width(); i++) {
				if (s.isMissing(i, j)) {
					continue;
				}
				int k = s.index(i, j);
				columns++;
				String top = s.topBlock(i, j);
				boolean isTrunk = top != null && (top.endsWith("_log") || top.endsWith("_wood") || top.endsWith("_stem") || top.endsWith("_hyphae"));
				int h = s.height()[k];
				int g = s.ground()[k];
				if (isTrunk) {
					trunk++;
					trunkBelow += g < h ? 1 : 0;
				} else if (!s.water().get(k)) {
					other++;
					if (g == h) {
						otherEqual++;
					} else if (firstOther.size() < 8) {
						firstOther.add(s.worldX(i) + "," + s.worldZ(j) + " h" + h + " g" + g + " " + top);
					}
					leafy += s.tree().get(k) ? 1 : 0;
				}
				int vg = v.groundAt(s.worldX(i), s.worldZ(j));
				compared++;
				if (vg == g) {
					same++;
				} else if (firstDiff.size() < 8) {
					firstDiff.add(s.worldX(i) + "," + s.worldZ(j) + " sample " + g + " volume " + vg);
				}
			}
		}
		JsonObject o = new JsonObject();
		o.addProperty("columns", columns);
		o.addProperty("trunkColumns", trunk);
		o.addProperty("trunkGroundBelowHeight", trunkBelow);
		o.addProperty("dryOtherColumns", other);
		o.addProperty("dryOtherGroundEqualsHeight", otherEqual);
		o.addProperty("leafyOther", leafy);
		o.add("firstOtherDiff", firstOther);
		o.addProperty("compared", compared);
		o.addProperty("sampleEqualsVolume", same);
		o.add("firstDiff", firstDiff);
		o.addProperty("volumeSha", v.sha());
		o.addProperty("volumeGround", v.ground().length);
		o.addProperty("treeCells", v.stats().treeCells());
		return o;
	}
}
