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
		String dim = req.has("dimension") ? req.get("dimension").getAsString() : player.level().dimension().identifier().toString();
		Map<String, Integer> items = new TreeMap<>();
		for (var e : req.getAsJsonObject("items").entrySet()) {
			items.put(e.getKey(), e.getValue().getAsInt());
		}
		return TestMove.run(srv, dim, pos(req.getAsJsonArray("from")), pos(req.getAsJsonArray("to")), items, req.has("key") ? req.get("key")
			.getAsString() : null);
	}

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
