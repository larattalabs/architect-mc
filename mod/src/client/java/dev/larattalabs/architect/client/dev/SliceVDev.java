package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.ai.attributes.AttributeInstance;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.npc.villager.Villager;
import net.minecraft.world.level.pathfinder.Node;
import net.minecraft.world.level.pathfinder.Path;

/**
 * Phase 6c slice V DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT V §7 item 4): vanilla's own villager pathfinding as the authority
 * on the kit's villager mover. The villager is never added to the world: it is created, placed on the {@code from} cell, made
 * no-AI and on the ground (so {@code PathNavigation} may plan), its {@code FOLLOW_RANGE} raised over the claim, asked for one
 * path, and discarded.
 */
public final class SliceVDev {
	private SliceVDev() {
	}

	public static void init() {
		DevBridge.register("dev.nav.villager", 120_000, "{from: [x,y,z] (feet), to: [x,y,z] (feet), range?: 256, accuracy?: 0} - (6c V) a no-AI "
			+ "villager at from, FOLLOW_RANGE = range, vanilla PathNavigation.createPath(to, accuracy) -> {canReach, nodes, end: [x,y,z], "
			+ "path: bool, ms}; the villager is discarded", (req, mc) -> {
				int[] from = ints(req.getAsJsonArray("from"));
				int[] to = ints(req.getAsJsonArray("to"));
				int range = req.has("range") ? req.get("range").getAsInt() : 256;
				int accuracy = req.has("accuracy") ? req.get("accuracy").getAsInt() : 0;
				return ServerTasks.callAsPlayer((level, player) -> {
					long t0 = System.nanoTime();
					Villager v = EntityTypes.VILLAGER.create(level, EntitySpawnReason.COMMAND);
					JsonObject o = new JsonObject();
					if (v == null) {
						o.addProperty("error", "no villager");
						return o;
					}
					try {
						v.setNoAi(true);
						v.setPos(from[0] + 0.5, from[1], from[2] + 0.5);
						v.setOnGround(true);
						AttributeInstance fr = v.getAttribute(Attributes.FOLLOW_RANGE);
						if (fr != null) {
							fr.setBaseValue(Math.min(2048, Math.max(16, range)));
						}
						v.getNavigation().setCanOpenDoors(true);
						v.getNavigation().setMaxVisitedNodesMultiplier(Math.max(1f, range / 16f));
						Path p = v.getNavigation().createPath(new BlockPos(to[0], to[1], to[2]), accuracy);
						o.addProperty("path", p != null);
						o.addProperty("canReach", p != null && p.canReach());
						o.addProperty("nodes", p == null ? 0 : p.getNodeCount());
						Node end = p == null ? null : p.getEndNode();
						if (end != null) {
							JsonArray e = new JsonArray();
							e.add(end.x);
							e.add(end.y);
							e.add(end.z);
							o.add("end", e);
						}
						o.addProperty("followRange", fr == null ? -1 : fr.getValue());
					} finally {
						v.discard();
					}
					o.addProperty("ms", (System.nanoTime() - t0) / 1e6);
					return o;
				});
			});
	}

	private static int[] ints(JsonArray a) {
		return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
	}
}
