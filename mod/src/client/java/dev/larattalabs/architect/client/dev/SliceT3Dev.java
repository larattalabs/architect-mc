package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import java.util.List;
import net.minecraft.world.entity.MoverType;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Phase 6c slice T3a DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT T3 §10 item 1, N-T3-2): the boat-clearance probe. Vanilla's own
 * collision is the authority: a boat that has settled on the water (summoned by a command, the world ticking it while it is empty)
 * takes the player as its passenger and is moved along the water by {@code Entity.move(MoverType.SELF, ...)} in small steps, so the
 * boat's own box meets the blocks as it does when a player rows it; after each step the rider is positioned, and the probe records
 * whether the boat stopped against a block, whether the rider's eyes were in a block ({@code isInWall}, vanilla's suffocation
 * check) and whether the rider's box met a block. The rider is dismounted and the boat discarded at the end.
 */
public final class SliceT3Dev {
	private SliceT3Dev() {
	}

	public static void init() {
		DevBridge.register("dev.t3.boat", 120_000, "{at: [x,y,z] (the settled boat, within 4), dir: [dx,dz], distance: blocks, step?: 0.1} - (6c T3a) the "
			+ "player rides the boat nearest at, which moves `distance` along dir by Entity.move in `step` steps -> {moved, blocked, blockedAt, "
			+ "inWall, riderHit, boatY, eyeY, maxEyeY, steps, end: [x,y,z]}; the boat is discarded", (req, mc) -> {
				JsonArray at = req.getAsJsonArray("at");
				JsonArray dir = req.getAsJsonArray("dir");
				double ax = at.get(0).getAsDouble(), ay = at.get(1).getAsDouble(), az = at.get(2).getAsDouble();
				double dx = dir.get(0).getAsDouble(), dz = dir.get(1).getAsDouble();
				double distance = req.get("distance").getAsDouble();
				double step = req.has("step") ? req.get("step").getAsDouble() : 0.1;
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					List<AbstractBoat> boats = level.getEntitiesOfClass(AbstractBoat.class, new AABB(ax - 4, ay - 4, az - 4, ax + 4, ay + 4, az + 4));
					if (boats.isEmpty()) {
						o.addProperty("error", "no boat near " + ax + "," + ay + "," + az);
						return o;
					}
					AbstractBoat boat = boats.get(0);
					for (AbstractBoat b : boats) if (b.distanceToSqr(ax, ay, az) < boat.distanceToSqr(ax, ay, az)) boat = b;
					try {
						player.startRiding(boat, true, false);
						boat.positionRider(player);
						double x0 = boat.getX(), z0 = boat.getZ();
						int steps = (int) Math.ceil(distance / step), inWall = 0, riderHit = 0;
						boolean blocked = false;
						double maxEye = player.getEyeY();
						JsonArray blockedAt = null;
						int done = 0;
						for (int i = 0; i < steps; i++) {
							double bx = boat.getX(), bz = boat.getZ();
							boat.move(MoverType.SELF, new Vec3(dx * step, 0, dz * step));
							boat.positionRider(player);
							done++;
							double moved = Math.abs(boat.getX() - bx) + Math.abs(boat.getZ() - bz);
							if (moved < step * 0.5) {
								blocked = true;
								blockedAt = new JsonArray();
								blockedAt.add(boat.getX());
								blockedAt.add(boat.getY());
								blockedAt.add(boat.getZ());
								break;
							}
							if (player.isInWall()) inWall++;
							if (!level.noCollision(player, player.getBoundingBox().deflate(0.01))) riderHit++;
							maxEye = Math.max(maxEye, player.getEyeY());
						}
						o.addProperty("moved", Math.abs(boat.getX() - x0) + Math.abs(boat.getZ() - z0));
						o.addProperty("blocked", blocked);
						if (blockedAt != null) o.add("blockedAt", blockedAt);
						o.addProperty("inWall", inWall);
						o.addProperty("riderHit", riderHit);
						o.addProperty("steps", done);
						o.addProperty("boatY", boat.getY());
						o.addProperty("eyeY", player.getEyeY());
						o.addProperty("maxEyeY", maxEye);
						JsonArray end = new JsonArray();
						end.add(boat.getX());
						end.add(boat.getY());
						end.add(boat.getZ());
						o.add("end", end);
					} finally {
						player.stopRiding();
						boat.discard();
					}
					return o;
				});
			});
	}
}
