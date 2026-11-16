package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.site.Fills;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;

/**
 * M5 slice FK DevBridge hooks (docs/DEVBRIDGE.md "M5 FK"): a filled-container site's state, and a player's hand in a container (take
 * from it, add to it) as a gate needs. Headless (genHooks). Kill points FK1..FK4 and FKC1..FKC2 are armed with {@code dev.journal.killAt}.
 */
public final class SliceFkDev {
	private SliceFkDev() {
	}

	private static BlockPos posOf(JsonObject req) {
		JsonElement pe = req.get("pos");
		if (pe == null || !pe.isJsonArray() || pe.getAsJsonArray().size() != 3) {
			throw new DevBridge.DevException("pos must be [x, y, z]");
		}
		JsonArray pa = pe.getAsJsonArray();
		return new BlockPos(pa.get(0).getAsInt(), pa.get(1).getAsInt(), pa.get(2).getAsInt());
	}

	private static JsonObject counts(Map<String, Integer> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}

	private static Map<String, Integer> holds(Container c) {
		Map<String, Integer> m = new TreeMap<>();
		for (int i = 0; i < c.getContainerSize(); i++) {
			ItemStack st = c.getItem(i);
			if (!st.isEmpty()) {
				m.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
			}
		}
		return m;
	}

	private static final String SLAB = "minecraft:petrified_oak_slab";

	/** The player's petrified slabs (inventory and cursor). */
	private static int playerSlabs(net.minecraft.server.level.ServerPlayer pl) {
		int n = 0;
		for (int i = 0; i < pl.getInventory().getContainerSize(); i++) {
			ItemStack st = pl.getInventory().getItem(i);
			if (st.is(net.minecraft.world.item.Items.PETRIFIED_OAK_SLAB)) {
				n += st.getCount();
			}
		}
		return n;
	}

