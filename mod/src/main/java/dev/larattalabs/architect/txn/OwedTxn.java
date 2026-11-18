package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import com.mojang.serialization.Codec;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.DurableFile;
import dev.larattalabs.architect.site.OwedLedger;
import dev.larattalabs.architect.site.Stockpiles;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import net.fabricmc.fabric.api.attachment.v1.AttachmentRegistry;
import net.fabricmc.fabric.api.attachment.v1.AttachmentType;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import org.jspecify.annotations.Nullable;

/**
 * (slice T2b) Owed collectibles out of the owed ledger, as txn kinds on T1's layer:
 * <ul>
 * <li>{@code owed.collect}: effect 0 (L) takes the amounts off the entry, marked by its effect key in the owed ledger; effect 1 (P) gives
 * them to the player, its receipt in the player attachment {@code architect_mc:txn_player_receipts} saved in the player's file with the inventory.
 * The barrier saves the players (acknowledged) before the ledger, and the txn retires only after it. A player offline at recovery makes
 * effect 1 UNKNOWN: held for that player, never compensated (decision 4). Only what fits is planned, in the same server call as its apply;
 * at a redo with too little room the give refuses and the txn is held until there is room.</li>
 * <li>{@code owed.credit}: one L effect: the entry shrinks and the pile credits it keyed {@code owed:<effect key>}, in one ledger change.</li>
 * </ul>
 * Resources: {@code owed:<key>} and, for a collect, {@code player:<uuid>}; never a pile or a site, so a build running for the recipient
 * (a Steward settlement's) never refuses them (SITE_BUSY only for another collect or credit of the same key or player).
 */
public final class OwedTxn {
	private OwedTxn() {
	}

	public static final String COLLECT = "owed.collect", CREDIT = "owed.credit";
	/** The receipts of every P effect applied to a player: persistent, saved with the player, kept through death. */
	public static final AttachmentType<List<String>> PLAYER_RECEIPTS = AttachmentRegistry.<List<String>>builder().persistent(Codec.STRING.listOf())
		.copyOnDeath().buildAndRegister(Architect.id("txn_player_receipts")); // its own id: one id per attachment type (the chunk's is txn_receipts)

	static void init() {
		Architect.LOGGER.debug("Txn player receipts attachment {}", PLAYER_RECEIPTS.identifier());
	}

	static final TxnKind.Adapter DEBIT = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return OwedLedger.applied(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			OwedLedger.debit(e.data().get("key").getAsString(), e.items(), e.key(t.id));
			Stockpiles.owedChanged();
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("an owed debit is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("key") || e.items().isEmpty() ? "key and items are required" : null;
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "owed " + e.data().get("key").getAsString();
		}
	};

