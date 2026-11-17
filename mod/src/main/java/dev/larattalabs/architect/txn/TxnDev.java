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
				String why = TxnServer.core().resolve(req.get("id").getAsString(), req.get("how").getAsString());
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
	 * dev.txn.conservation {owner?, min, max, baseline?}: report-only (§5.3). Parts per item: the owner's stock, paid cells standing, the
	 * containers, crates (every crate BE found by scanning the box's chunks), item entities and the player's inventory in the box, plus every
	 * open txn's transit by its probes; {@code unread} names the chunks it could not read (inconclusive, never a pass) and every UNKNOWN probe.
	 * With {@code baseline} (an earlier answer's {@code total}) the diff and a verdict ({@code match}, {@code differs}, {@code inconclusive}).
	 * It never fails anything.
	 */
	static JsonObject conservation(MinecraftServer srv, ServerPlayer player, JsonObject req) {
		String owner = req.has("owner") ? req.get("owner").getAsString() : null;
		JsonObject a = Stockpiles.auditParts(srv, player, owner, req);
		Conservation c = new Conservation();
		for (String part : new String[] {"stock", "paidStanding", "containers", "entities", "inventory"}) {
			c.add(part, counts(a.get(part)));
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
