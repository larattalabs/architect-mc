package dev.larattalabs.architect.site;

import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.TicketType;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ChunkPos;
import org.jspecify.annotations.Nullable;

/**
 * (DR2 fix, GPT review P1-1) A keyed credit's overflow is paid exactly once across a crash. Before, {@code Stockpiles.credit} spawned the
 * item entities before its caller's save published the ledger: a crash inside that save (CS1) kept the entities (the chunks went first)
 * and lost the ledger's "credited", so the start booked the pending refund, overflow included, again. Now:
 * <ol>
 * <li>the credit owes its overflow in the ledger ({@link StockLedger#oweDrop}), in the same ledger change as the key's credit;</li>
 * <li>only after a save wrote that ledger ({@code Stockpiles.saveWithWorld}) are the items spawned ({@link #spawnOwed}), each tagged with
 * its key, and saved at once: the entry leaves the ledger only in that save, once its chunk and entity writes are durable (before the ledger
 * write). A refused save discards them again (the entry stays owed: spawned after the next save);</li>
 * <li>a start finding an entry (that save stopped between its entity writes and its ledger write, or before them) resolves it by the tag:
 * items of the key loaded from disk ({@link ServerEntityEvents#ENTITY_LOAD}, before they can tick or merge) clear it; the drop chunk's
 * entities loaded with none spawns it. Never spawned before that.</li>
 * </ol>
 * The same window existed for every keyed refund (a single removal's deconstruct, a group member's, a road's, a delta's, a put-down's
 * take-ups, the start's pending credits, a region's keyed charge and scoop), not only a repair's booking: all go through it. Keyless
 * give-backs (a swap's old block, a bucket, RL's reconcile) still drop at once (leftover). Server thread.
 */
final class OverflowDrops {
	private OverflowDrops() {
	}

	static final String TAG = "architect_mc.ovf:";
	/** The drop chunk's ticket while an entry resolves (a holder: registered at init, never touched by the units). */
	private static final class Ticket {
		static final TicketType TICKET = net.minecraft.core.Registry.register(BuiltInRegistries.TICKET_TYPE, Architect.id("overflow"), new TicketType(
			0L, TicketType.FLAG_LOADING));
	}

	/** Overflow tags seen on items loaded this session (from disk or spawned). */
	private static final Set<String> SEEN = ConcurrentHashMap.newKeySet();
	/** Entries read from disk at the start ({@code pile|key}), not spawned until resolved by their tag. */
	private static final Set<String> RESOLVING = new HashSet<>();
	/** The chunks a resolving entry holds a ticket on ({@code pile|key} -> dim, chunk). */
	private static final Map<String, Object[]> TICKETS = new LinkedHashMap<>();
	/** The round being confirmed by the save {@link #spawnOwed} runs, or null. */
	private static @Nullable List<Spawned> confirming;
	private static boolean confirmed;
	private static boolean spawning;
	/** (dev) entries resolved at a start: found on disk (cleared) and spawned (not found). */
	static volatile int resolvedFound, resolvedSpawned;

	private record Spawned(Stockpiles.Pile p, String key, List<ItemEntity> entities, int units) {
	}

	static String tag(Stockpiles.Pile p, String key) {
		return TAG + p.id() + ":" + key;
	}

	static void init() {
		Architect.LOGGER.debug("DR2 overflow ticket {}", Ticket.TICKET);
		ServerEntityEvents.ENTITY_LOAD.register((e, level) -> {
			if (e instanceof ItemEntity) {
				for (String t : e.entityTags()) {
					if (t.startsWith(TAG)) {
						SEEN.add(t);
					}
				}
			}
		});
		ServerTickEvents.END_SERVER_TICK.register(OverflowDrops::resolve);
		ServerLifecycleEvents.SERVER_STOPPED.register(s -> {
			SEEN.clear();
			RESOLVING.clear();
			TICKETS.clear();
			confirming = null;
			spawning = false;
		});
	}

	/** At a load: every owed entry on disk waits for its resolution. */
	static void loaded(java.util.Collection<Stockpiles.Pile> piles) {
		RESOLVING.clear();
		TICKETS.clear();
		for (Stockpiles.Pile p : piles) {
			for (String key : p.ledger().owedDropKeys()) {
				RESOLVING.add(p.id() + "|" + key);
			}
		}
		if (!RESOLVING.isEmpty()) {
			Architect.LOGGER.warn("Stockpiles: {} refund overflow(s) owed at the start (a stop inside a credit's save): resolved by their items' tag",
				RESOLVING.size());
		}
	}

	/** (pure, the start's rule) What a resolving entry does: its items seen on disk: clear; its chunk's entities loaded without them: spawn. */
	enum Resolution {
		CLEAR, SPAWN, WAIT
	}

	static Resolution resolution(boolean seen, boolean entitiesLoaded) {
		return seen ? Resolution.CLEAR : entitiesLoaded ? Resolution.SPAWN : Resolution.WAIT;
	}

	/** Whether an entry may be spawned now (not one read from disk and still unresolved). */
	static boolean spawnable(String pileId, String key) {
		return !RESOLVING.contains(pileId + "|" + key);
	}

