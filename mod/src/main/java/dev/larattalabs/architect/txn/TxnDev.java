package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.site.Stockpiles;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §4.2 "Dev hooks", docs/DEVBRIDGE.md) The {@code dev.txn.*} hooks, as the client's player, on the server
 * thread: {@code state}, {@code points}, {@code trace}, {@code run} (the test kind), {@code failPersist}, {@code resolve} and
 * {@code conservation} (report-only). TEST and dev only: nothing a player can reach.
 */
public final class TxnDev {
	private TxnDev() {
	}

	public static JsonObject dev(MinecraftServer srv, ServerPlayer player, String op, JsonObject req) {
		return switch (op) {
			case "state" -> TxnServer.state();
			case "points" -> points(req);
			case "trace" -> trace(req);
			case "run" -> run(srv, player, req);
			case "failPersist" -> {
				TxnServer.FAIL_WRITES.set(req.has("n") ? req.get("n").getAsInt() : 1);
				JsonObject o = new JsonObject();
				o.addProperty("failWrites", TxnServer.FAIL_WRITES.get());
				yield o;
			}
			case "resolve" -> {
				JsonObject o = new JsonObject();
				String why = TxnServer.core().resolve(req.get("txn").getAsString(), req.get("how").getAsString());
				o.addProperty("refused", why);
				o.add("state", TxnServer.state());
				yield o;
			}
			case "conservation" -> conservation(srv, player, req);
			case "cells" -> cells(player, req);
			case "owedAdd" -> owedAdd(srv, player, req);
			case "owedList" -> owedList(req);
			case "owedCollect" -> answer(OwedTxn.collect(srv, req.get("recipient").getAsString(), req.get("key").getAsString(), player));
			case "owedFailPlayerSave" -> {
				OwedTxn.FAIL_PLAYER_SAVE.set(req.has("n") ? req.get("n").getAsInt() : 1);
				JsonObject o = new JsonObject();
				o.addProperty("failPlayerSave", OwedTxn.FAIL_PLAYER_SAVE.get());
				yield o;
			}
			case "owedCredit" -> answer(OwedTxn.credit(srv, req.get("owner").getAsString(), req.get("key").getAsString()));
			case "poke" -> poke(player, req);
			default -> throw new IllegalArgumentException("unknown dev.txn op " + op);
		};
	}

	static JsonObject points(JsonObject req) {
		JsonObject o = new JsonObject();
		if (req.has("kind")) {
			JsonArray a = new JsonArray();
			KillPoints.points(req.get("kind").getAsString()).forEach(a::add);
			o.add("points", a);
		} else {
			KillPoints.all().forEach((k, v) -> {
				JsonArray a = new JsonArray();
				v.forEach(a::add);
				o.add(k, a);
			});
		}
		return o;
	}

	static JsonObject trace(JsonObject req) {
		boolean on = req.has("on") && req.get("on").getAsBoolean();
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		KillPoints.trace(on).forEach(a::add);
		o.add("trace", a);
		o.addProperty("tracing", on);
		return o;
	}

	static JsonObject run(MinecraftServer srv, ServerPlayer player, JsonObject req) {
		if (req.has("dimension") && !(req.get("dimension") instanceof com.google.gson.JsonPrimitive d && d.isString())) {
			JsonObject o = new JsonObject();
			o.addProperty("refused", "dimension must be a string resource key (e.g. minecraft:overworld)");
			return o;
		}
		String dim = req.has("dimension") ? req.get("dimension").getAsString() : player.level().dimension().identifier().toString();
		Map<String, Integer> items = new TreeMap<>();
		for (var e : req.getAsJsonObject("items").entrySet()) {
			items.put(e.getKey(), e.getValue().getAsInt());
		}
		return TestMove.run(srv, dim, pos(req.getAsJsonArray("from")), pos(req.getAsJsonArray("to")), items, req.has("key") ? req.get("key")
			.getAsString() : null);
	}

