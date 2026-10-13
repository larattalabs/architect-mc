package dev.larattalabs.apitest;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.ArchitectApi;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Build;
import dev.larattalabs.architect.api.BuildHit;
import dev.larattalabs.architect.api.BuildKind;
import dev.larattalabs.architect.api.BuildState;
import dev.larattalabs.architect.api.PlaceRequest;
import dev.larattalabs.architect.api.Reason;
import dev.larattalabs.architect.api.Refusal;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Rotation;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * The slice 6c PT steps of apitest (docs/CONTRACT.md "Phase 6c slice PT" §9, gate item 16): player-placed tracking and builds through
 * {@code dev.larattalabs.architect.api} only.
 * <pre>
 * apipt                                   the surface: version, the builds and playerPlaced features, PLAYER_BUILD appended, the enums
 * ptat &lt;x y z&gt;                            Sites.playerPlaced(dim, pos)
 * ptbox &lt;x0 y0 z0 x1 y1 z1&gt;                Sites.playerPlaced(dim, box)
 * ptbuilds [&lt;x0 y0 z0 x1 y1 z1&gt;]           Sites.builds(dim, box)
 * ptbuild &lt;id&gt;                            Sites.build(id)
 * ptclaim &lt;x0 y0 z0 x1 y1 z1&gt;              Sites.claimBuild (the player as actor)
 * ptrelease &lt;id&gt;                          Sites.releaseBuild (the player as actor)
 * ptplace &lt;design&gt; &lt;x y z&gt; &lt;key&gt;           Sites.place: refused PLAYER_BUILD over a build, with its builds -> pending "ptplace:&lt;key&gt;"
 * ptcheck &lt;design&gt; &lt;x y z&gt;                 Sites.check of a placement: its refusals with their builds (PLAYER_BUILD)
 * </pre>
 */
public final class ApiTestPT {
	private ApiTestPT() {
	}

	static BoundingBox box(String[] a, int i) {
		return new BoundingBox(Integer.parseInt(a[i]), Integer.parseInt(a[i + 1]), Integer.parseInt(a[i + 2]), Integer.parseInt(a[i + 3]), Integer.parseInt(a[i
			+ 4]), Integer.parseInt(a[i + 5]));
	}

	static JsonObject build(Build b) {
		JsonObject o = new JsonObject();
		o.addProperty("id", b.id());
		o.addProperty("kind", b.kind().name());
		o.addProperty("state", b.state().name());
		o.addProperty("cells", b.cells());
		o.addProperty("revision", b.revision());
		o.addProperty("primaryPlacer", String.valueOf(b.primaryPlacer()));
		o.addProperty("entrances", b.entrances().size());
		o.addProperty("bounds", b.bounds().toString());
		return o;
	}

	static JsonArray hits(java.util.List<BuildHit> hs) {
		JsonArray a = new JsonArray();
		for (BuildHit h : hs) {
			JsonObject o = new JsonObject();
			o.addProperty("buildId", h.buildId());
			o.addProperty("kind", h.kind().name());
			o.addProperty("blocking", h.blocking());
			o.addProperty("first", h.first().size());
			a.add(o);
		}
		return a;
	}

	static JsonElement step(CommandSourceStack src, String[] a) {
		ArchitectApi api = ArchitectApi.get();
		var level = src.getLevel();
		try {
			switch (a[0]) {
				case "apipt": {
					JsonObject o = new JsonObject();
					o.addProperty("version", ArchitectApi.VERSION);
					o.addProperty("builds", api.features().contains("builds"));
					o.addProperty("playerPlaced", api.features().contains("playerPlaced"));
					o.addProperty("playerBuildAppended", Reason.PLAYER_BUILD.ordinal() == Reason.PERMISSION.ordinal() + 1);
					o.addProperty("kinds", BuildKind.values().length);
					o.addProperty("states", BuildState.values().length);
					return o;
				}
				case "ptat": {
					var r = api.sites(src.getServer()).playerPlaced(level.dimension(), new BlockPos(Integer.parseInt(a[1]), Integer.parseInt(a[2]), Integer.parseInt(a[3])));
					JsonObject o = new JsonObject();
					o.addProperty("tracked", r.isPresent());
					r.ifPresent(p -> {
						o.addProperty("placer", p.placer().toString());
						o.addProperty("buildId", p.buildId());
					});
					return o;
				}
				case "ptbox": {
					var b = api.sites(src.getServer()).playerPlaced(level.dimension(), box(a, 1));
					JsonObject o = new JsonObject();
					o.addProperty("tracked", b.tracked());
					o.addProperty("incidental", b.incidental());
					o.addProperty("placers", b.byPlacer().size());
					o.add("builds", hits(b.builds()));
					return o;
				}
				case "ptbuilds": {
					JsonArray arr = new JsonArray();
					for (Build b : api.sites(src.getServer()).builds(level.dimension(), a.length >= 7 ? box(a, 1) : null)) {
						arr.add(build(b));
					}
					return arr;
				}
				case "ptbuild": {
					var b = api.sites(src.getServer()).build(a[1]);
					return b.isPresent() ? build(b.get()) : new JsonPrimitive("none");
				}
				case "ptclaim": {
					return build(api.sites(src.getServer()).claimBuild(level.dimension(), box(a, 1), src.getPlayer()));
				}
				case "ptrelease": {
					return build(api.sites(src.getServer()).releaseBuild(a[1], src.getPlayer()));
				}
				case "ptplace": {
					// Sites.place: refused PLAYER_BUILD over a build (its refusals and builds), else placed
					PlaceRequest req = PlaceRequest.of(a[1], level, new BlockPos(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer.parseInt(a[4])), Rotation.NONE);
					return ApiTest.later("ptplace:" + a[5], api.sites(src.getServer()).place(req).handle((r, e) -> {
						JsonObject o = new JsonObject();
						if (e != null) {
							o.addProperty("error", String.valueOf(e));
							return o;
						}
						o.addProperty("placed", r.placed());
						JsonArray rs = new JsonArray();
						for (Refusal x : r.refusals()) {
							JsonObject j = new JsonObject();
							j.addProperty("reason", x.reason().name());
							j.addProperty("message", x.message());
							j.add("builds", hits(x.builds()));
							rs.add(j);
						}
						o.add("refusals", rs);
						return o;
					}));
				}
				case "ptcheck": {
					var v = api.sites(src.getServer()).check(PlaceRequest.of(a[1], level, new BlockPos(Integer.parseInt(a[2]), Integer.parseInt(a[3]), Integer.parseInt(a[4])),
						Rotation.NONE));
					JsonObject o = new JsonObject();
					JsonArray rs = new JsonArray();
					for (Refusal r : v.refusals()) {
						JsonObject x = new JsonObject();
						x.addProperty("reason", r.reason().name());
						x.addProperty("message", r.message());
						x.add("builds", hits(r.builds()));
						rs.add(x);
					}
					o.add("refusals", rs);
					return o;
				}
				default:
					return new JsonPrimitive("unknown step " + a[0]);
			}
		} catch (ArchitectRefused e) {
			JsonObject o = new JsonObject();
			o.addProperty("refused", e.reason().name());
			o.addProperty("message", e.getMessage());
			o.add("builds", hits(e.builds()));
			return o;
		}
	}
}
