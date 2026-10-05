package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.CellWrite;
import dev.larattalabs.architect.api.CellsRequest;
import dev.larattalabs.architect.api.CoveredPolicy;
import dev.larattalabs.architect.api.Layer;
import dev.larattalabs.architect.api.Mode;
import dev.larattalabs.architect.api.OverlapPolicy;
import dev.larattalabs.architect.api.Policy;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.RemoveOptions;
import dev.larattalabs.architect.api.RoadRequest;
import dev.larattalabs.architect.api.Sites;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The phase 4e API checks (docs/CONTRACT.md "Phase 4e gate" 11), through dev.larattalabs.architect.api only:
 * <pre>
 * road &lt;json&gt;          placeRoad -> pending "road:&lt;tag&gt;"   {points: [[x,y,z]..], width?, surface?, slab?, lanterns?, decks?, mode?,
 *                                                         owner?, force?, actor?, tag?}
 * roadcheck &lt;json&gt;     checkRoad
 * cells &lt;json&gt;         placeCells -> pending "cells:&lt;tag&gt;"  {kind, policy?, cells?: [[x,y,z,"id"]..], fill?: {min, max, id},
 *                                                         naturalOnly?, overlap?, mode?, owner?, force?, actor?, tag?}
 * cellscheck &lt;json&gt;    checkCells
 * stack &lt;x&gt; &lt;y&gt; &lt;z&gt;     Sites.stack in the player's dimension
 * sundo2 &lt;group&gt; &lt;stage&gt; &lt;keep|cascade|refuse&gt; [force]   undoStage(RemoveOptions) -> pending "sundo2:&lt;group&gt;:&lt;stage&gt;"
 * reasons             every Reason name (the 1.5.0 ones appended)
 * api15               version, the 1.5.0 features
 * heights &lt;x1&gt; &lt;z1&gt; &lt;x2&gt; &lt;z2&gt; &lt;res&gt;   Survey.sample (loaded chunks): every column as [x, z, height, water?1:0, tree?1:0] (gate scouting)
 * </pre>
 */
final class ApiTestJournal {
	private ApiTestJournal() {
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		Sites sites = ArchitectApi.get().sites(src.getServer());
		ServerPlayer player = src.getPlayer();
		switch (a[0]) {
			case "road": {
				JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
				return ApiTest.later("road:" + (j.has("tag") ? j.get("tag").getAsString() : "last"), sites.placeRoad(road(src, j, player))
					.thenApply(ApiTest::placeJson));
			}
			case "roadcheck":
				return ApiTest.verdict(sites.checkRoad(road(src, JsonParser.parseString(a[1]).getAsJsonObject(), player)));
			case "cells": {
				JsonObject j = JsonParser.parseString(a[1]).getAsJsonObject();
				return ApiTest.later("cells:" + (j.has("tag") ? j.get("tag").getAsString() : "last"), sites.placeCells(cells(src, j, player))
					.thenApply(ApiTest::placeJson));
			}
			case "cellscheck":
				return ApiTest.verdict(sites.checkCells(cells(src, JsonParser.parseString(a[1]).getAsJsonObject(), player)));
			case "stack": {
				JsonArray out = new JsonArray();
				for (Layer l : sites.stack(src.getLevel().dimension(), new BlockPos(Integer.parseInt(a[1]), Integer.parseInt(a[2]), Integer.parseInt(a[3])))) {
					JsonObject o = new JsonObject();
					o.addProperty("site", l.siteId());
					o.addProperty("kind", l.kind());
					o.addProperty("policy", l.policy().name());
					o.addProperty("layer", l.layer());
					o.addProperty("top", l.top());
					out.add(o);
				}
				return out;
			}
			case "sundo2":
				return ApiTest.later("sundo2:" + a[1] + ":" + a[2], sites.undoStage(a[1], a[2], new RemoveOptions(a.length > 4 && a[4].equals("force"), null,
					CoveredPolicy.valueOf(a[3].toUpperCase(Locale.ROOT)))).thenApply(ApiTest::removeJson));
			case "reasons": {
				JsonArray r = new JsonArray();
				for (Reason x : Reason.values()) {
					r.add(x.name());
				}
				return r;
			}
			case "heights": {
				int[] n = java.util.Arrays.stream(a, 1, 6).mapToInt(Integer::parseInt).toArray();
				net.minecraft.world.level.levelgen.structure.BoundingBox box = new net.minecraft.world.level.levelgen.structure.BoundingBox(n[0], src.getLevel()
					.getMinY(), n[1], n[2], src.getLevel().getMaxY(), n[3]);
				return ApiTest.later("heights:" + String.join(",", java.util.Arrays.copyOfRange(a, 1, 6)), ArchitectApi.get().survey().sample(src.getLevel(), box,
					n[4], dev.larattalabs.architect.api.LoadPolicy.LOADED_ONLY).thenApply(s -> {
						JsonArray out = new JsonArray();
						for (int j = 0; j < s.depth(); j++) {
							for (int i = 0; i < s.width(); i++) {
								if (s.isMissing(i, j)) {
									continue;
								}
								int k = s.index(i, j);
								JsonArray c = new JsonArray();
								c.add(s.worldX(i));
								c.add(s.worldZ(j));
								c.add(s.height()[k]);
								c.add(s.water().get(k) ? 1 : 0);
								c.add(s.tree().get(k) ? 1 : 0);
								out.add(c);
							}
						}
						return out;
					}));
			}
			case "api15": {
				JsonObject o = new JsonObject();
				o.addProperty("version", ArchitectApi.VERSION);
				JsonArray f = new JsonArray();
				ArchitectApi.get().features().stream().sorted().forEach(f::add);
				o.add("features", f);
				JsonArray p = new JsonArray();
				for (OverlapPolicy x : OverlapPolicy.values()) {
					p.add(x.name());
				}
				o.add("overlapPolicies", p);
				JsonArray c = new JsonArray();
				for (CoveredPolicy x : CoveredPolicy.values()) {
					c.add(x.name());
				}
				o.add("coveredPolicies", c);
				return o;
			}
			default:
				throw new IllegalArgumentException("unknown step " + a[0]);
		}
	}

