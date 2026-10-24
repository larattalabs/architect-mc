package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.FenceGateBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Phase 7a slice CL DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT CL §10 item 8): the ladder physics probe. Vanilla's own movement is the
 * authority: the player is placed at a ladder flight's foot (the feet cell, facing the face) and moved by
 * {@code LivingEntity.travel} with the forward input, tick by tick, as a client's input moves it (so the climb is vanilla's
 * {@code onClimbable} rule against the ladder, with gravity), until its feet reach the flight's top or it stops rising for 40 ticks.
 * The flights are climbed in order (each from its own foot: a rest landing's side step is not simulated); at the top a fence gate in
 * the exit cell is opened for the step off (as the climber opens it) and closed again. The player is put back where it stood.
 * Since NEXT.
 */
public final class SliceClDev {
	private SliceClDev() {
	}

	public static void init() {
		DevBridge.register("dev.climb", 120_000, "{flights: [{x, z, y0, y1}], face: [dx, dz] (toward the wall), exit?: [x, y, z] (the top's walk "
			+ "cell, feet), maxTicks?: 400} - (7a CL) the player climbs each flight from its foot by LivingEntity.travel (forward into the face) "
			+ "-> {flights: [{reached, top, ticks, maxY}], exited, exitY, ok}", (req, mc) -> {
				JsonArray fl = req.getAsJsonArray("flights");
				JsonArray face = req.getAsJsonArray("face");
				int fx = face.get(0).getAsInt(), fz = face.get(1).getAsInt();
				int maxTicks = req.has("maxTicks") ? req.get("maxTicks").getAsInt() : 400;
				JsonArray exit = req.has("exit") ? req.getAsJsonArray("exit") : null;
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					Vec3 home = player.position();
					float yaw = (float) Math.toDegrees(Math.atan2(-fx, fz));
					JsonArray out = new JsonArray();
					boolean ok = true;
					try {
						player.getAbilities().flying = false;
						for (int i = 0; i < fl.size(); i++) {
							JsonObject f = fl.get(i).getAsJsonObject();
							int x = f.get("x").getAsInt(), z = f.get("z").getAsInt(), y0 = f.get("y0").getAsInt(), y1 = f.get("y1").getAsInt();
							player.teleportTo(x + 0.5, y0, z + 0.5);
							player.setYRot(yaw);
							player.setXRot(0);
							player.setDeltaMovement(Vec3.ZERO);
							double maxY = player.getY();
							int still = 0, t = 0;
							boolean reached = false;
							for (; t < maxTicks; t++) {
								player.travel(new Vec3(0, 0, 1));
								if (player.getY() > maxY + 0.01) { maxY = player.getY(); still = 0; } else still++;
								if (player.getY() >= y1 + 0.5) { reached = true; break; }
								if (still > 40) break;
							}
							JsonObject r = new JsonObject();
							r.addProperty("reached", reached);
							r.addProperty("top", y1);
							r.addProperty("ticks", t);
							r.addProperty("maxY", maxY);
							out.add(r);
							ok &= reached;
						}
						// the step off: from the last flight's top, forward into the exit cell (its fence gate opened, then closed)
						if (exit != null) {
							BlockPos ep = new BlockPos(exit.get(0).getAsInt(), exit.get(1).getAsInt(), exit.get(2).getAsInt());
							BlockState before = level.getBlockState(ep);
							boolean gate = before.getBlock() instanceof FenceGateBlock;
							if (gate) level.setBlock(ep, before.setValue(FenceGateBlock.OPEN, true), 2);
							try {
								boolean exited = false;
								for (int t = 0; t < 80 && !exited; t++) {
									player.travel(new Vec3(0, 0, 1));
									exited = player.blockPosition().getX() == ep.getX() && player.blockPosition().getZ() == ep.getZ() && Math.abs(player.getY() - ep.getY()) < 0.6;
								}
								o.addProperty("exited", exited);
								o.addProperty("exitY", player.getY());
								ok &= exited;
							} finally {
								if (gate) level.setBlock(ep, before, 2);
							}
						}
					} finally {
						player.teleportTo(home.x, home.y, home.z);
						player.setDeltaMovement(Vec3.ZERO);
					}
					o.add("flights", out);
					o.addProperty("ok", ok);
					return o;
				});
			});
	}
}