	/** Petrified slab item entities within 32 blocks of pos. */
	private static int slabEntities(ServerLevel level, BlockPos p) {
		int n = 0;
		for (var e : level.getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, new net.minecraft.world.phys.AABB(p).inflate(32))) {
			if (e.getItem().is(net.minecraft.world.item.Items.PETRIFIED_OAK_SLAB)) {
				n += e.getItem().getCount();
			}
		}
		return n;
	}

	/**
	 * (FK-b) A menu click on a container as the server's first player, through the real menu ({@code AbstractContainerMenu.clicked}, which
	 * checks {@code Slot.mayPickup} on every take path).
	 */
	private static JsonObject take(net.minecraft.server.MinecraftServer s, JsonObject req) {
		ServerLevel level = s.overworld();
		BlockPos p = posOf(req);
		int slot = req.has("slot") ? req.get("slot").getAsInt() : 0;
		String click = req.has("click") ? req.get("click").getAsString() : "pickup";
		JsonObject o = new JsonObject();
		var players = s.getPlayerList().getPlayers();
		BlockEntity be = level.getBlockEntity(p);
		if (players.isEmpty() || !(be instanceof net.minecraft.world.MenuProvider mp) || !(be instanceof Container c)) {
			o.addProperty("error", players.isEmpty() ? "no player" : "no container menu at " + p.toShortString());
			return o;
		}
		net.minecraft.server.level.ServerPlayer pl = players.get(0);
		net.minecraft.world.inventory.AbstractContainerMenu menu = mp.createMenu(0, pl.getInventory(), pl);
		if (menu == null) {
			o.addProperty("error", "the menu would not open");
			return o;
		}
		o.addProperty("creative", pl.isCreative());
		Map<String, Integer> before = holds(c);
		int slabsBefore = playerSlabs(pl);
		int entBefore = slabEntities(level, p);
		o.add("before", counts(before));
		ItemStack carriedIn = ItemStack.EMPTY;
		net.minecraft.world.inventory.ContainerInput in;
		int button = 0;
		int at = slot;
		switch (click) {
			case "pickup" -> in = net.minecraft.world.inventory.ContainerInput.PICKUP;
			case "quick" -> in = net.minecraft.world.inventory.ContainerInput.QUICK_MOVE;
			case "swap" -> {
				in = net.minecraft.world.inventory.ContainerInput.SWAP;
				button = 8; // the last hotbar slot
			}
			case "offhand" -> {
				in = net.minecraft.world.inventory.ContainerInput.SWAP;
				button = 40;
			}
			case "throw" -> in = net.minecraft.world.inventory.ContainerInput.THROW; // Q
			case "throwAll" -> {
				in = net.minecraft.world.inventory.ContainerInput.THROW; // ctrl-Q
				button = 1;
			}
			case "collect" -> {
				// double-click collect: a carried slab (one) gathers its kind; clicked on an empty slot of the player's inventory in the menu
				in = net.minecraft.world.inventory.ContainerInput.PICKUP_ALL;
				carriedIn = new ItemStack(net.minecraft.world.item.Items.PETRIFIED_OAK_SLAB, 1);
				menu.setCarried(carriedIn.copy());
				at = -1;
				for (int i = c.getContainerSize(); i < menu.slots.size(); i++) {
					if (!menu.slots.get(i).hasItem()) {
						at = i;
						break;
					}
				}
				if (at < 0) {
					o.addProperty("error", "no empty inventory slot to collect into");
					menu.setCarried(ItemStack.EMPTY);
					return o;
				}
			}
			default -> throw new DevBridge.DevException("click must be pickup|quick|swap|offhand|throw|throwAll|collect");
		}
		if (click.equals("swap") || click.equals("offhand")) {
			ItemStack hand = click.equals("offhand") ? pl.getOffhandItem() : pl.getInventory().getItem(8);
			if (!hand.isEmpty()) {
				o.addProperty("error", "the swap's hand slot is not empty");
				return o;
			}
		}
		// as a survival player (the gate's bot is a spectator): the mode set around the click, then restored
		net.minecraft.world.level.GameType mode = pl.gameMode.getGameModeForPlayer();
		pl.setGameMode(net.minecraft.world.level.GameType.SURVIVAL);
		o.addProperty("mode", pl.gameMode.getGameModeForPlayer().getName());
		o.addProperty("creative", pl.isCreative());
		try {
			menu.clicked(at, button, in, pl);
		} finally {
			pl.setGameMode(mode);
		}
		Map<String, Integer> after = holds(c);
		ItemStack carried = menu.getCarried();
		o.add("after", counts(after));
		o.addProperty("carried", carried.isEmpty() ? "" : BuiltInRegistries.ITEM.getKey(carried.getItem()) + " x" + carried.getCount());
		int carriedSlabs = carried.is(net.minecraft.world.item.Items.PETRIFIED_OAK_SLAB) ? carried.getCount() : 0;
		o.addProperty("slabsGained", playerSlabs(pl) - slabsBefore + carriedSlabs - carriedIn.getCount());
		o.addProperty("slabEntitiesGained", slabEntities(level, p) - entBefore);
		o.addProperty("containerSlabsLost", before.getOrDefault(SLAB, 0) - after.getOrDefault(SLAB, 0));
		// put things back as they were: what the click took goes back into the container slot, the test's own slab is cleared
		if (!carried.isEmpty() && !carried.is(net.minecraft.world.item.Items.PETRIFIED_OAK_SLAB)) {
			if (c.getItem(slot).isEmpty()) {
				c.setItem(slot, carried.copy());
			} else if (ItemStack.isSameItemSameComponents(c.getItem(slot), carried)) {
				c.getItem(slot).grow(carried.getCount());
			}
		}
		menu.setCarried(ItemStack.EMPTY);
		be.setChanged();
		o.add("restored", counts(holds(c)));
		return o;
	}

	/** (FK-b) A hopper minecart under {@code pos} ticked {@code n} times (its pull, {@code HopperBlockEntity.suckInItems}); what it pulled. */
	private static JsonObject pull(net.minecraft.server.MinecraftServer s, JsonObject req) {
		ServerLevel level = s.overworld();
		BlockPos p = posOf(req);
		int n = req.has("n") ? req.get("n").getAsInt() : 10;
		var cart = new net.minecraft.world.entity.vehicle.minecart.MinecartHopper(net.minecraft.world.entity.EntityTypes.HOPPER_MINECART, level);
		cart.setPos(p.getX() + 0.5, p.getY() - 1 + 0.0625, p.getZ() + 0.5);
		Map<String, Integer> before = level.getBlockEntity(p) instanceof Container c ? holds(c) : Map.of();
		for (int i = 0; i < n; i++) {
			net.minecraft.world.level.block.entity.HopperBlockEntity.suckInItems(level, cart);
		}
		JsonObject o = new JsonObject();
		o.add("pulled", counts(holds(cart)));
		o.add("before", counts(before));
		if (level.getBlockEntity(p) instanceof Container c) {
			o.add("after", counts(holds(c)));
		}
		cart.discard();
		return o;
	}

	/** (FK-b) A Fabric Transfer API extraction ({@code ItemStorage.SIDED}, from below) from the container at pos, in a transaction aborted after. */
	private static JsonObject transfer(net.minecraft.server.MinecraftServer s, JsonObject req) {
		ServerLevel level = s.overworld();
		BlockPos p = posOf(req);
		String item = Fields.of(req).nonBlank("item");
		long max = req.has("max") ? req.get("max").getAsLong() : 64;
		JsonObject o = new JsonObject();
		var storage = net.fabricmc.fabric.api.transfer.v1.item.ItemStorage.SIDED.find(level, p, net.minecraft.core.Direction.DOWN);
		if (storage == null) {
			o.addProperty("error", "no item storage at " + p.toShortString());
			return o;
		}
		var variant = net.fabricmc.fabric.api.transfer.v1.item.ItemVariant.of(BuiltInRegistries.ITEM.getValue(Identifier.parse(item)));
		try (var tx = net.fabricmc.fabric.api.transfer.v1.transaction.Transaction.openOuter()) {
			o.addProperty("extracted", storage.extract(variant, max, tx));
			tx.abort(); // the probe moves nothing for good
		}
		o.addProperty("guardApplied", dev.larattalabs.architect.site.FillGuard.transferGuardApplied());
		return o;
	}

	public static void init() {
		DevBridge.register("dev.fk.take", 30_000, "{pos: [x, y, z], slot, click: pickup|quick|swap|offhand|throw|throwAll|collect} - (FK-b) TEST: a menu click "
			+ "on the container as the first player, through the real menu (Slot.mayPickup); answers {before, after, carried, slabsGained, "
			+ "slabEntitiesGained, containerSlabsLost, restored}; a taken billed item is put back", (req, mc) -> ServerTasks.callOnServer(s -> take(s, req)));
		DevBridge.register("dev.fk.pull", 30_000, "{pos: [x, y, z], n?: 10} - (FK-b) TEST: a hopper minecart under pos pulls n times; answers {pulled, before, "
			+ "after}", (req, mc) -> ServerTasks.callOnServer(s -> pull(s, req)));
		DevBridge.register("dev.fk.transfer", 30_000, "{pos: [x, y, z], item, max?: 64} - (FK-b) TEST: a Fabric Transfer API extraction (ItemStorage.SIDED, "
			+ "from below), aborted after; answers {extracted, guardApplied}", (req, mc) -> ServerTasks.callOnServer(s -> transfer(s, req)));
		DevBridge.register("dev.fk.guard", 10_000, "{} - (FK-b) {transferGuardApplied, stripped}", (req, mc) -> ServerTasks.callOnServer(s -> {
			JsonObject o = new JsonObject();
			o.addProperty("transferGuardApplied", dev.larattalabs.architect.site.FillGuard.transferGuardApplied());
			o.addProperty("stripped", dev.larattalabs.architect.site.Fills.STRIPPED);
			o.addProperty("swapRefused", dev.larattalabs.architect.site.Fills.SWAP_REFUSED);
			return o;
		}));
		DevBridge.register("dev.fk.swap", 30_000, "{pos: [x, y, z], block, site} - (FK-b fix) TEST: the block at pos set to block (an empty one, a player's swap) and "
			+ "the site resumed in the same server task, never in a tick whose step rescans first; answers {swapped} or {retry: true}",
			(req, mc) -> ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				if ((dev.larattalabs.architect.site.Builder.devTicks() + 1) % 20 == 0) {
					o.addProperty("retry", true); // the next step rescans before it fills: the swap would be seen, not tested
					return o;
				}
				BlockPos p = posOf(req);
				var block = BuiltInRegistries.BLOCK.getValue(Identifier.parse(Fields.of(req).nonBlank("block")));
				s.overworld().setBlock(p, block.defaultBlockState(), net.minecraft.world.level.block.Block.UPDATE_ALL);
				try {
					dev.larattalabs.architect.site.Builder.setPaused(s, Fields.of(req).nonBlank("site"), false);
				} catch (dev.larattalabs.architect.site.Sites.SiteException e) {
					o.addProperty("error", e.getMessage());
					return o;
				}
				o.addProperty("swapped", true);
				o.addProperty("block", BuiltInRegistries.BLOCK.getKey(s.overworld().getBlockState(p).getBlock()).toString());
				return o;
			}));
		DevBridge.register("dev.fk.break", 30_000, "{pos: [x, y, z], halt?: bool} - (FK-b) TEST: the first player breaks the block at pos (its game mode's "
			+ "destroyBlock: vanilla's drops); halt: the JVM halts right after, before any save (the strip's crash case); answers {broken, stripped}",
			(req, mc) -> ServerTasks.callOnServer(s -> {
				BlockPos p = posOf(req);
				var players = s.getPlayerList().getPlayers();
				JsonObject o = new JsonObject();
				if (players.isEmpty()) {
					o.addProperty("error", "no player");
					return o;
				}
				long before = dev.larattalabs.architect.site.Fills.STRIPPED;
				var pl = players.get(0);
				net.minecraft.world.level.GameType mode = pl.gameMode.getGameModeForPlayer();
				pl.setGameMode(net.minecraft.world.level.GameType.SURVIVAL); // a survival player's break (the gate's bot is a spectator)
				pl.setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND, new ItemStack(net.minecraft.world.item.Items.IRON_PICKAXE));
				boolean ok;
				try {
					ok = pl.gameMode.destroyBlock(p);
				} finally {
					pl.setItemInHand(net.minecraft.world.InteractionHand.MAIN_HAND, ItemStack.EMPTY);
					pl.setGameMode(mode);
				}
				o.addProperty("mode", "survival");
				if (req.has("halt") && req.get("halt").getAsBoolean()) {
					// the evidence the halt can't answer with: written beside the world before the JVM halts
					try {
						java.nio.file.Files.writeString(s.getWorldPath(net.minecraft.world.level.storage.LevelResource.ROOT).resolve("fkb-strip-halt.json"),
							"{\"broken\": " + ok + ", \"stripped\": " + (dev.larattalabs.architect.site.Fills.STRIPPED - before) + "}");
					} catch (java.io.IOException e) {
						dev.larattalabs.architect.Architect.LOGGER.error("TEST dev.fk.break: {}", e.toString());
					}
					dev.larattalabs.architect.Architect.LOGGER.warn("TEST dev.fk.break: halting after the break at {} (stripped {})", p.toShortString(),
						dev.larattalabs.architect.site.Fills.STRIPPED - before);
					Runtime.getRuntime().halt(7);
				}
				o.addProperty("broken", ok);
				o.addProperty("stripped", dev.larattalabs.architect.site.Fills.STRIPPED - before);
				return o;
			}));
		DevBridge.register("dev.fk.slabs", 10_000, "{pos: [x, y, z]} - (FK-b) the first player's petrified slabs and the slab item entities within 32 of pos",
			(req, mc) -> ServerTasks.callOnServer(s -> {
				JsonObject o = new JsonObject();
				var players = s.getPlayerList().getPlayers();
				o.addProperty("player", players.isEmpty() ? -1 : playerSlabs(players.get(0)));
				o.addProperty("entities", slabEntities(s.overworld(), posOf(req)));
				return o;
			}));
		// (slice LC, S-M5-12/S-M5-13) late cargo and a failure after the custody, deterministic
		DevBridge.register("dev.removal.lateCargo", 10_000, "{site, pos: [x, y, z], items: {item: count}} - (slice LC) TEST: arms one injection: the next "
			+ "removal of site puts the items into the container at pos right after its custody is saved (a group removal: ticks before its writes)",
			(req, mc) -> {
				String site = Fields.of(req).nonBlank("site");
				BlockPos p = posOf(req);
				Map<String, Integer> items = new TreeMap<>();
				req.getAsJsonObject("items").entrySet().forEach(e -> items.put(e.getKey(), e.getValue().getAsInt()));
				return ServerTasks.callOnServer(s -> {
					dev.larattalabs.architect.site.LateCargo.armInject(site, p, items);
					return dev.larattalabs.architect.site.LateCargo.stateJson();
				});
			});
		DevBridge.register("dev.removal.failAfterCustody", 10_000, "{site} - (slice LC, S-M5-13) TEST: the next removal of site (a group, stage, region or "
			+ "revision removal, or a single Remove) ends unwritten right after its custody is saved: the custody written back (then kill point LC1)",
			(req, mc) -> {
				String site = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> {
					dev.larattalabs.architect.site.LateCargo.armFail(site);
					return dev.larattalabs.architect.site.LateCargo.stateJson();
				});
			});
		DevBridge.register("dev.removal.state", 10_000, "{clear?: bool} - (slice LC) TEST: the armed hooks and the last late cargo handed out {site, items, "
			+ "cells, at}", (req, mc) -> ServerTasks.callOnServer(s -> {
				if (req.has("clear") && req.get("clear").getAsBoolean()) {
					dev.larattalabs.architect.site.LateCargo.clear();
				}
				return dev.larattalabs.architect.site.LateCargo.stateJson();
			}));
		DevBridge.register("dev.removal.undoStage", 3_600_000, "{site} - (slice LC) TEST: undoes the stage holding site as a region revision undoes its own "
			+ "stage (Groups.undoStage, ownStage), the later placed stages first (last first) -> {removed, blockers, refund}", (req, mc) -> {
				String site = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> {
					var rec = dev.larattalabs.architect.site.Sites.get(site);
					if (rec == null || rec.member() == null) {
						return java.util.concurrent.CompletableFuture.completedFuture((dev.larattalabs.architect.site.Groups.Removed) null);
					}
					var g = dev.larattalabs.architect.site.Sites.group(rec.member().group());
					int at = -1;
					for (int i = 0; g != null && i < g.stages().size(); i++) {
						if (g.stages().get(i).sites().contains(site)) {
							at = i;
						}
					}
					if (at < 0) {
						return java.util.concurrent.CompletableFuture.completedFuture((dev.larattalabs.architect.site.Groups.Removed) null);
					}
					// the later placed stages first (a revision's suffix undoes last first), then the site's own
					java.util.List<String> order = new java.util.ArrayList<>();
					for (int i = g.stages().size() - 1; i > at; i--) {
						var st = g.stages().get(i);
						if (st.state() == dev.larattalabs.architect.api.Stage.State.PLACED || st.state() == dev.larattalabs.architect.api.Stage.State.PARTIAL) {
							order.add(st.name());
						}
					}
					order.add(g.stages().get(at).name());
					String gid = g.id();
					java.util.concurrent.CompletableFuture<dev.larattalabs.architect.site.Groups.Removed> f = java.util.concurrent.CompletableFuture.completedFuture(null);
					for (String st : order) {
						f = f.thenCompose(prev -> prev != null && !prev.removed() ? java.util.concurrent.CompletableFuture.completedFuture(prev)
							: s.submit(() -> dev.larattalabs.architect.site.Groups.undoStage(s, gid, st, false, dev.larattalabs.architect.site.Sites.Covered.KEEP, true))
								.thenCompose(x -> x));
					}
					return f;
				}).thenCompose(f -> f).handle((r, ex) -> {
					JsonObject o = new JsonObject();
					if (ex != null) {
						o.addProperty("error", String.valueOf(ex.getCause() != null ? ex.getCause().getMessage() : ex.getMessage()));
						return o;
					}
					if (r == null) {
						o.addProperty("error", "no stage holds " + site);
						return o;
					}
					o.addProperty("removed", r.removed());
					JsonArray b = new JsonArray();
					r.blockers().forEach(b::add);
					o.add("blockers", b);
					o.add("refund", counts(r.refund()));
					return o;
				});
			});
		DevBridge.register("dev.fk.state", 30_000, "{site} - (M5 FK) a fill site: {phase, hasFill, key, filled, custody, paid, fillItems, containers: [{at, declared, "
			+ "holds}], locks: [{at, state}]}", (req, mc) -> {
				String id = Fields.of(req).nonBlank("site");
				return ServerTasks.callOnServer(s -> Fills.stateJson(s, id));
			});
		DevBridge.register("dev.fk.container", 30_000, "{pos: [x, y, z], take?: {item: count}, add?: {item: count}, clear?: bool} - (M5 FK) TEST: a player's "
			+ "hand in the container at pos (takes from any slot; adds into free slots); answers {holds: {item: count}, state}", (req, mc) -> {
				JsonElement pe = req.get("pos");
				if (pe == null || !pe.isJsonArray() || pe.getAsJsonArray().size() != 3) {
					throw new DevBridge.DevException("pos must be [x, y, z]");
				}
				JsonArray pa = pe.getAsJsonArray();
				BlockPos p = new BlockPos(pa.get(0).getAsInt(), pa.get(1).getAsInt(), pa.get(2).getAsInt());
				return ServerTasks.callOnServer(s -> {
					ServerLevel level = s.overworld();
					BlockEntity be = level.getBlockEntity(p);
					if (!(be instanceof Container c)) {
						JsonObject o = new JsonObject();
						o.addProperty("error", "no container at " + p.toShortString());
						return o;
					}
					if (req.has("clear") && req.get("clear").getAsBoolean()) {
						c.clearContent();
					}
					if (req.has("take")) {
						for (var e : req.getAsJsonObject("take").entrySet()) {
							int left = e.getValue().getAsInt();
							for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
								ItemStack st = c.getItem(i);
								if (!st.isEmpty() && BuiltInRegistries.ITEM.getKey(st.getItem()).toString().equals(e.getKey())) {
									int n = Math.min(left, st.getCount());
									st.shrink(n);
									c.setItem(i, st.isEmpty() ? ItemStack.EMPTY : st);
									left -= n;
								}
							}
						}
					}
					if (req.has("add")) {
						for (var e : req.getAsJsonObject("add").entrySet()) {
							var item = BuiltInRegistries.ITEM.getValue(Identifier.parse(e.getKey()));
							int left = e.getValue().getAsInt();
							for (int i = 0; i < c.getContainerSize() && left > 0; i++) {
								ItemStack st = c.getItem(i);
								if (st.isEmpty()) {
									int n = Math.min(left, item.getDefaultMaxStackSize());
									c.setItem(i, new ItemStack(item, n));
									left -= n;
								} else if (st.is(item) && st.getCount() < st.getMaxStackSize()) {
									int n = Math.min(left, st.getMaxStackSize() - st.getCount());
									st.grow(n);
									left -= n;
								}
							}
						}
					}
					be.setChanged();
					Map<String, Integer> holds = new TreeMap<>();
					for (int i = 0; i < c.getContainerSize(); i++) {
						ItemStack st = c.getItem(i);
						if (!st.isEmpty()) {
							holds.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum);
						}
					}
					JsonObject o = new JsonObject();
					JsonObject h = new JsonObject();
					holds.forEach(h::addProperty);
					o.add("holds", h);
					o.addProperty("state", level.getBlockState(p).toString()); // (slice FL) e.g. a hopper's enabled
					return o;
				});
			});
	}
}