	private static void resolve(MinecraftServer srv) {
		if (RESOLVING.isEmpty()) {
			return;
		}
		boolean spawn = false;
		for (String rk : List.copyOf(RESOLVING)) {
			int bar = rk.indexOf('|');
			Stockpiles.Pile p = Stockpiles.byId(rk.substring(0, bar));
			String key = rk.substring(bar + 1);
			StockLedger.OwedDrop d = p == null ? null : p.ledger().owedDrop(key);
			if (d == null) {
				untrack(srv, rk);
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, p.dimension());
			if (level == null) {
				continue;
			}
			BlockPos at = BlockPos.of(d.at());
			ChunkPos cp = new ChunkPos(at.getX() >> 4, at.getZ() >> 4);
			if (!TICKETS.containsKey(rk)) {
				level.getChunkSource().addTicketWithRadius(Ticket.TICKET, cp, 0);
				TICKETS.put(rk, new Object[] {level, cp});
			}
			Resolution r = resolution(SEEN.contains(tag(p, key)), level.areEntitiesLoaded(cp.pack()));
			if (r == Resolution.WAIT) {
				continue;
			}
			untrack(srv, rk);
			if (r == Resolution.CLEAR) {
				p.ledger().clearOwedDrop(key);
				Stockpiles.changed(p);
				resolvedFound++;
				Architect.LOGGER.warn("Stockpile {}: refund {}'s overflow {} was on disk already (its items loaded): not dropped again", p.owner(), key, d
					.items());
			} else {
				resolvedSpawned++;
				spawn = true;
				Architect.LOGGER.warn("Stockpile {}: refund {}'s overflow {} never reached the disk: dropped now", p.owner(), key, d.items());
			}
		}
		if (spawn) {
			spawnOwed(srv);
		}
	}

	private static void untrack(MinecraftServer srv, String rk) {
		RESOLVING.remove(rk);
		Object[] t = TICKETS.remove(rk);
		if (t != null) {
			((ServerLevel) t[0]).getChunkSource().removeTicketWithRadius(Ticket.TICKET, (ChunkPos) t[1], 0);
		}
	}

	/**
	 * After a save wrote the ledger: every owed overflow (not one still resolving) spawned, tagged, then saved with the world; the entries
	 * leave the ledger in that save, after its chunk and entity writes are durable. A refused save discards the items again.
	 */
	static void spawnOwed(MinecraftServer srv) {
		if (spawning || srv == null || !srv.isSameThread() || Stockpiles.savingOff(srv) != null) {
			return; // (/save-off: the items' save would write nothing; they stay owed until saving is on)
		}
		List<Spawned> round = new ArrayList<>();
		for (Stockpiles.Pile p : Stockpiles.all()) {
			for (String key : p.ledger().owedDropKeys()) {
				StockLedger.OwedDrop d = p.ledger().owedDrop(key);
				ServerLevel level = d == null || !spawnable(p.id(), key) ? null : Sites.levelOf(srv, p.dimension());
				if (level == null) {
					continue;
				}
				List<ItemEntity> es = new ArrayList<>();
				int n = spawn(level, BlockPos.of(d.at()), d.items(), tag(p, key), es);
				Stockpiles.OVERFLOW_DROPPED.merge(p.id(), n, Integer::sum);
				round.add(new Spawned(p, key, es, n));
			}
		}
		if (round.isEmpty()) {
			return;
		}
		spawning = true;
		confirming = round;
		confirmed = false;
		try {
			Stockpiles.saveWithWorld(srv);
		} catch (RuntimeException e) {
			Architect.LOGGER.error("Stockpiles: the overflow's save was refused ({}); its items are taken back and dropped after the next save",
				e.getMessage());
		} finally {
			spawning = false;
			confirming = null;
		}
		if (!confirmed) {
			for (Spawned s : round) {
				s.entities().forEach(ItemEntity::discard);
				Stockpiles.OVERFLOW_DROPPED.merge(s.p().id(), -s.units(), Integer::sum);
			}
		}
	}

	/** Inside {@link #spawnOwed}'s save, its chunk and entity writes durable, before the ledger write: the round's entries go. */
	static boolean confirm() {
		List<Spawned> r = confirming;
		if (r == null) {
			return false;
		}
		for (Spawned s : r) {
			s.p().ledger().clearOwedDrop(s.key());
			Stockpiles.changed(s.p());
		}
		confirmed = true;
		confirming = null;
		return true;
	}

	private static int spawn(ServerLevel level, BlockPos at, Map<String, Integer> items, String tag, List<ItemEntity> out) {
		int n = 0;
		for (var e : items.entrySet()) {
			Item it = Cells.item(e.getKey());
			if (it == null || e.getValue() <= 0) {
				continue;
			}
			int left = e.getValue();
			int max = new ItemStack(it).getMaxStackSize();
			while (left > 0) {
				int c = Math.min(max, left);
				left -= c;
				ItemEntity ie = new ItemEntity(level, at.getX() + 0.5, at.getY() + 0.25, at.getZ() + 0.5, new ItemStack(it, c), 0, 0, 0);
				ie.setDefaultPickUpDelay();
				ie.addTag(tag);
				level.addFreshEntity(ie);
				out.add(ie);
				n += c;
			}
		}
		return n;
	}
}