	static RoadRequest road(CommandSourceStack src, JsonObject j, ServerPlayer player) {
		List<BlockPos> pts = new ArrayList<>();
		for (JsonElement e : j.getAsJsonArray("points")) {
			JsonArray p = e.getAsJsonArray();
			pts.add(new BlockPos(p.get(0).getAsInt(), p.get(1).getAsInt(), p.get(2).getAsInt()));
		}
		return new RoadRequest(src.getLevel(), pts, j.has("width") ? j.get("width").getAsInt() : 3, j.has("surface") ? j.get("surface").getAsString() : null,
			j.has("slab") ? j.get("slab").getAsString() : null, j.has("lanterns") && j.get("lanterns").getAsBoolean(), j.has("decks")
				&& j.get("decks").getAsBoolean(), j.has("mode") ? Mode.valueOf(j.get("mode").getAsString()) : Mode.INSTANT, j.has("owner") ? j.get("owner")
					.getAsString() : null, j.has("ext") ? j.getAsJsonObject("ext") : new JsonObject(), j.has("actor") && j.get("actor").getAsBoolean() ? player
						: null, j.has("force") && j.get("force").getAsBoolean());
	}

	static BlockState block(String id) {
		return BuiltInRegistries.BLOCK.getValue(Identifier.parse(id)).defaultBlockState();
	}

	static CellsRequest cells(CommandSourceStack src, JsonObject j, ServerPlayer player) {
		List<CellWrite> cells = new ArrayList<>();
		if (j.has("cells")) {
			for (JsonElement e : j.getAsJsonArray("cells")) {
				JsonArray c = e.getAsJsonArray();
				cells.add(CellWrite.of(new BlockPos(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()), block(c.get(3).getAsString())));
			}
		}
		if (j.has("fill")) {
			JsonObject f = j.getAsJsonObject("fill");
			JsonArray mn = f.getAsJsonArray("min");
			JsonArray mx = f.getAsJsonArray("max");
			BlockState s = block(f.get("id").getAsString());
			for (int y = mn.get(1).getAsInt(); y <= mx.get(1).getAsInt(); y++) {
				for (int z = mn.get(2).getAsInt(); z <= mx.get(2).getAsInt(); z++) {
					for (int x = mn.get(0).getAsInt(); x <= mx.get(0).getAsInt(); x++) {
						cells.add(CellWrite.of(new BlockPos(x, y, z), s));
					}
				}
			}
		}
		return new CellsRequest(src.getLevel(), j.get("kind").getAsString(), j.has("policy") ? Policy.valueOf(j.get("policy").getAsString()) : Policy.CELL,
			cells, !j.has("naturalOnly") || j.get("naturalOnly").getAsBoolean(), j.has("overlap") ? OverlapPolicy.valueOf(j.get("overlap").getAsString())
				: null, j.has("mode") ? Mode.valueOf(j.get("mode").getAsString()) : Mode.INSTANT, j.has("owner") ? j.get("owner").getAsString() : null,
			j.has("ext") ? j.getAsJsonObject("ext") : new JsonObject(), j.has("actor") && j.get("actor").getAsBoolean() ? player : null, j.has("force")
				&& j.get("force").getAsBoolean());
	}
}
