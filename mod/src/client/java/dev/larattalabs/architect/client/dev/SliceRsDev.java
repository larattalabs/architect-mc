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
		DevBridge.register("dev.gm.state", 30_000, "{region?, lot?} - (7a GM-a2) gate mechanisms: gateByHead (restores that found a gate mechanism by "
			+ "its journal head, with no record); with region and lot, its survival record, site, cells and what stands of it (built, uncapped)", (req,
				mc) -> ServerTasks.callOnServer(s -> {
					JsonObject o = new JsonObject();
					o.addProperty("gateByHead", dev.larattalabs.architect.site.SiteJournal.GATE_BY_HEAD.get());
					if (req.get("region") != null && req.get("lot") != null) {
						JsonObject v = dev.larattalabs.architect.site.MechCharges.view(s, req.get("region").getAsString(), req.get("lot").getAsString());
						if (v != null) {
							o.add("mechanism", v);
						}
					}
					return o;
				}));
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
		DevBridge.register("dev.region.terrain", 120_000, "{region, check?: bool} - (8a ST) a survival region's staged terrain targets: per target its "
			+ "part, tile, cells, built, cursor (first unbuilt queue index), connected (TO's count at put-down), runs, scanAt, stall, released (with "
			+ "check: unsupported, the standing staged cells the world no longer supports); the effective terrainPerTick, gameTime, totals; waits: "
			+ "the region's items with architect_mc:waitsFor", (req, mc) -> {
				String region = req.get("region").getAsString();
				return ServerTasks.callOnServer(s -> {
					var l = RegionsImpl.live(region);
					if (l == null) {
						JsonObject o = new JsonObject();
						o.addProperty("missing", true);
						return o;
					}
					return RegionTargets.terrainJson(s, l.rec().groupId, l.rec().batchId, req.has("check") && req.get("check").getAsBoolean());
				});
			});
		DevBridge.register("dev.terrain.rate", 30_000, "{n?, hold?: bool} - (8a ST) the world's staged terrain rate (terrainPerTick, cells per tick per "
			+ "region, 1-64, default 16): set to n (clamped, saved in architect-world.json); (8a HB, TEST, this JVM only) hold: every staged terrain "
			+ "target writes nothing while true -> {terrainPerTick, hold}", (req, mc) -> ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				if (req.has("hold")) {
					dev.larattalabs.architect.site.RegionTargets.terrainHold = req.get("hold").getAsBoolean();
				}
				o.addProperty("hold", dev.larattalabs.architect.site.RegionTargets.terrainHold);
				int v = req.has("n") ? dev.larattalabs.architect.survival.SurvivalWorld.setTerrainPerTick(s, req.get("n").getAsInt())
					: dev.larattalabs.architect.survival.SurvivalWorld.terrainPerTick();
				o.addProperty("terrainPerTick", v);
				return o;
			}));
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
		DevBridge.register("dev.rs.overwrites", 120_000, "{region} - (XR) every paid queue cell of a survival region's writer (target, construction "
			+ "road, lot) that a later writer's journal entry changed: victim, writer, kinds, found, planned, queued, now; counts per kind pair",
			(req, mc) -> {
				String region = req.get("region").getAsString();
				return ServerTasks.callOnServer(s -> {
					var l = RegionsImpl.live(region);
					if (l == null) {
						JsonObject o = new JsonObject();
						o.addProperty("missing", true);
						return o;
					}
					return dev.larattalabs.architect.site.RegionOverwrites.json(s, l.rec().groupId, l.level(s));
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
		DevBridge.register("dev.rs.freeDrops", 30_000, "{off?: bool} - (J1, RS-c, TEST) the piston and explosion free-drop hooks off (the case "
			+ "before the fix) or on -> {off, broken, pistonHeld, pistonBroken, exploded}", (req, mc) -> ServerTasks.callOnServer(s -> {
				if (req.has("off")) {
					RegionFreeDrops.testNoPistonExplosion = req.get("off").getAsBoolean();
				}
				JsonObject o = new JsonObject();
				o.addProperty("off", RegionFreeDrops.testNoPistonExplosion);
				o.addProperty("broken", RegionFreeDrops.BROKEN.get());
				o.addProperty("pistonHeld", RegionFreeDrops.PISTON_HELD.get());
				o.addProperty("pistonBroken", RegionFreeDrops.PISTON_BROKEN.get());
				o.addProperty("exploded", RegionFreeDrops.EXPLODED.get());
				return o;
			}));
		DevBridge.register("dev.rs.explode", 60_000, "{at: [x,y,z], power?: 2} - (J1, RS-c) a TNT-class explosion at the cell's centre (no source "
			+ "entity), as a primed TNT's -> {cells: [[x,y,z,free,before]] for every cell within power+1 that held a block, destroyed: [[x,y,z,free]], "
			+ "exploded}", (req, mc) -> {
				JsonArray a = req.getAsJsonArray("at");
				BlockPos p = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				float power = req.has("power") ? req.get("power").getAsFloat() : 2f;
				return ServerTasks.callAsPlayer((level, player) -> {
					int r = (int) Math.ceil(power) + 1;
					java.util.List<BlockPos> cells = new java.util.ArrayList<>();
					java.util.List<Boolean> free = new java.util.ArrayList<>();
					JsonArray before = new JsonArray();
					for (BlockPos q : BlockPos.betweenClosed(p.offset(-r, -r, -r), p.offset(r, r, r))) {
						if (level.getBlockState(q).isAir()) {
							continue;
						}
						BlockPos k = q.immutable();
						boolean f = RegionFreeDrops.freeWrite(level, k);
						cells.add(k);
						free.add(f);
						JsonArray c = new JsonArray();
						c.add(k.getX());
						c.add(k.getY());
						c.add(k.getZ());
						c.add(f);
						c.add(level.getBlockState(k).toString());
						before.add(c);
					}
					long ex0 = RegionFreeDrops.EXPLODED.get();
					level.explode(null, p.getX() + 0.5, p.getY() + 0.5, p.getZ() + 0.5, power, net.minecraft.world.level.Level.ExplosionInteraction.TNT);
					JsonArray destroyed = new JsonArray();
					for (int i = 0; i < cells.size(); i++) {
						if (level.getBlockState(cells.get(i)).isAir()) {
							JsonArray c = new JsonArray();
							c.add(cells.get(i).getX());
							c.add(cells.get(i).getY());
							c.add(cells.get(i).getZ());
							c.add(free.get(i));
							destroyed.add(c);
						}
					}
					JsonObject o = new JsonObject();
					o.add("cells", before);
					o.add("destroyed", destroyed);
					o.addProperty("exploded", RegionFreeDrops.EXPLODED.get() - ex0);
					return o;
				});
			});
		DevBridge.register("dev.rs.surface", 60_000, "{columns: [[x,z]], minY, maxY} - (J1, RS-c) per column, the topmost cell from maxY down that "
			+ "is a survival region's free write with air above it -> {cells: [[x,y,z,state] | null]}", (req, mc) -> {
				JsonArray cols = req.getAsJsonArray("columns");
				int minY = req.get("minY").getAsInt(), maxY = req.get("maxY").getAsInt();
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonArray out = new JsonArray();
					for (var c : cols) {
						JsonArray a = c.getAsJsonArray();
						int x = a.get(0).getAsInt(), z = a.get(1).getAsInt();
						JsonArray hit = null;
						for (int y = maxY; y >= minY && hit == null; y--) {
							BlockPos q = new BlockPos(x, y, z);
							if (!level.getBlockState(q).isAir() && level.getBlockState(q.above()).isAir() && level.getBlockState(q.above(2)).isAir()) {
								if (RegionFreeDrops.freeWrite(level, q)) {
									hit = new JsonArray();
									hit.add(x);
									hit.add(y);
									hit.add(z);
									hit.add(level.getBlockState(q).toString());
								}
								break; // the column's surface: free or not, no lower cell has air above it
							}
						}
						out.add(hit);
					}
					JsonObject o = new JsonObject();
					o.add("cells", out);
					return o;
				});
			});
		DevBridge.register("dev.rs.piston", 30_000, "{at: [x,y,z], phase: push|read} - (J1, RS-c) push: a piston below the cell facing up, then a "
			+ "redstone block beside the piston (vanilla updates, not journalled); read: the cell, the cell above and the piston -> {at, above, "
			+ "piston, extended, pistonHeld}", (req, mc) -> {
				JsonArray a = req.getAsJsonArray("at");
				BlockPos p = new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
				String phase = req.has("phase") ? req.get("phase").getAsString() : "read";
				return ServerTasks.callAsPlayer((level, player) -> {
					BlockPos pb = p.below();
					if ("push".equals(phase)) {
						level.setBlock(pb, net.minecraft.world.level.block.Blocks.PISTON.defaultBlockState().setValue(
							net.minecraft.world.level.block.piston.PistonBaseBlock.FACING, net.minecraft.core.Direction.UP), 3);
						level.setBlock(pb.east(), net.minecraft.world.level.block.Blocks.REDSTONE_BLOCK.defaultBlockState(), 3);
					}
					net.minecraft.world.level.block.state.BlockState ps = level.getBlockState(pb);
					JsonObject o = new JsonObject();
					o.addProperty("at", level.getBlockState(p).toString());
					o.addProperty("above", level.getBlockState(p.above()).toString());
					o.addProperty("piston", ps.toString());
					o.addProperty("extended", ps.hasProperty(net.minecraft.world.level.block.piston.PistonBaseBlock.EXTENDED) && ps.getValue(
						net.minecraft.world.level.block.piston.PistonBaseBlock.EXTENDED));
					o.addProperty("pistonHeld", RegionFreeDrops.PISTON_HELD.get());
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
