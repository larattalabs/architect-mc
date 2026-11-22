package dev.larattalabs.architect.site;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * (slice T4R-D, D1d; parent's condition on Q2/Q15) The player's blocks a removal owed them come back by themselves, never dropped: after the
 * owner (or extraction) retired and its holds are released, each online recipient collects what fits ({@code owed.collect}: the L debit, the
 * give, the player's file acknowledged first); the rest stays owed with a line and the join notice. At the recipient's next join every
 * {@code player_blocks} entry still owed is collected the same way. Nothing at server start (nobody is online); {@code architect:unclaimed}
 * entries are never auto-collected. Server thread.
 */
public final class AutoCollect {
	private AutoCollect() {
	}

	/** Players who joined and whose owed player blocks wait for their collect (the stores loaded, the player in the world), with the tick. */
	private static final Map<java.util.UUID, Integer> JOINED = new java.util.concurrent.ConcurrentHashMap<>();

	static void init() {
		ServerPlayConnectionEvents.JOIN.register((handler, sender, server) -> JOINED.put(handler.getPlayer().getUUID(), 0));
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(AutoCollect::tick);
	}

	/**
	 * Each tick: a joined player's notice and collect once every store is loaded and the player is in the world (at most a minute later: it
	 * then runs as is); never at server start without a player.
	 */
	static void tick(MinecraftServer srv) {
		if (JOINED.isEmpty()) {
			return;
		}
		for (java.util.UUID id : List.copyOf(JOINED.keySet())) {
			int n = JOINED.merge(id, 1, Integer::sum);
			ServerPlayer p = srv.getPlayerList().getPlayer(id);
			if (p == null) {
				JOINED.remove(id);
				continue;
			}
			if ((CrateSettle.notReady() != null || p.isRemoved() || p.isDeadOrDying() || n < 20) && n < 1200) {
				continue;
			}
			JOINED.remove(id);
			Architect.LOGGER.info("Auto-collect at the join of {}: {} owed entr(ies)", id, OwedLedger.of(id.toString()).size());
			onJoin(srv, p);
		}
	}

	/** After owner {@code rec} retired: its {@code player_blocks} parts collected for their online recipients, by site title. */
	static void afterRetire(MinecraftServer srv, JsonObject rec, Map<String, JsonObject> results) {
		JsonObject members = rec.getAsJsonObject("members");
		for (var e : results.entrySet()) {
			JsonObject m = members.get(e.getKey()) instanceof JsonObject x ? x : new JsonObject();
			String title = m.has("title") ? m.get("title").getAsString() : rec.has("title") ? rec.get("title").getAsString() : e.getKey();
			afterParts(srv, title, e.getValue().getAsJsonArray("owedParts"));
		}
	}

	/**
	 * (slice T4R-D fix round, P2-1) After any removal path retired (a single removal's owner, a group's, stage's, region's or revision's txn,
	 * an extraction attempt): its {@code player_blocks} parts ({key, recipient, reason, items}) collected for their online recipients.
	 */
	static void afterParts(MinecraftServer srv, String title, com.google.gson.@org.jspecify.annotations.Nullable JsonArray parts) {
		if (parts == null) {
			return;
		}
		for (var el : parts) {
			JsonObject p = el.getAsJsonObject();
			if (OwedLedger.PLAYER_BLOCKS.equals(p.get("reason").getAsString())) {
				collect(srv, p.get("recipient").getAsString(), p.get("key").getAsString(), title, false);
			}
		}
	}

	/**
	 * (fix round P2-1) {@link #afterParts} on a later tick (outside the txn drive that retired it: a collect begins its own txn), with the parts
	 * {@code read} then (the retired path's immutable snapshot).
	 */
	static void afterPartsLater(MinecraftServer srv, String title, java.util.function.Supplier<com.google.gson.JsonArray> read) {
		dev.larattalabs.architect.txn.TxnServer.later(() -> afterParts(srv, title, read.get()));
	}

	/** The join notice and collect: every {@code player_blocks} entry owed to {@code p}. */
	static void onJoin(MinecraftServer srv, ServerPlayer p) {
		String me = p.getUUID().toString();
		Set<String> titles = new LinkedHashSet<>();
		int left = 0;
		for (OwedLedger.Entry e : OwedLedger.of(me)) {
			if (!OwedLedger.PLAYER_BLOCKS.equals(e.reason())) {
				continue;
			}
			String title = e.site() != null ? Sites.describe(e.site()) : e.key();
			left += collect(srv, me, e.key(), title, true);
			if (OwedLedger.get(e.key()) != null) {
				titles.add(title);
			}
		}
		if (left > 0) {
			int n = left;
			p.sendSystemMessage(Component.literal("Architect owes you " + n + " items (from " + String.join(", ", titles) + "): /architect collect."));
		}
	}

	/** Collects what fits of {@code key} for {@code recipient} when online; the line says what came back. Returns what is still owed. */
	static int collect(MinecraftServer srv, String recipient, String key, String title, boolean quietLeft) {
		if (OwedLedger.UNCLAIMED.equals(recipient)) {
			return 0; // anyone's: never auto-collected
		}
		ServerPlayer p;
		try {
			p = srv.getPlayerList().getPlayer(java.util.UUID.fromString(recipient));
		} catch (IllegalArgumentException e) {
			return 0; // an owner id, not a player: owed (a settlement collects or credits it explicitly)
		}
		OwedLedger.Entry e = OwedLedger.get(key);
		if (p == null || e == null) {
			return e == null ? 0 : total(e.items());
		}
		dev.larattalabs.architect.txn.OwedTxn.Answer a = dev.larattalabs.architect.txn.OwedTxn.collect(srv, recipient, key, p);
		int given = total(a.given());
		OwedLedger.Entry after = OwedLedger.get(key);
		int left = after == null ? 0 : total(after.items());
		if (given > 0) {
			p.sendSystemMessage(Component.literal("Returned " + given + " of your blocks from " + title + "."));
		}
		if (left > 0 && !quietLeft) {
			p.sendSystemMessage(Component.literal(left + " more from " + title + " are owed to you: /architect collect."));
		}
		Architect.LOGGER.info("Auto-collect of {} for {}: given {}, still owed {} ({})", key, recipient, given, left, a.status());
		return left;
	}

	static int total(Map<String, Integer> m) {
		return m.values().stream().mapToInt(Integer::intValue).sum();
	}

	/** (TEST seam) The keys of {@code results}' player_blocks parts. */
	static List<String> playerKeys(Map<String, JsonObject> results) {
		List<String> out = new java.util.ArrayList<>();
		results.values().forEach(r -> r.getAsJsonArray("owedParts").forEach(x -> {
			if (OwedLedger.PLAYER_BLOCKS.equals(x.getAsJsonObject().get("reason").getAsString())) {
				out.add(x.getAsJsonObject().get("key").getAsString());
			}
		}));
		return out;
	}
}
