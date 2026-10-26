package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Phase 7a slice LF DevBridge hooks (docs/DEVBRIDGE.md; CONTRACT LF §9 items 1 and 5): the ride probe. Vanilla's own movement is the
 * authority: the player is put in a bubble column and moved tick by tick by {@code LivingEntity.travel} (no input while it rides, then the
 * forward input to step off), with {@code Entity.applyEffectsFromBlocks} over each tick's movement, so the column's push is vanilla's own
 * {@code BubbleColumnBlock.entityInside} ({@code onInsideBubbleColumn} under the top, {@code onAboveBubbleColumn} over it). An up ride starts
 * on the base (feet at {@code y0 + 1}), rides until its feet pass the rim ({@code yT}), then steps toward the face onto the top walk cell
 * ({@code exit}, feet); a down ride starts in the open top (feet at {@code yT}) and is carried to the floor ({@code y0 + 1}), then leaves
 * through the airlock (its doors opened for the step, as a rider opens them, then closed) to the approach ({@code exit}). The player is put
 * back where it stood. Since NEXT.
 */
public final class SliceLfDev {
	private SliceLfDev() {
	}

	public static void init() {
		DevBridge.register("dev.lift.ride", 120_000, "{x, z, y0, yT, drag (false: up over soul sand, true: down over magma), face: [dx, dz] (toward "
			+ "the face), exit: [x, y, z] (feet: the top walk cell for an up ride, the approach for a down ride), doors?: [[x, y, z]] (a down ride's "
			+ "airlock, lower halves), maxTicks?: 600} - (7a LF) the player rides the column by LivingEntity.travel and applyEffectsFromBlocks -> {reached, "
			+ "maxY, minY, ticks, exited, exitAt, ok}", (req, mc) -> {
				int x = req.get("x").getAsInt(), z = req.get("z").getAsInt(), y0 = req.get("y0").getAsInt(), yT = req.get("yT").getAsInt();
				boolean drag = req.has("drag") && req.get("drag").getAsBoolean();
				JsonArray face = req.getAsJsonArray("face");
				int fx = face.get(0).getAsInt(), fz = face.get(1).getAsInt();
				JsonArray exit = req.getAsJsonArray("exit");
				BlockPos ep = new BlockPos(exit.get(0).getAsInt(), exit.get(1).getAsInt(), exit.get(2).getAsInt());
				JsonArray doors = req.has("doors") ? req.getAsJsonArray("doors") : new JsonArray();
				int maxTicks = req.has("maxTicks") ? req.get("maxTicks").getAsInt() : 600;
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonObject o = new JsonObject();
					Vec3 home = player.position();
					// the step's heading: toward the face going up, away from it going down
					int sx = drag ? -fx : fx, sz = drag ? -fz : fz;
					float yaw = (float) Math.toDegrees(Math.atan2(-sx, sz));
					java.util.List<BlockPos> opened = new java.util.ArrayList<>();
					java.util.List<BlockState> was = new java.util.ArrayList<>();
					try {
						player.getAbilities().flying = false;
						player.setAirSupply(player.getMaxAirSupply());
						player.teleportTo(x + 0.5, drag ? yT + 0.1 : y0 + 1.0, z + 0.5);
						player.setYRot(yaw);
						player.setXRot(0);
						player.setDeltaMovement(Vec3.ZERO);
						double maxY = player.getY(), minY = player.getY();
						boolean reached = false;
						int t = 0;
						for (; t < maxTicks && !reached; t++) {
							Vec3 from = player.position();
							player.travel(Vec3.ZERO);
							player.applyEffectsFromBlocks(from, player.position());
							maxY = Math.max(maxY, player.getY());
							minY = Math.min(minY, player.getY());
							reached = drag ? player.getY() <= y0 + 1.2 : player.getY() >= yT + 0.5;
						}
						o.addProperty("reached", reached);
						o.addProperty("maxY", maxY);
						o.addProperty("minY", minY);
						o.addProperty("ticks", t);
						o.addProperty("air", player.getAirSupply());
						// the step off: an up rider steps toward the face (riding on while the column launches it) onto the top walk cell; a down
						// rider opens the airlock's doors and walks out to the approach
						for (JsonElementIterator it = new JsonElementIterator(doors); it.hasNext();) {
							BlockPos dp = it.next();
							BlockState s = level.getBlockState(dp);
							if (s.getBlock() instanceof DoorBlock) {
								opened.add(dp);
								was.add(s);
								level.setBlock(dp, s.setValue(DoorBlock.OPEN, true), 2);
								BlockPos up = dp.above();
								BlockState u = level.getBlockState(up);
								if (u.getBlock() instanceof DoorBlock) {
									opened.add(up);
									was.add(u);
									level.setBlock(up, u.setValue(DoorBlock.OPEN, true), 2);
								}
							}
						}
						boolean exited = false;
						for (int k = 0; k < 200 && reached && !exited; k++) {
							Vec3 from = player.position();
							player.setYRot(yaw);
							player.travel(new Vec3(0, 0, 1));
							player.applyEffectsFromBlocks(from, player.position());
							exited = player.blockPosition().getX() == ep.getX() && player.blockPosition().getZ() == ep.getZ() && Math.abs(player.getY() - ep.getY()) < 0.6;
						}
						o.addProperty("exited", exited);
						JsonArray at = new JsonArray();
						at.add(player.getX());
						at.add(player.getY());
						at.add(player.getZ());
						o.add("exitAt", at);
						o.addProperty("ok", reached && exited);
					} finally {
						for (int i = opened.size() - 1; i >= 0; i--) {
							level.setBlock(opened.get(i), was.get(i), 2);
						}
						player.teleportTo(home.x, home.y, home.z);
						player.setDeltaMovement(Vec3.ZERO);
					}
					return o;
				});
			});
	}

	/** The cells of a JSON array of [x, y, z] as block positions. */
	static final class JsonElementIterator implements java.util.Iterator<BlockPos> {
		private final JsonArray a;
		private int i;

		JsonElementIterator(JsonArray a) {
			this.a = a;
		}

		@Override
		public boolean hasNext() {
			return i < a.size();
		}

		@Override
		public BlockPos next() {
			JsonArray c = a.get(i++).getAsJsonArray();
			return new BlockPos(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt());
		}
	}
}
