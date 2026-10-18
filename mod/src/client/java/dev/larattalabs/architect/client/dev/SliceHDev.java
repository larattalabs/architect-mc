package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.DamageLog;
import dev.larattalabs.architect.region.RegionFluids;
import dev.larattalabs.architect.region.RegionsImpl;
import java.util.concurrent.CompletableFuture;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.material.Fluids;

/**
 * Phase 6c slice H DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT H §12, §14): a box's fluid census, a forced fluid tick, the damage log,
 * a region's fluids record, and the containment check's bypass (gate item 2's negative control). Server work only (the headless server
 * generates them too).
 */
public final class SliceHDev {
	private SliceHDev() {
	}

	public static void init() {
		DevBridge.register("dev.fluid.census", 120_000, "{box: [x0,y0,z0,x1,y1,z1]} - (6c H) every fluid (or ice) cell of the box with its state, and every "
			+ "scheduled fluid tick there -> {fluids: [[x,y,z,state]], ticks: [[x,y,z]]}", (req, mc) -> {
				JsonArray b = req.getAsJsonArray("box");
				int[] v = new int[6];
				for (int i = 0; i < 6; i++) {
					v[i] = b.get(i).getAsInt();
				}
				return ServerTasks.callAsPlayer((level, player) -> RegionFluids.censusOf(level, v[0], v[1], v[2], v[3], v[4], v[5]));
			});
		DevBridge.register("dev.fluid.tick", 30_000, "{cells: [[x,y,z]], fluid?: water|lava, delay?: 1} - (6c H) schedule one fluid tick at each cell -> "
			+ "{scheduled}", (req, mc) -> {
				JsonArray cells = req.getAsJsonArray("cells");
				boolean lava = req.has("fluid") && "lava".equals(req.get("fluid").getAsString());
				int delay = req.has("delay") ? req.get("delay").getAsInt() : 1;
				return ServerTasks.callAsPlayer((level, player) -> {
					int n = 0;
					for (var c : cells) {
						JsonArray q = c.getAsJsonArray();
						level.scheduleTick(new BlockPos(q.get(0).getAsInt(), q.get(1).getAsInt(), q.get(2).getAsInt()), lava ? Fluids.LAVA : Fluids.WATER, delay);
						n++;
					}
					JsonObject o = new JsonObject();
					o.addProperty("scheduled", n);
					return o;
				});
			});
		DevBridge.register("dev.entity.damage", 10_000, "{since: epoch ms, type?: drown|lava|in_fire|...} - (6c H) living entities' damage and deaths "
			+ "since then -> {events: [{t, ms, entity, uuid, type, amount, death, at}], damage, deaths}", (req, mc) -> {
				long since = req.has("since") ? req.get("since").getAsLong() : 0L;
				String type = req.has("type") && !req.get("type").isJsonNull() ? req.get("type").getAsString() : null;
				JsonArray ev = DamageLog.since(since, type);
				JsonObject o = new JsonObject();
				o.add("events", ev);
				int damage = 0, deaths = 0;
				for (var e : ev) {
					if (e.getAsJsonObject().get("death").getAsBoolean()) {
						deaths++;
					} else {
						damage++;
					}
				}
				o.addProperty("damage", damage);
				o.addProperty("deaths", deaths);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.fluid.state", 10_000, "{region} - (6c H) the region's fluids record: {phase, forcedAt, removal?, until?, bodies: [{id, "
			+ "state, reason, cells, spill, watch, settleTicks, settledAt, captured}]}", (req, mc) -> {
				String id = req.get("region").getAsString();
				return ServerTasks.callOnServer(s -> {
					RegionsImpl.Live l = RegionsImpl.live(id);
					if (l == null) {
						throw new DevBridge.DevException("no live region " + id);
					}
					return RegionFluids.stateJson(l);
				});
			});
		DevBridge.register("dev.fluid.bypass", 10_000, "{on: bool} - (6c H) TEST: the fluids stage's containment check is not run (every body is written: "
			+ "gate item 2's negative control) -> {on}", (req, mc) -> {
				RegionFluids.bypassCheck = req.get("on").getAsBoolean();
				JsonObject o = new JsonObject();
				o.addProperty("on", RegionFluids.bypassCheck);
				return CompletableFuture.completedFuture(o);
			});
	}
}
