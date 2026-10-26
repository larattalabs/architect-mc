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
 * forward input to step off), after {@code Entity.baseTick} (its fluid state) and before the column's push, which is vanilla's own
 * {@code BubbleColumnBlock.entityInside} rule read in its bytecode ({@code onInsideBubbleColumn} under the top, {@code onAboveBubbleColumn} at
 * it), for every column block the player's box meets; the player rides in creative (physics, no harm), its mode put back. An up ride starts
 * on the base (feet at {@code y0 + 1}), rides until it surfaces over the column's top ({@code yT}, level with the top walk cell's block),
 * then swims and steps toward the face onto the top walk cell ({@code exit}, feet); a down ride starts in the open top (feet at
 * {@code yT + 1}) and is carried to the floor ({@code y0 + 1}), then leaves
 * through the airlock (its doors opened for the step, as a rider opens them, then closed) to the approach ({@code exit}). The player is put
 * back where it stood. Since NEXT.
 */
public final class SliceLfDev {
	private SliceLfDev() {
	}

	public static void init() {
		DevBridge.register("dev.lift.spawnRule", 60_000, "{x, y, z, tries?: 400} - (7a LF) vanilla's drowned spawn rules at a cell (its biome, its block light): "
			+ "SpawnPlacements.isSpawnPositionOk and checkSpawnRules(DROWNED, NATURAL) over `tries` random draws -> {placementOk, passed, tries, light, "
			+ "biome}", (req, mc) -> {
				int x = req.get("x").getAsInt(), y = req.get("y").getAsInt(), z = req.get("z").getAsInt();
				int tries = req.has("tries") ? req.get("tries").getAsInt() : 400;
				return ServerTasks.callOnServer((server) -> {
					net.minecraft.server.level.ServerLevel level = server.overworld();
					BlockPos p = new BlockPos(x, y, z);
					JsonObject o = new JsonObject();
					o.addProperty("placementOk", net.minecraft.world.entity.SpawnPlacements.isSpawnPositionOk(net.minecraft.world.entity.EntityTypes.DROWNED, level, p));
					net.minecraft.util.RandomSource r = net.minecraft.util.RandomSource.create(7L);
					int passed = 0;
					for (int i = 0; i < tries; i++) {
						if (net.minecraft.world.entity.SpawnPlacements.checkSpawnRules(net.minecraft.world.entity.EntityTypes.DROWNED, level, net.minecraft.world.entity.EntitySpawnReason.NATURAL, p, r)) {
							passed++;
						}
					}
					o.addProperty("passed", passed);
					o.addProperty("tries", tries);
					o.addProperty("light", level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, p));
					o.addProperty("biome", level.getBiome(p).unwrapKey().map(k -> k.identifier().toString()).orElse("?"));
					return o;
				});
			});
		DevBridge.register("dev.lift.ride", 120_000, "{x, z, y0, yT, drag (false: up over soul sand, true: down over magma), face: [dx, dz] (toward "
			+ "the face), exit: [x, y, z] (feet: the top walk cell for an up ride, the approach for a down ride), doors?: [[x, y, z]] (a down ride's "
			+ "airlock, lower halves), maxTicks?: 600} - (7a LF) the player rides the column (baseTick, LivingEntity.travel and the column's own push each tick) -> {reached, "
			+ "maxY, minY, ticks, air, exited, exitAt, rode, error?, stack?}", (req, mc) -> {
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
					net.minecraft.world.level.GameType mode = player.gameMode();
					boolean noPhysics = player.noPhysics;
					try {
						// (physics: a spectator passes through blocks and fluids; creative, not flying, rides as a survival player does, unharmed;
						// noPhysics is the spectator's, kept by Player.tick, which no ride runs: cleared for the ride)
						player.setGameMode(net.minecraft.world.level.GameType.CREATIVE);
						player.noPhysics = false;
						return ride(level, player, o, x, z, y0, yT, drag, yaw, ep, doors, maxTicks, opened, was);
					} catch (RuntimeException e) {
						o.addProperty("rode", false);
						o.addProperty("error", e.toString());
						JsonArray st = new JsonArray();
						for (StackTraceElement t : e.getStackTrace()) {
							if (st.size() < 12) st.add(t.toString());
						}
						o.add("stack", st);
						return o;
					} finally {
						for (int i = opened.size() - 1; i >= 0; i--) {
							level.setBlock(opened.get(i), was.get(i), 2);
						}
						player.teleportTo(home.x, home.y, home.z);
						player.setDeltaMovement(Vec3.ZERO);
						player.setGameMode(mode);
						player.noPhysics = noPhysics;
					}
				});
			});
	}

	/**
	 * The column's push on the player this tick, as vanilla's {@code BubbleColumnBlock.entityInside} gives it (read in its bytecode): for each
	 * bubble column block the player's box meets, {@code onAboveBubbleColumn(drag, pos)} when the block over it has no collision and no fluid
	 * (the column's top), else {@code onInsideBubbleColumn(drag)}.
	 */
	static void bubblePush(net.minecraft.server.level.ServerLevel level, net.minecraft.server.level.ServerPlayer player) {
		net.minecraft.world.phys.AABB b = player.getBoundingBox().deflate(1.0E-5);
		for (BlockPos q : BlockPos.betweenClosed(BlockPos.containing(b.minX, b.minY, b.minZ), BlockPos.containing(b.maxX, b.maxY, b.maxZ))) {
			BlockState s = level.getBlockState(q);
			if (!s.is(net.minecraft.world.level.block.Blocks.BUBBLE_COLUMN)) continue;
			boolean dragDown = s.getValue(net.minecraft.world.level.block.BubbleColumnBlock.DRAG_DOWN);
			BlockState over = level.getBlockState(q.above());
			if (over.getCollisionShape(level, q).isEmpty() && over.getFluidState().isEmpty()) player.onAboveBubbleColumn(dragDown, q.immutable());
			else player.onInsideBubbleColumn(dragDown);
		}
	}

	/**
	 * One tick of a rider, as vanilla's own tick moves a living entity: {@code Entity.baseTick} (its fluid state: in water, the eye under it,
	 * the air), then {@code LivingEntity.aiStep} with the input (forward {@code zza}, {@code jumping}: a jump from the ground or a swim up
	 * in water), whose {@code travel} moves it and whose {@code applyEffectsFromBlocks} gives the column's push
	 * ({@code BubbleColumnBlock.entityInside}).
	 */
	static void step(net.minecraft.server.level.ServerPlayer player, float forward, boolean jump) {
		player.baseTick();
		player.zza = forward;
		player.xxa = 0;
		player.setJumping(jump);
		player.aiStep();
		player.setJumping(false);
		player.zza = 0;
	}

	/** One ride (the hook's body): ride, then step off. */
	static JsonObject ride(net.minecraft.server.level.ServerLevel level, net.minecraft.server.level.ServerPlayer player, JsonObject o, int x, int z, int y0, int yT, boolean drag, float yaw,
		BlockPos ep, JsonArray doors, int maxTicks, java.util.List<BlockPos> opened, java.util.List<BlockState> was) {
					{
						player.getAbilities().flying = false;
						player.setAirSupply(player.getMaxAirSupply());
						player.teleportTo(x + 0.5, drag ? yT + 1.1 : y0 + 1.0, z + 0.5);
						player.setYRot(yaw);
						player.setXRot(0);
						player.setDeltaMovement(Vec3.ZERO);
						double maxY = player.getY(), minY = player.getY();
						boolean reached = false;
						int t = 0;
						for (; t < maxTicks && !reached; t++) {
							step(player, 0f, false);
							maxY = Math.max(maxY, player.getY());
							minY = Math.min(minY, player.getY());
							reached = drag ? player.getY() <= y0 + 1.2 : player.getY() >= yT + 0.8; // (up: surfaced over the column's top, level with the top walk cell's block)
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
						JsonArray path = new JsonArray();
						for (int k = 0; k < 200 && reached && !exited; k++) {
							player.setYRot(yaw);
							player.setYHeadRot(yaw);
							step(player, 1f, !drag); // (an up rider swims up and steps off onto the ledge; a down rider walks out)
							// (in the exit cell, standing on its block or within a half step of it)
							exited = player.blockPosition().getX() == ep.getX() && player.blockPosition().getZ() == ep.getZ() && Math.abs(player.getY() - ep.getY()) <= 1.0;
							if (k % 5 == 0 && path.size() < 40) {
								JsonArray q = new JsonArray();
								q.add(Math.round(player.getX() * 10) / 10.0);
								q.add(Math.round(player.getY() * 10) / 10.0);
								q.add(Math.round(player.getZ() * 10) / 10.0);
								q.add(player.horizontalCollision);
								q.add(player.getPose().toString());
								// (the cells ahead at the feet and the head, for a stuck rider's evidence)
								BlockPos ahead = BlockPos.containing(player.getX() + Math.signum(-Math.sin(Math.toRadians(yaw))) * 0.6, player.getY() + 0.1, player.getZ() + Math.signum(Math.cos(Math.toRadians(yaw))) * 0.6);
								q.add(net.minecraft.world.level.block.Block.BLOCK_STATE_REGISTRY.getId(level.getBlockState(ahead)) + ":" + level.getBlockState(ahead));
								q.add(String.valueOf(level.getBlockState(ahead.above())));
								path.add(q);
							}
						}
						o.add("path", path);
						o.addProperty("exited", exited);
						JsonArray at = new JsonArray();
						at.add(player.getX());
						at.add(player.getY());
						at.add(player.getZ());
						o.add("exitAt", at);
						o.addProperty("rode", reached && exited); // (not "ok": the bridge's envelope owns that name)
					}
		return o;
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