	/**
	 * (slice T2a) dev.txn.cells {cells: [[x,y,z], ..]}: per cell its block state, block entity type and identity (a replaced block entity
	 * shows a new id), its slots ({@code "<slot>": "<item> x<n>"}) and the item entities within 2 blocks: what txn-holds compares.
	 */
	static JsonObject cells(ServerPlayer player, JsonObject req) {
		ServerLevel level = (ServerLevel) player.level();
		JsonObject o = new JsonObject();
		for (JsonElement el : req.getAsJsonArray("cells")) {
			BlockPos p = pos(el.getAsJsonArray());
			JsonObject c = new JsonObject();
			c.addProperty("state", level.getBlockState(p).toString());
			BlockEntity be = level.getBlockEntity(p);
			if (be != null) {
				c.addProperty("be", String.valueOf(BuiltInRegistries.BLOCK_ENTITY_TYPE.getKey(be.getType())));
				c.addProperty("beId", System.identityHashCode(be));
				c.addProperty("nbt", be.saveWithoutMetadata(level.registryAccess()).toString()); // (fix round) the persisted data, components included
				if (be instanceof dev.larattalabs.architect.survival.CrateBlockEntity cr) {
					JsonObject sl = new JsonObject();
					cr.ledger().stock().forEach((k, v) -> sl.addProperty("stock:" + k, k + " x" + v));
					c.add("slots", sl); // (T2b) a crate's slots are its ledger's stock
				}
				if (be instanceof net.minecraft.world.Container k) {
					JsonObject sl = new JsonObject();
					for (int i = 0; i < k.getContainerSize(); i++) {
						net.minecraft.world.item.ItemStack st = k.getItem(i);
						if (!st.isEmpty()) {
							sl.addProperty(String.valueOf(i), id(st.getItem()) + " x" + st.getCount());
						}
					}
					c.add("slots", sl);
				}
			}
			int n = 0;
			for (var e : level.getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, new net.minecraft.world.phys.AABB(p).inflate(2))) {
				n += e.getItem().getCount();
			}
			c.addProperty("drops", n);
			o.add(p.getX() + "," + p.getY() + "," + p.getZ(), c);
		}
		return o;
	}

	/**
	 * (slice T2a) dev.txn.poke {pos, how}: one raw write at a cell, as another mod would make it (no command, no player): {@code setBlock}
	 * (air), {@code destroyBlock}, {@code removeBlock}, {@code removeBlockEntity}, {@code setItem} (slot 0 emptied), {@code removeItem} (slot
	 * 0), {@code clearContent}, {@code load} (the block entity loaded from empty data). Answers what the call returned. TEST only.
	 */
	static JsonObject poke(ServerPlayer player, JsonObject req) {
		ServerLevel level = (ServerLevel) player.level();
		BlockPos p = pos(req.getAsJsonArray("pos"));
		String how = req.get("how").getAsString();
		JsonObject o = new JsonObject();
		BlockEntity be = level.getBlockEntity(p);
		net.minecraft.world.Container k = be instanceof net.minecraft.world.Container c ? c : null;
		switch (how) {
			case "setBlock" -> o.addProperty("result", level.setBlock(p, net.minecraft.world.level.block.Blocks.AIR.defaultBlockState(), 3));
			case "destroyBlock" -> o.addProperty("result", level.destroyBlock(p, true));
			case "removeBlock" -> o.addProperty("result", level.removeBlock(p, false));
			case "removeBlockEntity" -> {
				level.removeBlockEntity(p);
				o.addProperty("result", level.getBlockEntity(p) == null ? "removed" : "kept");
			}
			case "setItem" -> {
				if (k != null) {
					k.setItem(0, net.minecraft.world.item.ItemStack.EMPTY);
				}
				o.addProperty("result", k != null);
			}
			case "removeItem" -> o.addProperty("result", k == null ? "no container" : k.removeItem(0, 64).toString());
			case "clearContent" -> {
				if (k != null) {
					k.clearContent();
				}
				o.addProperty("result", k != null);
			}
			case "load" -> {
				if (be != null) {
					be.loadWithComponents(net.minecraft.world.level.storage.TagValueInput.create(net.minecraft.util.ProblemReporter.DISCARDING,
						level.registryAccess(), new net.minecraft.nbt.CompoundTag()));
				}
				o.addProperty("result", be != null);
			}
			// (fix round) things that exist before a hold begins: an open menu, a cached Transfer API handle; and the legacy chest swap
			case "menu" -> {
				net.minecraft.world.MenuProvider mp = level.getBlockState(p).getMenuProvider(level, p);
				o.addProperty("result", mp != null && player.openMenu(mp).isPresent());
			}
			case "menuMove" -> {
				var m = player.containerMenu;
				if (m == player.inventoryMenu) {
					o.addProperty("result", "no menu open");
					break;
				}
				int slot = req.has("slot") ? req.get("slot").getAsInt() : 0;
				o.addProperty("before", m.getSlot(slot).getItem().toString());
				o.addProperty("valid", m.stillValid(player));
				o.addProperty("mode", player.gameMode().getName());
				// a real quick-move click packet, through the server's own handler (its validity check, and the hold's guard)
				player.connection.handleContainerClick(new net.minecraft.network.protocol.game.ServerboundContainerClickPacket(m.containerId, m.getStateId(),
					(short) slot, (byte) 0, net.minecraft.world.inventory.ContainerInput.QUICK_MOVE, new it.unimi.dsi.fastutil.ints.Int2ObjectOpenHashMap<>(),
					net.minecraft.network.HashedStack.EMPTY));
				o.addProperty("after", m.getSlot(slot).getItem().toString());
				o.addProperty("result", player.containerMenu == m ? "clicked, still open" : "clicked, closed");
			}
			case "cacheStorage" -> {
				// Fabric's own chest lookup splits a double chest into its halves; a mod that wraps the compound container itself keeps one
				// handle over both: that is the one cached here (GPT P1-4)
				net.minecraft.world.level.block.state.BlockState bs = level.getBlockState(p);
				var st = bs.getBlock() instanceof net.minecraft.world.level.block.ChestBlock cb
					? net.fabricmc.fabric.api.transfer.v1.item.ContainerStorage.of(net.minecraft.world.level.block.ChestBlock.getContainer(cb, bs, level, p, true), null)
					: net.fabricmc.fabric.api.transfer.v1.item.ItemStorage.SIDED.find(level, p, null);
				CACHED.put(p.asLong(), st);
				o.addProperty("result", st != null);
			}
			case "cachedExtract" -> {
				var st = CACHED.get(p.asLong());
				long n = 0;
				if (st != null) {
					String item = req.has("item") ? req.get("item").getAsString() : "minecraft:oak_planks";
					try (var tx = net.fabricmc.fabric.api.transfer.v1.transaction.Transaction.openOuter()) {
						n = st.extract(net.fabricmc.fabric.api.transfer.v1.item.ItemVariant.of(TestMove.item(item)), 64, tx);
						tx.commit();
					}
				}
				o.addProperty("result", n);
			}
			case "crateFill" -> { // (slice T2b, TEST) a standalone crate's stock, as deliveries booked it
				Map<String, Integer> it = new TreeMap<>();
				req.getAsJsonObject("items").entrySet().forEach(x -> it.put(x.getKey(), x.getValue().getAsInt()));
				if (be instanceof dev.larattalabs.architect.survival.CrateBlockEntity cr) {
					cr.ledger().load(it, Map.of());
					cr.ledgerChanged();
				}
				o.addProperty("result", be instanceof dev.larattalabs.architect.survival.CrateBlockEntity);
			}
			case "crateTakeStock" -> o.addProperty("result", be instanceof dev.larattalabs.architect.survival.CrateBlockEntity cr ? cr.ledger().takeStock().toString() : "no crate");
			case "crateConsume" -> o.addProperty("result", be instanceof dev.larattalabs.architect.survival.CrateBlockEntity cr && cr.ledger().consume(
				req.has("item") ? req.get("item").getAsString() : "minecraft:oak_planks", 1));
			case "crateInsert" -> o.addProperty("result", be instanceof dev.larattalabs.architect.survival.CrateBlockEntity cr ? cr.insert(new net.minecraft.world.item.ItemStack(
				net.minecraft.world.item.Items.OAK_PLANKS, 4)) : -1);
			case "swap" -> {
				BlockPos q = pos(req.getAsJsonArray("with"));
				if (be instanceof net.minecraft.world.level.block.entity.ChestBlockEntity a
					&& level.getBlockEntity(q) instanceof net.minecraft.world.level.block.entity.ChestBlockEntity b) {
					net.minecraft.world.level.block.entity.ChestBlockEntity.swapContents(a, b);
					o.addProperty("result", true);
				} else {
					o.addProperty("result", false);
				}
			}
			default -> throw new IllegalArgumentException("unknown poke " + how);
		}
		return o;
	}

	/** (slice T2b, TEST) dev.owed.add {key, recipient?: the player, items, reason?, at?}: an owed entry, as a source txn's O effect writes it. */
	static JsonObject owedAdd(MinecraftServer srv, ServerPlayer player, JsonObject req) {
		Map<String, Integer> items = new TreeMap<>();
		req.getAsJsonObject("items").entrySet().forEach(e -> items.put(e.getKey(), e.getValue().getAsInt()));
		BlockPos at = req.has("at") ? pos(req.getAsJsonArray("at")) : player.blockPosition();
		String recipient = req.has("recipient") ? req.get("recipient").getAsString() : player.getUUID().toString();
		dev.larattalabs.architect.site.OwedLedger.TEST_UNMARKED = true; // TEST: a dev entry has no source txn
		boolean ok = dev.larattalabs.architect.site.OwedLedger.owe(new dev.larattalabs.architect.site.OwedLedger.Entry(req.get("key").getAsString(), recipient,
			player.level().dimension().identifier().toString(), at.getX(), at.getY(), at.getZ(), items, req.has("reason") ? req.get("reason").getAsString()
				: dev.larattalabs.architect.site.OwedLedger.CRATE_SETTLE, srv.getTickCount(), System.currentTimeMillis(),
			req.has("site") ? req.get("site").getAsString() : null, req.has("region") ? req.get("region").getAsString() : null), null);
		Stockpiles.owedChanged();
		dev.larattalabs.architect.api.SiteEvents.OWED_CHANGED.invoker().onChanged(recipient);
		JsonObject o = owedList(req.has("recipient") ? req : new JsonObject());
		o.addProperty("added", ok);
		o.addProperty("recipient", recipient);
		return o;
	}

	/** dev.stockpile.owed / dev.txn.owedList {recipient?}: the entries (one recipient's, oldest first, or all), and the total. */
	static JsonObject owedList(JsonObject req) {
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		var es = req.has("recipient") ? dev.larattalabs.architect.site.OwedLedger.of(req.get("recipient").getAsString())
			: dev.larattalabs.architect.site.OwedLedger.all();
		Map<String, Integer> tot = new TreeMap<>();
		for (var e : es) {
			JsonObject x = new JsonObject();
			x.addProperty("key", e.key());
			x.addProperty("recipient", e.recipient());
			x.addProperty("dimension", e.dimension());
			x.add("at", pos(new BlockPos(e.x(), e.y(), e.z())));
			JsonObject it = new JsonObject();
			e.items().forEach(it::addProperty);
			e.items().forEach((k, v) -> tot.merge(k, v, Integer::sum));
			x.add("items", it);
			x.addProperty("reason", e.reason());
			x.addProperty("createdTick", e.tick());
			x.addProperty("site", e.site());
			x.addProperty("region", e.region());
			a.add(x);
		}
		o.add("owed", a);
		JsonObject t = new JsonObject();
		tot.forEach(t::addProperty);
		o.add("total", t);
		return o;
	}

	static JsonObject answer(OwedTxn.Answer a) {
		JsonObject o = new JsonObject();
		o.addProperty("status", a.status());
		JsonObject g = new JsonObject();
		a.given().forEach(g::addProperty);
		o.add("given", g);
		JsonObject l = new JsonObject();
		a.stillOwed().forEach(l::addProperty);
		o.add("stillOwed", l);
		o.addProperty("why", a.why());
		o.addProperty("detail", a.detail());
		return o;
	}

	static JsonArray pos(BlockPos p) {
		JsonArray a = new JsonArray();
		a.add(p.getX());
		a.add(p.getY());
		a.add(p.getZ());
		return a;
	}

	/** (dev.txn.poke cacheStorage) Transfer API handles looked up before a hold, used after it. */
	static final Map<Long, net.fabricmc.fabric.api.transfer.v1.storage.Storage<net.fabricmc.fabric.api.transfer.v1.item.ItemVariant>> CACHED = new java.util.HashMap<>();

	static BlockPos pos(JsonArray a) {
		return new BlockPos(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt());
	}

	/**
	 * dev.txn.conservation {owner?, min, max, baseline?}: report-only (§5.3), the §5.1 terms:
	 * <ul>
	 * <li>the box: containers (crates excluded), every crate BE found by scanning its chunks ({@code crateScan}), item entities;</li>
	 * <li>inventories: every online player's, and every offline player's from playerdata ({@code offlineInventories});</li>
	 * <li>every pile's ledger (the owner's only with {@code owner}): stock, custody, held provided items; the owner's paid cells standing
	 * (fluids and mechanisms included), per pile owner;</li>
	 * <li>every open txn's transit by its probes.</li>
	 * </ul>
	 * Terms T1 can't settle are never silently zero: a legacy pending credit (its fate is the legacy resolver's inference), fill-provided
	 * items (created), destroyed and converted items (no T1 kind creates, destroys or converts; a pile's legacy accounting is not reconciled
	 * here), an unreadable chunk or player file, an UNKNOWN probe: each is listed in {@code unread} whenever it is present, and a non-empty
	 * {@code unread} makes the verdict {@code inconclusive}. It never fails anything.
	 */
	static JsonObject conservation(MinecraftServer srv, ServerPlayer player, JsonObject req) {
		String owner = req.has("owner") ? req.get("owner").getAsString() : null;
		JsonObject a = Stockpiles.auditParts(srv, player, owner, req);
		Conservation c = new Conservation();
		for (String part : new String[] {"containers", "entities"}) {
			c.add(part, counts(a.get(part)));
		}
		// inventories: online (every player), then offline (playerdata)
		java.util.Set<java.util.UUID> online = new java.util.HashSet<>();
		Map<String, Integer> inv = new TreeMap<>();
		for (ServerPlayer p : srv.getPlayerList().getPlayers()) {
			online.add(p.getUUID());
			var pi = p.getInventory();
			for (int k = 0; k < pi.getContainerSize(); k++) {
				net.minecraft.world.item.ItemStack st = pi.getItem(k);
				if (!st.isEmpty()) {
					inv.merge(id(st.getItem()), st.getCount(), Integer::sum);
				}
			}
			for (int k = 0; k < p.getEnderChestInventory().getContainerSize(); k++) {
				net.minecraft.world.item.ItemStack st = p.getEnderChestInventory().getItem(k);
				if (!st.isEmpty()) {
					inv.merge(id(st.getItem()), st.getCount(), Integer::sum);
				}
			}
		}
		c.add("inventories", inv);
		c.add("owed", dev.larattalabs.architect.site.OwedLedger.total()); // (slice T2b) every owed collectible, from the ledger (§5.1)
		c.add("offlineInventories", offline(srv, online, c));
		// every pile's ledger holdings (custody and held provided items are holdings, §5.2); the legacy terms named, never silently zero
		for (Stockpiles.Pile p : Stockpiles.all()) {
			if (owner != null && !owner.equals(p.owner())) {
				continue;
			}
			JsonObject l = p.ledger().toJson();
			c.add("stock", p.ledger().stock());
			c.add("custody", keyed(l.get("custody")));
			c.add("heldProvided", keyed(l.get("heldProvided")));
			if (l.get("pendingCredit") instanceof JsonObject pc && pc.size() > 0) {
				pc.keySet().forEach(k -> c.unread("pendingCredit " + p.owner() + " " + k + " (legacy: its removal's fate is inferred at settle)"));
			}
			if (l.get("provided") instanceof JsonObject pr && pr.size() > 0) {
				c.unread("created: " + p.owner() + "'s fill-provided items (FK-b) are not reconciled in T1");
			}
			if (!counts(l.get("consumed")).isEmpty() || !counts(l.get("refundOverflow")).isEmpty()) {
				c.unread("destroyed / converted: " + p.owner() + "'s legacy accounting (consumed, conversions, overflow) is not reconciled in T1");
			}
			JsonObject pa = owner != null ? a : Stockpiles.auditParts(srv, player, p.owner(), req);
			c.add("paidStanding", counts(pa.get("paidStanding")));
		}
		Map<String, Integer> crates = new TreeMap<>();
		if (req.has("min") && req.has("max")) {
			ServerLevel level = (ServerLevel) player.level();
			BlockPos lo = pos(req.getAsJsonArray("min"));
			BlockPos hi = pos(req.getAsJsonArray("max"));
			for (int cx = lo.getX() >> 4; cx <= hi.getX() >> 4; cx++) {
				for (int cz = lo.getZ() >> 4; cz <= hi.getZ() >> 4; cz++) {
					if (!level.hasChunk(cx, cz)) {
						c.unread("chunk " + cx + "," + cz);
						continue;
					}
					for (BlockEntity be : level.getChunk(cx, cz).getBlockEntities().values()) {
						BlockPos p = be.getBlockPos();
						if (be instanceof CrateBlockEntity crate && inside(p, lo, hi)) {
							crate.ledger().stock().forEach((k, v) -> crates.merge(k, v, Integer::sum));
						}
					}
				}
			}
		} else {
			c.unread("box: no min/max (containers, crates and entities not counted)");
		}
		c.add("crateScan", crates);
		c.inTransit(TxnServer.core());
		Map<String, Long> base = null;
		if (req.get("baseline") instanceof JsonObject b) {
			base = new TreeMap<>();
			for (var e : b.entrySet()) {
				base.put(e.getKey(), e.getValue().getAsLong());
			}
		}
		JsonObject o = c.report(base);
		o.addProperty("openTxns", TxnServer.core().open().size());
		return o;
	}

	/** Offline players' inventories and ender chests from playerdata; an unreadable file is unread (inconclusive). */
	static Map<String, Integer> offline(MinecraftServer srv, java.util.Set<java.util.UUID> online, Conservation c) {
		Map<String, Integer> m = new TreeMap<>();
		java.nio.file.Path dir = srv.getWorldPath(net.minecraft.world.level.storage.LevelResource.PLAYER_DATA_DIR);
		if (!java.nio.file.Files.isDirectory(dir)) {
			return m;
		}
		try (var files = java.nio.file.Files.list(dir)) {
			for (java.nio.file.Path f : files.filter(x -> x.getFileName().toString().endsWith(".dat")).toList()) {
				String name = f.getFileName().toString();
				java.util.UUID u;
				try {
					u = java.util.UUID.fromString(name.substring(0, name.length() - 4));
				} catch (IllegalArgumentException e) {
					continue;
				}
				if (online.contains(u)) {
					continue;
				}
				try {
					net.minecraft.nbt.CompoundTag t = net.minecraft.nbt.NbtIo.readCompressed(f, net.minecraft.nbt.NbtAccounter.unlimitedHeap());
					if (t.getList("Inventory").isEmpty()) {
						c.unread("offline player " + u + ": no Inventory list");
						continue;
					}
					for (String list : new String[] {"Inventory", "EnderItems"}) {
						t.getListOrEmpty(list).compoundStream().forEach(st -> {
							String id = st.getStringOr("id", "");
							int n = st.getIntOr("count", st.getIntOr("Count", 1));
							if (!id.isEmpty() && n > 0) {
								m.merge(id, n, Integer::sum);
							}
						});
					}
					if (t.get("equipment") instanceof net.minecraft.nbt.CompoundTag eq) {
						for (String k : eq.keySet()) {
							if (eq.get(k) instanceof net.minecraft.nbt.CompoundTag st) {
								String id = st.getStringOr("id", "");
								if (!id.isEmpty()) {
									m.merge(id, st.getIntOr("count", 1), Integer::sum);
								}
							}
						}
					}
				} catch (Exception e) {
					c.unread("offline player " + u + ": " + e);
				}
			}
		} catch (java.io.IOException e) {
			c.unread("playerdata: " + e);
		}
		return m;
	}

	/** {key: {item: n}} summed over the keys. */
	static Map<String, Integer> keyed(@Nullable JsonElement e) {
		Map<String, Integer> m = new TreeMap<>();
		if (e instanceof JsonObject o) {
			o.entrySet().forEach(x -> counts(x.getValue()).forEach((k, v) -> m.merge(k, v, Integer::sum)));
		}
		return m;
	}

	static boolean inside(BlockPos p, BlockPos lo, BlockPos hi) {
		return p.getX() >= lo.getX() && p.getX() <= hi.getX() && p.getY() >= lo.getY() && p.getY() <= hi.getY() && p.getZ() >= lo.getZ() && p.getZ() <= hi
			.getZ();
	}

	static Map<String, Integer> counts(@Nullable JsonElement e) {
		Map<String, Integer> m = new TreeMap<>();
		if (e instanceof JsonObject o) {
			o.entrySet().forEach(x -> m.put(x.getKey(), x.getValue().getAsInt()));
		}
		return m;
	}

	static String id(net.minecraft.world.item.Item it) {
		return BuiltInRegistries.ITEM.getKey(it).toString();
	}
}