	static final TxnKind.Adapter CREDIT_STOCK = new TxnKind.Adapter() {
		@Override
		public Probe probe(TxnEntry t, Effect e) {
			return OwedLedger.applied(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			MinecraftServer s = TxnServer.server();
			if (s == null) {
				throw new IllegalStateException("no server");
			}
			Stockpiles.creditOwed(s, e.data().get("owner").getAsString(), e.data().get("key").getAsString(), e.items(), e.key(t.id));
			Stockpiles.owedChanged();
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("an owed credit is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			return !e.data().has("key") || !e.data().has("owner") || e.items().isEmpty() ? "key, owner and items are required" : null;
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			return "owed " + e.data().get("key").getAsString();
		}
	};

	static final TxnKind.Adapter GIVE = new TxnKind.Adapter() {
		@Nullable ServerPlayer player(Effect e) {
			MinecraftServer s = TxnServer.server();
			return s == null ? null : s.getPlayerList().getPlayer(UUID.fromString(e.data().get("player").getAsString()));
		}

		@Override
		public Probe probe(TxnEntry t, Effect e) {
			ServerPlayer p = player(e);
			if (p == null) {
				return Probe.UNKNOWN; // offline: its file is the evidence, read when it logs in
			}
			List<String> r = p.getAttached(PLAYER_RECEIPTS);
			return r != null && r.contains(e.key(t.id)) ? Probe.APPLIED : Probe.ABSENT;
		}

		@Override
		public void apply(TxnEntry t, Effect e) {
			ServerPlayer p = player(e);
			if (p == null) {
				throw new IllegalStateException("the player is offline");
			}
			if (!fits(p.getInventory(), e.items())) {
				throw new IllegalStateException("no room in the player's inventory"); // held until there is room; nothing given in part
			}
			e.items().forEach((k, n) -> give(p.getInventory(), TestMove.item(k), n));
			List<String> r = new ArrayList<>(p.getAttachedOrElse(PLAYER_RECEIPTS, List.of()));
			r.add(e.key(t.id));
			while (r.size() > 256) {
				r.remove(0); // stale once retired (§3.7): the oldest go
			}
			p.setAttached(PLAYER_RECEIPTS, List.copyOf(r));
			p.inventoryMenu.broadcastChanges();
		}

		@Override
		public void compensate(TxnEntry t, Effect e) {
			throw new IllegalStateException("a give is never a prepare effect");
		}

		@Override
		public @Nullable String invalid(Effect e) {
			if (!e.data().has("player") || e.items().isEmpty()) {
				return "player and items are required";
			}
			try {
				UUID.fromString(e.data().get("player").getAsString());
				return null;
			} catch (IllegalArgumentException x) {
				return "player is not a UUID";
			}
		}

		@Override
		public String where(TxnEntry t, Effect e) {
			ServerPlayer p = player(e);
			return "player " + (p == null ? e.data().get("player").getAsString() : p.getGameProfile().name());
		}
	};

	static TxnKind kind(String name) {
		return new TxnKind() {
			@Override
			public String name() {
				return name;
			}

			@Override
			public int kv() {
				return 1;
			}

			@Override
			public TxnKind.Adapter adapter(Effect e) {
				return switch (e.op()) {
					case "owed.debit" -> DEBIT;
					case "owed.give" -> GIVE;
					case "owed.credit" -> CREDIT_STOCK;
					default -> null;
				};
			}

			@Override
			public JsonObject result(TxnEntry t) {
				JsonObject r = new JsonObject();
				JsonObject g = new JsonObject();
				t.effects().stream().filter(x -> x.op().equals("owed.debit") || x.op().equals("owed.credit")).findFirst()
					.ifPresent(x -> x.items().forEach(g::addProperty));
				r.add("given", g);
				return r;
			}
		};
	}

	public static final TxnKind COLLECT_KIND = kind(COLLECT);
	public static final TxnKind CREDIT_KIND = kind(CREDIT);

	/** What a collect or credit answered. {@code status}: DONE / HELD / REFUSED; {@code why} for a refusal, {@code detail} for a hold. */
	public record Answer(String status, Map<String, Integer> given, Map<String, Integer> stillOwed, boolean replayed, @Nullable String why,
		@Nullable String detail) {
	}

	/** How many of each of {@code items} fit in {@code inv}'s main slots now (none given beyond). */
	static Map<String, Integer> fitting(Inventory inv, Map<String, Integer> items) {
		Map<String, Integer> out = new TreeMap<>();
		int free = 0;
		for (int i = 0; i < Inventory.INVENTORY_SIZE; i++) {
			if (inv.getItem(i).isEmpty()) {
				free++;
			}
		}
		for (var e : new TreeMap<>(items).entrySet()) {
			var it = TestMove.item(e.getKey());
			int room = 0;
			for (int i = 0; i < Inventory.INVENTORY_SIZE; i++) {
				ItemStack s = inv.getItem(i);
				if (s.is(it) && s.getComponentsPatch().isEmpty()) {
					room += s.getMaxStackSize() - s.getCount();
				}
			}
			int max = it.getDefaultMaxStackSize();
			int n = Math.min(e.getValue(), room);
			int rest = e.getValue() - n;
			int stacks = Math.min(free, (rest + max - 1) / max);
			n += Math.min(rest, stacks * max);
			free -= stacks;
			if (n > 0) {
				out.put(e.getKey(), n);
			}
		}
		return out;
	}

	static boolean fits(Inventory inv, Map<String, Integer> items) {
		return fitting(inv, items).equals(new TreeMap<>(items));
	}

	static void give(Inventory inv, net.minecraft.world.item.Item it, int n) {
		for (int i = 0; i < Inventory.INVENTORY_SIZE && n > 0; i++) {
			ItemStack s = inv.getItem(i);
			if (s.is(it) && s.getComponentsPatch().isEmpty() && s.getCount() < s.getMaxStackSize()) {
				int k = Math.min(n, s.getMaxStackSize() - s.getCount());
				s.grow(k);
				n -= k;
			}
		}
		for (int i = 0; i < Inventory.INVENTORY_SIZE && n > 0; i++) {
			if (inv.getItem(i).isEmpty()) {
				int k = Math.min(n, it.getDefaultMaxStackSize());
				inv.setItem(i, new ItemStack(it, k));
				n -= k;
			}
		}
		if (n > 0) {
			throw new IllegalStateException("no room for " + n + " more"); // fits() said there was: never reached
		}
	}

	/** Collects what fits of entry {@code key} for {@code to}. Server thread. */
	public static Answer collect(MinecraftServer srv, String recipient, String key, ServerPlayer to) {
		OwedLedger.Entry e = OwedLedger.get(key);
		if (e == null || !e.recipient().equals(recipient)) {
			return refused("owed_not_found: nothing is owed to " + recipient + " under " + key);
		}
		TxnCore c = TxnServer.core();
		TxnCore.Started s = c.begin(COLLECT, null, List.of("owed:" + key, "player:" + to.getUUID()), to.getUUID().toString());
		if (s.status() != TxnCore.Begin.NEW) {
			return held(s.detail() != null ? s.detail() : s.status().name());
		}
		Map<String, Integer> fit = fitting(to.getInventory(), e.items()); // planned in the same call as its apply: the inventory can't change between
		if (fit.isEmpty()) {
			return new Answer("DONE", Map.of(), e.items(), false, null, "inventory full");
		}
		TxnEntry t = s.entry();
		c.plan(t, Effect.of("owed.debit", EffectClass.L).items(fit).move("owed", Effect.TRANSIT).data("key", key));
		c.plan(t, Effect.of("owed.give", EffectClass.P).items(fit).move(Effect.TRANSIT, "player").data("player", to.getUUID().toString()));
		return drive(c, t, key, recipient, fit);
	}

	/** Credits all of entry {@code key} into {@code owner}'s stock (owner = the entry's recipient). Server thread. */
	public static Answer credit(MinecraftServer srv, String owner, String key) {
		OwedLedger.Entry e = OwedLedger.get(key);
		if (e == null || !e.recipient().equals(owner)) {
			return refused("owed_not_found: nothing is owed to " + owner + " under " + key);
		}
		if (!Stockpiles.hasPile(owner)) {
			return refused("no_stockpile: " + owner + " has no stockpile");
		}
		TxnCore c = TxnServer.core();
		TxnCore.Started s = c.begin(CREDIT, null, List.of("owed:" + key), owner);
		if (s.status() != TxnCore.Begin.NEW) {
			return held(s.detail() != null ? s.detail() : "held");
		}
		TxnEntry t = s.entry();
		c.plan(t, Effect.of("owed.credit", EffectClass.L).items(e.items()).move("owed", "stock").data("key", key).data("owner", owner));
		return drive(c, t, key, owner, e.items());
	}

	static Answer drive(TxnCore c, TxnEntry t, String key, String recipient, Map<String, Integer> planned) {
		DurableFile.Outcome p = c.persist(t);
		if (p != DurableFile.Outcome.OK) {
			return refused("journal_unavailable: txn.json " + p);
		}
		TxnCore.Status st = c.drive(t);
		OwedLedger.Entry after = OwedLedger.get(key);
		Map<String, Integer> left = after == null ? Map.of() : after.items();
		dev.larattalabs.architect.api.SiteEvents.OWED_CHANGED.invoker().onChanged(recipient);
		if (st == TxnCore.Status.HELD || t.held() != null) {
			return new Answer("HELD", planned, left, false, null, Holds.decided(t));
		}
		return new Answer("DONE", planned, left, false, null, null);
	}

	static Answer refused(String why) {
		return new Answer("REFUSED", Map.of(), Map.of(), false, why, null);
	}

	static Answer held(String detail) {
		return new Answer("HELD", Map.of(), Map.of(), false, null, detail);
	}
}
