package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.region.FluidTxns;
import dev.larattalabs.architect.region.RegionFluids;
import dev.larattalabs.architect.site.ChunkDebt;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.DispenserBlock;
import net.minecraft.world.level.block.entity.DispenserBlockEntity;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.storage.SerializableChunkData;
import net.minecraft.world.phys.AABB;

/**
 * (slice T5Fa, CONTRACT T5F §7 "Hooks-only commit") TEST hooks for the T5F failing-first rows: one chunk's snapshot saved now or lost at
 * the next save, a save-then-halt, a removal drain held at one chunk, traces of Architect's own fluid writes and forced ticks, a save at the
 * fluids gate, the player's real bucket and break, a real dispenser fire, and the txn kinds registered. Dev runs only (the DevBridge is off
 * outside a development environment); every seam they arm is off by default and changes nothing until armed. Server work only (the
 * headless server generates them too: devserver genHooks).
 */
public final class SliceT5FDev {
	private SliceT5FDev() {
	}

	public static void init() {
		DevBridge.register("dev.chunk.drop", 10_000, "{chunks: [[x,z]]} | {off: true} - (T5Fa) TEST: those chunks' block-storage writes are skipped while "
			+ "armed (their snapshot lost): arm right before a +save kill point or dev.chunk.halt {save}; the halt leaves them at their last save -> "
			+ "{dropped: [\"x,z\"]}", (req, mc) -> {
				if (req.has("off") && req.get("off").getAsBoolean()) {
					ChunkDebt.TEST_DROP.clear();
				} else {
					for (JsonElement c : req.getAsJsonArray("chunks")) {
						JsonArray a = c.getAsJsonArray();
						ChunkDebt.TEST_DROP.add(a.get(0).getAsInt() + "," + a.get(1).getAsInt());
					}
				}
				JsonObject o = new JsonObject();
				JsonArray d = new JsonArray();
				ChunkDebt.TEST_DROP.forEach(d::add);
				o.add("dropped", d);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.chunk.save", 120_000, "{chunks: [[x,z]]} - (T5Fa) TEST: those loaded chunks' snapshots written to their region file now (the "
			+ "rest unsaved): with a bare halt after, a mixed receipt state -> {saved: [\"x,z\"]}", (req, mc) -> {
				JsonArray chunks = req.getAsJsonArray("chunks");
				return ServerTasks.callAsPlayer((level, player) -> {
					List<CompletableFuture<Void>> fs = new ArrayList<>();
					JsonArray saved = new JsonArray();
					for (JsonElement c : chunks) {
						JsonArray a = c.getAsJsonArray();
						int x = a.get(0).getAsInt(), z = a.get(1).getAsInt();
						LevelChunk ch = level.getChunk(x, z);
						CompoundTag tag = SerializableChunkData.copyOf(level, ch).write();
						fs.add(level.getChunkSource().chunkMap.write(new ChunkPos(x, z), () -> tag));
						saved.add(x + "," + z);
					}
					JsonObject o = new JsonObject();
					o.add("saved", saved);
					return new Object[] {fs, o};
				}).thenCompose(r -> {
					@SuppressWarnings("unchecked")
					List<CompletableFuture<Void>> fs = (List<CompletableFuture<Void>>) r[0];
					return CompletableFuture.allOf(fs.toArray(CompletableFuture[]::new)).thenApply(v -> (JsonObject) r[1]);
				});
			});
		DevBridge.register("dev.chunk.halt", 60_000, "{save?: false} - (T5Fa) TEST: halts the JVM now (no shutdown hooks), after saving every chunk "
			+ "(dev.chunk.drop's skipped) with save; never answers", (req, mc) -> {
				boolean save = req.has("save") && req.get("save").getAsBoolean();
				ServerTasks.callOnServer(s -> {
					if (save) {
						s.saveAllChunks(true, true, true);
					}
					dev.larattalabs.architect.Architect.LOGGER.error("(slice T5Fa TEST) dev.chunk.halt{}; halting the JVM", save ? " after a save" : "");
					Runtime.getRuntime().halt(7);
					return null;
				});
				return new CompletableFuture<>();
			});
		DevBridge.register("dev.fluid.holdChunk", 10_000, "{x, z} | {off: true} | {} - (T5Fa) TEST: a removal drain's W throws (held) when it reaches "
			+ "that chunk (8cT: inside its seen loop; T5F: that chunk's W) -> {held: [x,z]|null, before: [\"x,z\"] (the chunks whose evidence was "
			+ "saved before the last throw)}", (req, mc) -> {
				if (req.has("off") && req.get("off").getAsBoolean()) {
					FluidTxns.holdChunk = null;
				} else if (req.has("x")) {
					FluidTxns.holdChunkBefore.clear();
					FluidTxns.holdChunk = new int[] {req.get("x").getAsInt(), req.get("z").getAsInt()};
				}
				JsonObject o = new JsonObject();
				int[] h = FluidTxns.holdChunk;
				if (h == null) {
					o.add("held", com.google.gson.JsonNull.INSTANCE);
				} else {
					JsonArray a = new JsonArray();
					a.add(h[0]);
					a.add(h[1]);
					o.add("held", a);
				}
				JsonArray b = new JsonArray();
				FluidTxns.holdChunkBefore.forEach(b::add);
				o.add("before", b);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.fluid.writeTrace", 10_000, "{on?: bool} - (T5Fa) TEST: on starts recording every body cell Architect's fluid writer "
			+ "writes; off answers and stops; {} answers -> {cells: [[x,y,z]]}", (req, mc) -> {
				Set<Long> t = RegionFluids.writeTrace;
				JsonObject o = new JsonObject();
				JsonArray cells = new JsonArray();
				if (t != null) {
					for (long p : t) {
						JsonArray a = new JsonArray();
						a.add(BlockPos.getX(p));
						a.add(BlockPos.getY(p));
						a.add(BlockPos.getZ(p));
						cells.add(a);
					}
				}
				o.add("cells", cells);
				if (req.has("on")) {
					RegionFluids.writeTrace = req.get("on").getAsBoolean() ? ConcurrentHashMap.newKeySet() : null;
				}
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.fluid.forceTrace", 10_000, "{on?: bool} - (T5Fa) TEST: on starts recording every forced-tick pass (forceBody) as "
			+ "<body>@<gameTime>; off answers and stops; {} answers -> {forced: [\"body@t\"]}", (req, mc) -> {
				List<String> t = RegionFluids.forceTrace;
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				if (t != null) {
					t.forEach(a::add);
				}
				o.add("forced", a);
				if (req.has("on")) {
					RegionFluids.forceTrace = req.get("on").getAsBoolean() ? new CopyOnWriteArrayList<>() : null;
				}
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.fluid.saveAtGate", 10_000, "{drop?: [x0,z0,x1,z1] (blocks)} - (T5Fa) TEST: once, at the next fluids gate (before its "
			+ "containment check, before the charge and before any fluids tile writes), every chunk is saved (flushed); with drop, every chunk of that "
			+ "box is then armed as dev.chunk.drop (the fluids stage's writes there never reach disk: a later halt finds them lost) -> {armed}", (req, mc) -> {
				int[] drop = null;
				if (req.has("drop")) {
					JsonArray d = req.getAsJsonArray("drop");
					drop = new int[] {d.get(0).getAsInt(), d.get(1).getAsInt(), d.get(2).getAsInt(), d.get(3).getAsInt()};
				}
				int[] dr = drop;
				RegionFluids.beforeCheck = level -> {
					level.getServer().saveAllChunks(true, true, true);
					if (dr != null) {
						for (int cx = dr[0] >> 4; cx <= dr[2] >> 4; cx++) {
							for (int cz = dr[1] >> 4; cz <= dr[3] >> 4; cz++) {
								ChunkDebt.TEST_DROP.add(cx + "," + cz);
							}
						}
					}
				};
				JsonObject o = new JsonObject();
				o.addProperty("armed", true);
				return CompletableFuture.completedFuture(o);
			});
		DevBridge.register("dev.player.bucket", 30_000, "{at: [x,y,z]} - (T5Fa) TEST: the player (survival) uses an empty bucket on the source at that "
			+ "cell from above, a real item use (an empty bucket put in the main hand if none is held; the filled bucket stays in the inventory); "
			+ "the player is put back -> {result, cell (after), hand, mintedBucket}", (req, mc) -> {
				BlockPos at = pos(req.getAsJsonArray("at"));
				return ServerTasks.callAsPlayer((level, player) -> {
					double x0 = player.getX(), y0 = player.getY(), z0 = player.getZ();
					float yr = player.getYRot(), xr = player.getXRot();
					int minted = 0;
					if (!player.getMainHandItem().is(Items.BUCKET)) {
						ItemStack held = player.getMainHandItem().copy();
						player.setItemInHand(InteractionHand.MAIN_HAND, new ItemStack(Items.BUCKET));
						minted = 1;
						if (!held.isEmpty() && !player.getInventory().add(held)) {
							throw new DevBridge.DevException("dev.player.bucket: the player's inventory is full");
						}
					}
					GameType was = player.gameMode.getGameModeForPlayer();
					player.setGameMode(GameType.SURVIVAL); // a real survival use (the headless bot spectates)
					player.teleportTo(level, at.getX() + 0.5, at.getY() + 1.0, at.getZ() + 0.5, Set.of(), yr, 90f, false);
					ItemStack st = player.getMainHandItem();
					InteractionResult r = player.gameMode.useItem(player, level, st, InteractionHand.MAIN_HAND);
					player.teleportTo(level, x0, y0, z0, Set.of(), yr, xr, false);
					String usedIn = player.gameMode.getGameModeForPlayer().getName();
					player.setGameMode(was);
					JsonObject o = new JsonObject();
					o.addProperty("result", String.valueOf(r));
					o.addProperty("cell", level.getBlockState(at).toString());
					o.addProperty("hand", BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()).toString());
					o.addProperty("mintedBucket", minted);
					o.addProperty("gameMode", usedIn);
					return o;
				});
			});
		DevBridge.register("dev.player.break", 30_000, "{at: [x,y,z]} - (T5Fa) TEST: the player (survival) breaks the block there with an iron "
			+ "pickaxe (a real destroyBlock: its drops), then picks the drops up into the inventory (with block drops off, the drops the break would make) -> {broken, collected: {item: n}}", (req, mc) -> {
				BlockPos at = pos(req.getAsJsonArray("at"));
				return ServerTasks.callAsPlayer((level, player) -> {
					ItemStack held = player.getMainHandItem().copy();
					GameType was = player.gameMode.getGameModeForPlayer();
					player.setGameMode(GameType.SURVIVAL); // a real survival break, with drops (the headless bot spectates)
					ItemStack tool = new ItemStack(Items.IRON_PICKAXE);
					player.setItemInHand(InteractionHand.MAIN_HAND, tool);
					var state = level.getBlockState(at);
					List<ItemStack> would = net.minecraft.world.level.block.Block.getDrops(state, level, at, level.getBlockEntity(at), player, tool);
					boolean broken = player.gameMode.destroyBlock(at);
					player.setItemInHand(InteractionHand.MAIN_HAND, held);
					player.setGameMode(was);
					JsonObject got = new JsonObject();
					for (ItemEntity e : level.getEntitiesOfClass(ItemEntity.class, new AABB(at).inflate(2.0))) {
						ItemStack s = e.getItem().copy();
						String id = BuiltInRegistries.ITEM.getKey(s.getItem()).toString();
						got.addProperty(id, (got.has(id) ? got.get(id).getAsInt() : 0) + s.getCount());
						if (!player.getInventory().add(s)) {
							throw new IllegalStateException("the player's inventory is full");
						}
						e.discard();
					}
					if (broken && got.size() == 0) {
						// the world's rules spawn no block drops (exact rules: doTileDrops off): the player gets what the break would have dropped
						for (ItemStack s : would) {
							String id = BuiltInRegistries.ITEM.getKey(s.getItem()).toString();
							got.addProperty(id, (got.has(id) ? got.get(id).getAsInt() : 0) + s.getCount());
							if (!player.getInventory().add(s.copy())) {
								throw new IllegalStateException("the player's inventory is full");
							}
						}
					}
					JsonObject o = new JsonObject();
					o.addProperty("broken", broken);
					o.add("collected", got);
					return o;
				});
			});
		DevBridge.register("dev.dispense", 30_000, "{at: [x,y,z] (the target cell), item: id (one), fromPlayer?: true} | {read: [x,y,z]} - (T5Fa) TEST: a "
			+ "real dispenser fire: a dispenser placed above the cell facing down, the item put in (taken from the player's inventory with "
			+ "fromPlayer, else minted: the answer says so), a redstone block set on top (it fires about 4 ticks later); read: a dispenser's "
			+ "contents -> {dispenser: [x,y,z], minted} | {items: {item: n}}", (req, mc) -> {
				if (req.has("read")) {
					BlockPos d = pos(req.getAsJsonArray("read"));
					return ServerTasks.callAsPlayer((level, player) -> {
						JsonObject items = new JsonObject();
						if (level.getBlockEntity(d) instanceof DispenserBlockEntity be) {
							for (int i = 0; i < be.getContainerSize(); i++) {
								ItemStack s = be.getItem(i);
								if (!s.isEmpty()) {
									String id = BuiltInRegistries.ITEM.getKey(s.getItem()).toString();
									items.addProperty(id, (items.has(id) ? items.get(id).getAsInt() : 0) + s.getCount());
								}
							}
						}
						JsonObject o = new JsonObject();
						o.add("items", items);
						return o;
					});
				}
				BlockPos at = pos(req.getAsJsonArray("at"));
				Item item = BuiltInRegistries.ITEM.getValue(Identifier.parse(req.get("item").getAsString()));
				boolean fromPlayer = req.has("fromPlayer") && req.get("fromPlayer").getAsBoolean();
				return ServerTasks.callAsPlayer((level, player) -> {
					BlockPos d = at.above();
					if (!level.getBlockState(d).isAir() || !level.getBlockState(d.above()).isAir()) {
						throw new DevBridge.DevException("dev.dispense: the two cells above " + at.toShortString() + " must be air");
					}
					int minted = 1;
					if (fromPlayer) {
						var inv = player.getInventory();
						for (int i = 0; i < inv.getContainerSize(); i++) {
							if (inv.getItem(i).is(item)) {
								inv.removeItem(i, 1);
								minted = 0;
								break;
							}
						}
						if (minted == 1) {
							throw new DevBridge.DevException("dev.dispense: the player holds no " + item);
						}
					}
					level.setBlock(d, Blocks.DISPENSER.defaultBlockState().setValue(DispenserBlock.FACING, Direction.DOWN), 3);
					if (level.getBlockEntity(d) instanceof DispenserBlockEntity be) {
						be.setItem(0, new ItemStack(item));
					}
					level.setBlock(d.above(), Blocks.REDSTONE_BLOCK.defaultBlockState(), 3);
					JsonObject o = new JsonObject();
					o.add("dispenser", arr(d));
					o.addProperty("minted", minted);
					return o;
				});
			});
		DevBridge.register("dev.blocks.find", 60_000, "{box: [x0,y0,z0,x1,y1,z1], block: id} - (T5Fa) every cell of the box (at most 64M cells; loaded chunks only) whose "
			+ "block is that block -> {cells: [[x,y,z]]}", (req, mc) -> {
				JsonArray b = req.getAsJsonArray("box");
				int[] v = new int[6];
				for (int i = 0; i < 6; i++) {
					v[i] = b.get(i).getAsInt();
				}
				if ((long) (v[3] - v[0] + 1) * (v[4] - v[1] + 1) * (v[5] - v[2] + 1) > 64_000_000L) {
					throw new DevBridge.DevException("dev.blocks.find: the box is over 64M cells");
				}
				var block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(req.get("block").getAsString()));
				return ServerTasks.callAsPlayer((level, player) -> {
					JsonArray cells = new JsonArray();
					BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
					for (int x = v[0]; x <= v[3]; x++) {
						for (int z = v[2]; z <= v[5]; z++) {
							LevelChunk ch = level.getChunkSource().getChunkNow(x >> 4, z >> 4);
							if (ch == null) {
								continue;
							}
							for (int y = v[1]; y <= v[4]; y++) {
								if (ch.getBlockState(m.set(x, y, z)).is(block)) {
									cells.add(arr(m));
								}
							}
						}
					}
					JsonObject o = new JsonObject();
					o.add("cells", cells);
					return o;
				});
			});
		DevBridge.register("dev.txn.kinds", 10_000, "{} - (T5Fa) the txn kinds registered in the core (the rows probe for kinds not built yet) -> "
			+ "{kinds: [name]}", (req, mc) -> ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				JsonArray a = new JsonArray();
				try {
					java.lang.reflect.Field f = dev.larattalabs.architect.txn.TxnCore.class.getDeclaredField("kinds");
					f.setAccessible(true);
					((java.util.Map<?, ?>) f.get(dev.larattalabs.architect.txn.TxnServer.core())).keySet().forEach(k -> a.add(String.valueOf(k)));
				} catch (ReflectiveOperationException e) {
					throw new IllegalStateException(e);
				}
				o.add("kinds", a);
				return o;
			}));
	}

	private static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	private static JsonArray arr(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}
}
