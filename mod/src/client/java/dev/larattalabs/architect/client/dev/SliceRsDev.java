package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.RegionSurvival;
import dev.larattalabs.architect.region.RegionsImpl;
import dev.larattalabs.architect.site.RegionFreeDrops;
import dev.larattalabs.architect.site.RegionTargets;
import net.minecraft.core.BlockPos;

/**
 * Phase 6c slice RS DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT RS §13): a survival region's build (RegionView.build), its targets and
 * their runs, the free-drop rule at a cell, a player's break at a cell, the crash rescan's counts. Server work only (the headless server
 * generates them too: devserver genHooks).
 */
public final class SliceRsDev {
	private SliceRsDev() {
	}

	public static void init() {
		DevBridge.register("dev.rs.state", 60_000, "{region} - (6c RS) a survival region's build (built, done, percent, outstanding, parts with their "
			+ "targets), its record's survival member, every target's runs (cells, built, held, runs, maxRunStacks, capStacks, currentRun, reserving), "
			+ "the world's mode, the free-drop and rescan counters", (req, mc) -> {
				String region = req.get("region").getAsString();
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					o.addProperty("survivalWorld", RegionSurvival.on(s));
					o.addProperty("freeBroken", RegionFreeDrops.BROKEN.get());
					o.addProperty("rescanned", RegionTargets.RESCANNED.get());
					o.addProperty("rewritten", RegionTargets.REWRITTEN.get());
					var l = RegionsImpl.live(region);
					if (l == null) {
						o.addProperty("missing", true);
						return o;
					}
					o.addProperty("state", l.rec().state.name());
					o.addProperty("survival", l.rec().survival());
					if (l.rec().survival != null) {
						o.add("record", l.rec().survival.deepCopy());
					}
					JsonObject b = RegionTargets.buildJson(l);
					if (b != null) {
						o.add("build", b);
					}
					JsonArray ts = new JsonArray();
					for (var c : RegionTargets.counts(s, l.rec().groupId)) {
						JsonObject t = RegionTargets.runsJson(s, c.id());
						if (t != null) {
							t.addProperty("part", c.part());
							t.addProperty("done", c.done());
							JsonObject out = new JsonObject();
							c.outstanding().forEach(out::addProperty);
							t.add("outstanding", out);
							ts.add(t);
						}
					}
					o.add("targets", ts);
					return o;
				});
			});
		DevBridge.register("dev.rs.target", 30_000, "{target} - (6c RS) one target's runs (as dev.rs.state's targets[])", (req, mc) -> {
			String id = req.get("target").getAsString();
			return ServerTasks.callOnServer(s -> {
				JsonObject t = RegionTargets.runsJson(s, id);
				return t == null ? new JsonObject() : t;
			});
		});
		DevBridge.register("dev.rs.cells", 120_000, "{region} - (6c RS) every target's queued cells [x, y, z, flags] (1 held, 2 built, 4 a cut), read now",
			(req, mc) -> {
				String region = req.get("region").getAsString();
				return ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					var l = RegionsImpl.live(region);
					JsonArray ts = new JsonArray();
					if (l != null) {
						for (var c : RegionTargets.counts(s, l.rec().groupId)) {
							JsonObject t = RegionTargets.cellsJson(s, c.id());
							if (t != null) {
								ts.add(t);
							}
						}
					}
					o.add("targets", ts);
					return o;
				});
			});
		DevBridge.register("dev.rs.freeWrite", 30_000, "{at: [x,y,z] | cells: [[x,y,z]]} - (6c RS, N-RS-2) whether each cell is a survival region's "
			+ "free write still standing (a break there drops nothing)", (req, mc) -> {
				JsonArray cells = req.has("cells") ? req.getAsJsonArray("cells") : new JsonArray();
				if (req.has("at")) {
					cells.add(req.getAsJsonArray("at"));
				}
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonArray out = new JsonArray();
					for (var c : cells) {
						JsonArray a = c.getAsJsonArray();
						out.add(RegionFreeDrops.freeWrite(level, new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt())));
					}
					JsonObject o = new JsonObject();
					o.add("free", out);
					return o;
				});
			});
		DevBridge.register("dev.rs.break", 60_000, "{at: [x,y,z]} - (6c RS, N-RS-2) the player breaks the cell as in survival (its game mode's own "
			+ "destroyBlock: the break events fire, drops as vanilla or none) -> {broken, before, after, freeBroken}", (req, mc) -> {
				JsonArray a = req.getAsJsonArray("at");
				BlockPos p = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					o.addProperty("before", level.getBlockState(p).toString());
					o.addProperty("gameMode", player.gameMode.getGameModeForPlayer().getName());
					o.addProperty("broken", player.gameMode.destroyBlock(p));
					o.addProperty("after", level.getBlockState(p).toString());
					o.addProperty("freeBroken", RegionFreeDrops.BROKEN.get());
					return o;
				});
			});
	}
}
