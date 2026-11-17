package dev.larattalabs.architect.site;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.survival.CrateBlockEntity;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import org.jspecify.annotations.Nullable;

/**
 * (Slice CXD, docs/CONTRACT.md "Slice CXD") Durable crate extraction: before a removal takes a crate's stock, the stock is written as a
 * keyed owed record (in {@code stockpiles.json}, {@code crateOwed}) and saved confirmed; only then is the crate emptied (its ledger, plus
 * the {@link CrateBlockEntity#taken} marker, in the same chunk). The record settles once, when the removal's member is restored (the
 * stock drops at the crate's cell, as before); a removal that ends before its commit puts the stock back; at the next start every open
 * record is resolved against the crate's actual state ({@link #resolve}). The group queue never carries crate stock. Server thread.
 */
final class CrateOwed {
	private CrateOwed() {
	}

	/** One owed record: {@code items} taken (or about to be) from the crate of {@code crateOwner} at {@code crate} by the removal of {@code siteKey}. */
	record Rec(String key, String site, String siteKey, String crateOwner, String dim, Construction.Crate crate, Map<String, Integer> items) {
		Rec {
			items = Map.copyOf(new TreeMap<>(items));
		}

		BlockPos pos() {
			return new BlockPos(crate.x(), crate.y(), crate.z());
		}

		boolean shared() {
			return crateOwner.startsWith(SiteGroupRec.CRATE_PREFIX);
		}

		JsonObject toJson() {
			JsonObject o = new JsonObject();
			o.addProperty("key", key);
			o.addProperty("site", site);
			o.addProperty("siteKey", siteKey);
			o.addProperty("crateOwner", crateOwner);
			o.addProperty("dim", dim);
			o.add("crate", crate.toJson());
			JsonObject it = new JsonObject();
			items.forEach(it::addProperty);
			o.add("items", it);
			return o;
		}

		static Rec fromJson(JsonObject o) {
			Map<String, Integer> items = new TreeMap<>();
			o.getAsJsonObject("items").entrySet().forEach(e -> items.put(e.getKey(), e.getValue().getAsInt()));
			return new Rec(o.get("key").getAsString(), o.get("site").getAsString(), o.get("siteKey").getAsString(), o.get("crateOwner").getAsString(),
				o.get("dim").getAsString(), Construction.Crate.fromJson(o.getAsJsonObject("crate")), items);
		}
	}

	/** The crate's state at the record's cell, as the resolution reads it. */
	enum CrateState {
		/** The crate stands with this record's marker: its stock was taken. */
		MARKED,
		/** The crate stands without the marker: nothing was taken (or it was put back). */
		PRESENT,
		/** No crate of this owner there: the cell was restored after the take (a chunk save is a snapshot). */
		ABSENT
	}

	/** What a resolution does with one record (the record is closed after any of them; a {@code retake} first marks the crate's stock taken). */
	record Outcome(boolean putBack, boolean retake, boolean drop, boolean restoreCell) {
	}

	/**
	 * The resolution table (pure: the units' seam). {@code stands}: the site the removal takes down is still live (not pending, not
	 * released). {@code found}: the record's tagged drop is already in the world (its entities loaded from disk): paid, so nothing drops
	 * again. A drop pays the record's items only: a crate still holding stock is first retaken (its stock into the record, the marker set,
	 * saved) so the stock is never in the crate and on the ground at once.
	 */
	static Outcome resolve(boolean stands, CrateState c, boolean found) {
		if (found) {
			return new Outcome(false, false, false, !stands && c == CrateState.MARKED);
		}
		return switch (c) {
			case MARKED -> stands ? new Outcome(true, false, false, false) : new Outcome(false, false, true, true);
			case PRESENT -> stands ? new Outcome(false, false, false, false) : new Outcome(false, true, true, true);
			case ABSENT -> new Outcome(false, false, true, false);
		};
	}

	/** {@link #resolve} with nothing found. */
	static Outcome resolve(boolean stands, CrateState c) {
		return resolve(stands, c, false);
	}

	/** The entity tag of a record's drop: an item entity loaded with it proves the drop reached the disk. */
	static final String TAG = "architect_cxd:";

	/** The open records, by key (saved in stockpiles.json). */
	private static final Map<String, Rec> OPEN = new LinkedHashMap<>();
	/** Captured this call, not saved or taken yet: {@link #commit} or {@link #dropPending}. */
	private static final List<Rec> PENDING = new ArrayList<>();
	/** Records whose drop state is known: made this session, or their chunk's entities loaded (no tagged drop dropped since unknown). */
	private static final Set<String> CHECKED = new HashSet<>();
	/** Records whose tagged drop loaded from disk (paid). */
	private static final Set<String> FOUND = new HashSet<>();
	/** (P1-3) Captures whose save was IN_DOUBT: possibly on disk, cancelled only by a confirmed write; their crates fenced meanwhile. */
	private static final Set<String> CANCELLING = new HashSet<>();
	/** Records no live removal owns (loaded at the start, or a held settle of a removal that went on): the tick resolves them. */
	private static final Set<String> IDLE = new HashSet<>();
	/** Records whose chunk this holds loaded (until resolved). */
	private static final Map<String, ServerLevel> TICKETED = new LinkedHashMap<>();
	/** (dev) this session's resolutions: "key STATE stands|removed found? outcome". */
	static final List<String> LAST = new ArrayList<>();
	/** (TEST, dev) records settled, put back and resolved at the start this session; held settles. */
	static volatile int settled, putBack, resolvedAtStart, held;
	/** (TEST, dev.stockpile.owed) the next confirmed save's outcome forced (after a real barrier): IN_DOUBT or REFUSED. */
	static volatile DurableFile.@Nullable Outcome testForce;
	/** (TEST, dev.stockpile.owed failDrops) the next n drop barriers count as refused (after the real write): the settle is held. */
	static volatile int testFailDrops;
	private static long tick;
	private static final Map<String, Long> HELD_AT = new LinkedHashMap<>();

	/** The chunk ticket that holds an unchecked record's chunk loaded (its own holder: registered at mod init, never in unit tests). */
	static final class Ticket {
		static final net.minecraft.server.level.TicketType TICKET = net.minecraft.core.Registry.register(
			net.minecraft.core.registries.BuiltInRegistries.TICKET_TYPE, Architect.id("crate_owed"),
			new net.minecraft.server.level.TicketType(0L, net.minecraft.server.level.TicketType.FLAG_LOADING | net.minecraft.server.level.TicketType.FLAG_SIMULATION));

		private Ticket() {
		}
	}

	/** Registered at mod init (Stockpiles.init): an item entity with a record's tag that loads marks that record's drop as on disk. */
	static void init() {
		java.util.Objects.requireNonNull(Ticket.TICKET); // registered now, before the registries freeze
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents.ENTITY_LOAD.register((e, level) -> {
			if (!(e instanceof net.minecraft.world.entity.item.ItemEntity) || OPEN.isEmpty()) {
				return;
			}
			for (String t : e.entityTags()) {
				if (t.startsWith(TAG) && OPEN.containsKey(t.substring(TAG.length())) && !CHECKED.contains(t.substring(TAG.length()))) {
					FOUND.add(t.substring(TAG.length()));
				}
			}
		});
	}

	static boolean none() {
		return OPEN.isEmpty();
	}

	static List<Rec> open() {
		return List.copyOf(OPEN.values());
	}

	static boolean pending() {
		return !PENDING.isEmpty();
	}

	static String key(String crateOwner, BlockPos pos, String siteKey) {
		return "crate:" + crateOwner + "@" + pos.getX() + "," + pos.getY() + "," + pos.getZ() + "/" + siteKey;
	}

	/**
	 * Whether the crate of {@code crateOwner} at {@code pos} is fenced: an open record of it is not yet resolved against its drop (loaded at the
	 * start), its capture's save was IN_DOUBT, or its stock was taken. A fenced crate takes no item and feeds no build (no consumption, no
	 * completion), so a record never pays stock the crate gave elsewhere.
	 */
	static boolean fenced(String crateOwner, BlockPos pos) {
		if (OPEN.isEmpty()) {
			return false;
		}
		for (Rec r : OPEN.values()) {
			if (r.crateOwner().equals(crateOwner) && r.pos().equals(pos) && !PENDING.contains(r)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Step 1: a removal's deconstruct of {@code s} captures its crate's stock as a record (in memory; the crate untouched). Returns the record
	 * (its items are the stock the deconstruct reports), or null when the crate holds nothing (then nothing is owed). A record of this key
	 * whose stock the crate already gave (its marker) is returned as it is: never taken twice.
	 */
	static @Nullable Rec capture(ServerLevel level, Site s, String crateOwner, Construction.Crate cell, CrateBlockEntity crate) {
		String siteKey = Builder.creditKey(s);
		String key = key(crateOwner, crate.getBlockPos(), siteKey);
		Rec had = OPEN.get(key);
		if (had != null && key.equals(crate.taken())) {
			return had;
		}
		Map<String, Integer> stock = stockOf(crate);
		if (stock.isEmpty()) {
			return null;
		}
		Rec r = new Rec(key, s.id(), siteKey, crateOwner, Sites.dimensionId(level), cell, stock);
		OPEN.put(key, r);
		CHECKED.add(key);
		CANCELLING.remove(key);
		IDLE.remove(key);
		PENDING.removeIf(p -> p.key().equals(key));
		PENDING.add(r);
		Stockpiles.unsaved = true;
		return r;
	}

	private static Map<String, Integer> stockOf(CrateBlockEntity crate) {
		Map<String, Integer> stock = new TreeMap<>();
		crate.ledger().stock().forEach((k, v) -> {
			if (v > 0) {
				stock.put(k, v);
			}
		});
		return stock;
	}

	/**
	 * Steps 2 and 3: the captures saved confirmed ({@link #confirmed}: T0's barrier), then each crate's stock taken (its ledger, the
	 * marker; the crate block stays until the settle). REFUSED: the captures dropped (not on disk). IN_DOUBT (P1-3): they may be on disk, so
	 * they stay open and fenced until a confirmed write cancels them ({@link #tick}). Either throws: the removal is refused untouched.
	 */
	static void commit(MinecraftServer srv) {
		if (PENDING.isEmpty()) {
			return;
		}
		WorldJournal.kill("CXD1"); // (TEST) captured, the record not saved
		DurableFile.Outcome o = barrier(srv);
		if (o != DurableFile.Outcome.OK) {
			if (o == DurableFile.Outcome.IN_DOUBT) {
				for (Rec r : PENDING) {
					CANCELLING.add(r.key());
				}
				PENDING.clear();
			} else {
				dropPending();
			}
			throw new IllegalStateException("Stockpiles: the crate's owed record was not confirmed on disk (" + o + ")");
		}
		WorldJournal.kill("CXD2"); // (TEST) the record saved, the crate not emptied
		for (Rec r : List.copyOf(PENDING)) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			CrateBlockEntity crate = level == null ? null : crateAt(level, r);
			if (crate == null) {
				OPEN.remove(r.key()); // (the same tick as the capture: it can't go; nothing taken)
				continue;
			}
			keepDelivered(srv, r, crate);
			crate.ledger().takeStock();
			crate.setTaken(r.key());
		}
		PENDING.clear();
		WorldJournal.kill("CXD3"); // (TEST) the stock taken, the removal not committed
	}

	/** The captures of a removal that was refused before its save: dropped (never written, the crates never touched). */
	static void dropPending() {
		for (Rec r : PENDING) {
			OPEN.remove(r.key());
		}
		if (!PENDING.isEmpty()) {
			Stockpiles.unsaved = true;
		}
		PENDING.clear();
	}

	/** What a settle gave back, and whether it is held (a save not confirmed, or its drop not checked yet): then nothing of it changed. */
	record Settle(Map<String, Integer> given, boolean held) {
	}

	/**
	 * Step 5: the removal of {@code siteKey} committed: each of its open records settles once, BEFORE the member's own restore and refunds
	 * (P1-1: its saves persist nothing of them). Held: the caller retries (Groups keeps the member; a synchronous removal leaves the record
	 * to the tick, {@link #IDLE}).
	 */
	static Settle settle(ServerLevel level, String siteKey, Sites.@Nullable Drops drops) {
		List<Rec> rs = OPEN.values().stream().filter(r -> r.siteKey().equals(siteKey)).toList();
		if (rs.isEmpty()) {
			return new Settle(Map.of(), false);
		}
		Long last = HELD_AT.get(siteKey);
		if (last != null && tick - last < 20) {
			return new Settle(Map.of(), true); // a held settle tries again once a second
		}
		WorldJournal.kill("CXD4"); // (TEST) committed, the stock not settled
		Settle out = resolveAll(level.getServer(), rs, r -> false, drops);
		if (out.held()) {
			HELD_AT.put(siteKey, tick);
			held++;
		} else {
			HELD_AT.remove(siteKey);
			settled += rs.size();
		}
		return out;
	}

	/** A removal that ended before its commit: the records of its sites ({@code siteIds}) put back (resolved as standing); held: the tick. */
	static void putBackSites(MinecraftServer srv, Collection<String> siteIds) {
		dropPending();
		List<Rec> rs = OPEN.values().stream().filter(r -> siteIds.contains(r.site()) && !CANCELLING.contains(r.key())).toList();
		if (!rs.isEmpty()) {
			if (resolveAll(srv, rs, r -> true, null).held()) {
				rs.forEach(r -> IDLE.add(r.key()));
			}
			putBack += rs.size();
		}
	}

	/** A synchronous removal went on past a held settle: its records are the tick's. */
	static void idle(String siteKey) {
		OPEN.values().stream().filter(r -> r.siteKey().equals(siteKey)).forEach(r -> IDLE.add(r.key()));
	}

	/** At the world's start (the first tick, after Sites.reconcile): every open record unchecked and idle; the tick resolves each. */
	static void atStart(MinecraftServer srv) {
		PENDING.clear();
		CHECKED.clear();
		CANCELLING.clear();
		IDLE.clear();
		IDLE.addAll(OPEN.keySet());
		resolvedAtStart += 0;
	}

	/**
	 * Each server tick: a leftover capture dropped; IN_DOUBT captures cancelled by a confirmed write (once a second); each unchecked record's
	 * chunk held loaded until its entities are loaded (a tagged drop loading marks it found), then checked; idle checked records resolved.
	 */
	static void tick(MinecraftServer srv) {
		tick++;
		if (!PENDING.isEmpty()) {
			Architect.LOGGER.warn("Crate stock: a capture was left uncommitted by its removal; dropped (the crate was never touched)");
			dropPending();
		}
		if (OPEN.isEmpty()) {
			releaseTickets(srv);
			return;
		}
		if (!CANCELLING.isEmpty() && tick % 20 == 0) {
			Map<String, Rec> back = new LinkedHashMap<>();
			for (String k : CANCELLING) {
				Rec r = OPEN.remove(k);
				if (r != null) {
					back.put(k, r);
				}
			}
			Stockpiles.unsaved = true;
			DurableFile.Outcome o = barrier(srv);
			if (o == DurableFile.Outcome.OK) {
				Architect.LOGGER.info("Crate stock: {} capture(s) whose save was in doubt cancelled (confirmed)", back.size());
				CANCELLING.clear();
			} else {
				OPEN.putAll(back); // still possibly on disk: fenced, tried again
			}
		}
		for (Rec r : List.copyOf(OPEN.values())) {
			if (CHECKED.contains(r.key()) || CANCELLING.contains(r.key())) {
				continue;
			}
			ServerLevel level = Sites.levelOf(srv, r.dim());
			if (level == null) {
				continue; // unverifiable: open and fenced
			}
			net.minecraft.world.level.ChunkPos cp = new net.minecraft.world.level.ChunkPos(r.pos().getX() >> 4, r.pos().getZ() >> 4);
			if (TICKETED.put(r.key(), level) == null) {
				level.getChunkSource().addTicketWithRadius(Ticket.TICKET, cp, 1);
			}
			if (level.isLoaded(r.pos()) && level.areEntitiesLoaded(cp.pack())) {
				CHECKED.add(r.key()); // its chunk's entities are in: a tagged drop would have loaded by now
			}
		}
		if (tick % 20 == 0) {
			List<Rec> idle = OPEN.values().stream().filter(r -> IDLE.contains(r.key()) && CHECKED.contains(r.key()) && !CANCELLING.contains(r.key())
				&& !Groups.holds(r.site())).toList();
			if (!idle.isEmpty()) {
				Settle st = resolveAll(srv, idle, CrateOwed::stands, null);
				if (!st.held()) {
					resolvedAtStart += idle.size();
				}
			}
		}
		releaseTickets(srv);
	}

	private static void releaseTickets(MinecraftServer srv) {
		for (var it = TICKETED.entrySet().iterator(); it.hasNext();) {
			var e = it.next();
			if (!OPEN.containsKey(e.getKey()) || CHECKED.contains(e.getKey()) && !IDLE.contains(e.getKey())) {
				Rec r = null;
				String k = e.getKey();
				int x = keyX(k), z = keyZ(k);
				e.getValue().getChunkSource().removeTicketWithRadius(Ticket.TICKET, new net.minecraft.world.level.ChunkPos(x >> 4, z >> 4), 1);
				it.remove();
			}
		}
	}

	private static int keyX(String key) {
		String p = key.substring(key.lastIndexOf('@', key.indexOf('/')) + 1, key.indexOf('/'));
		return Integer.parseInt(p.split(",")[0]);
	}

	private static int keyZ(String key) {
		String p = key.substring(key.lastIndexOf('@', key.indexOf('/')) + 1, key.indexOf('/'));
		return Integer.parseInt(p.split(",")[2]);
	}

	/** Whether the site {@code r} takes down is still live: its record with that placement, not pending removal. */
	static boolean stands(Rec r) {
		Site s = Sites.get(r.site());
		return s != null && r.siteKey().equals(Builder.creditKey(s)) && Sites.pendingRecord(r.site()) == null;
	}

	/**
	 * (P1-2) A right-click on a crate no building site owns: an open record of that crate is resolved by the table (never paid apart from
	 * it); a crate holding stock with no record becomes one (saved confirmed, taken) and pays through the same drop. Returns a message for
	 * the player, or null when the crate holds nothing and no record names it (the caller takes it away as before).
	 */
	static @Nullable String claimOrphan(ServerLevel level, CrateBlockEntity crate) {
		MinecraftServer srv = level.getServer();
		BlockPos p = crate.getBlockPos();
		List<Rec> rs = OPEN.values().stream().filter(r -> r.crateOwner().equals(crate.siteId()) && r.pos().equals(p)).toList();
		if (rs.isEmpty()) {
			Map<String, Integer> stock = stockOf(crate);
			if (stock.isEmpty()) {
				return null;
			}
			String sk = "orphan:" + level.getGameTime();
			Rec r = new Rec(key(crate.siteId(), p, sk), crate.siteId(), sk, crate.siteId(), Sites.dimensionId(level),
				new Construction.Crate(p.getX(), p.getY(), p.getZ(), "{Name:\"minecraft:air\"}", null), stock);
			OPEN.put(r.key(), r);
			CHECKED.add(r.key());
			Stockpiles.unsaved = true;
			if (barrier(srv) != DurableFile.Outcome.OK) {
				OPEN.remove(r.key());
				CHECKED.remove(r.key());
				// (in doubt: the record may be on disk; the crate untouched holds the stock: the start finds it PRESENT and its site gone and
				// retakes it once)
				Stockpiles.unsaved = true;
				return "This crate's stock could not be recorded (a save was refused); try again";
			}
			crate.ledger().takeStock();
			crate.setTaken(r.key());
			rs = List.of(r);
		}
		if (rs.stream().anyMatch(r -> !CHECKED.contains(r.key()) || CANCELLING.contains(r.key()))) {
			return "This crate's stock is being checked after the world's start; try again in a moment";
		}
		Settle st = resolveAll(srv, rs, CrateOwed::stands, null);
		return st.held() ? "This crate's stock could not be given back now (a save was refused); it is kept and tried again"
			: "This crate belongs to no construction site; it gave back what it held";
	}

	/**
	 * Resolves {@code rs} by the table ({@link #resolve}). Order, each step saved through T0's barrier before the next mutates anything:
	 * whatever is pending first (not OK: held, nothing changed); the put-backs and closes (the crate's ledger, the marker; chunks before the
	 * ledger: a crash between leaves PRESENT and an open record, closed at the next start); the retakes (a crate still holding stock: its stock
	 * into the record, marked; not OK: held, the take stays); then the drops, tagged with the record's key, the records closed in memory and
	 * one barrier: OK, then the cells restored; not OK, the drop is taken back (its entities discarded) and the records reopen (held). A
	 * crash inside that barrier leaves the tagged entities and the open record: the start finds the drop ({@link #FOUND}) and pays nothing
	 * again. Never a loss, never a dupe.
	 */
	private static Settle resolveAll(MinecraftServer srv, List<Rec> rs, java.util.function.Predicate<Rec> stands, Sites.@Nullable Drops drops) {
		if (rs.stream().anyMatch(r -> !CHECKED.contains(r.key()) || CANCELLING.contains(r.key()))) {
			return new Settle(Map.of(), true);
		}
		if (Stockpiles.unsaved && barrier(srv) != DurableFile.Outcome.OK) {
			Architect.LOGGER.error("Crate stock: {} owed record(s) held (the save before them was not confirmed)", rs.size());
			return new Settle(Map.of(), true);
		}
		List<Rec> drop = new ArrayList<>();
		List<Rec> retake = new ArrayList<>();
		Map<Rec, Outcome> outs = new LinkedHashMap<>();
		boolean back = false;
		for (Rec r : rs) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			if (level == null) {
				continue; // unverifiable: left open
			}
			CrateBlockEntity crate = crateAt(level, r);
			CrateState st = crate == null ? CrateState.ABSENT : r.key().equals(crate.taken()) ? CrateState.MARKED : CrateState.PRESENT;
			boolean sd = stands.test(r);
			boolean found = FOUND.contains(r.key());
			Outcome o = resolve(sd, st, found);
			Architect.LOGGER.info("Crate stock: owed record {} ({} items, crate {}, site {}{}): {}", r.key(), total(r.items()), st, sd ? "stands" : "removed",
				found ? ", its drop found" : "", o);
			LAST.add(r.key() + " " + st + " " + (sd ? "stands" : "removed") + (found ? " found" : "") + " " + (o.putBack() ? "putBack" : o.retake()
				? "retake+drop" : o.drop() ? "drop" : "close"));
			if (o.putBack()) {
				crate.ledger().restoreStock(r.items());
				crate.setTaken("");
				OPEN.remove(r.key());
				back = true;
			} else if (!o.drop()) {
				if (found && crate != null) {
					if (sd) {
						crate.setTaken(""); // paid on the ground: the standing site's crate takes items again (its stock stays 0)
					} else if (o.restoreCell()) {
						restoreCell(srv, level, r);
					}
				}
				OPEN.remove(r.key()); // nothing (more) to pay: closed
				FOUND.remove(r.key());
				back = true;
			} else {
				(o.retake() ? retake : drop).add(r);
				outs.put(r, o);
			}
		}
		if (back) {
			Stockpiles.unsaved = true;
			WorldJournal.kill("CXDB"); // (TEST) put back or closed in memory, before its save
			if (barrier(srv) != DurableFile.Outcome.OK) {
				Architect.LOGGER.error("Crate stock: the put-back's save was not confirmed; the next start resolves the record again");
			}
		}
		if (!retake.isEmpty()) {
			for (Rec r : retake) {
				ServerLevel level = Sites.levelOf(srv, r.dim());
				CrateBlockEntity crate = crateAt(level, r);
				keepDelivered(srv, r, crate);
				Map<String, Integer> stock = stockOf(crate);
				crate.ledger().takeStock();
				crate.setTaken(r.key());
				Rec now = new Rec(r.key(), r.site(), r.siteKey(), r.crateOwner(), r.dim(), r.crate(), stock);
				OPEN.put(r.key(), now);
				drop.add(now);
				outs.put(now, outs.get(r));
			}
			Stockpiles.unsaved = true;
			if (barrier(srv) != DurableFile.Outcome.OK) {
				// the take stays (in memory: MARKED with the record; on disk either side of it resolves to the same once): held
				Architect.LOGGER.error("Crate stock: a retake's save was not confirmed; held");
				return new Settle(Map.of(), true);
			}
		}
		Map<String, Integer> given = new TreeMap<>();
		if (drop.isEmpty()) {
			return new Settle(given, false);
		}
		List<net.minecraft.world.entity.item.ItemEntity> spawned = new ArrayList<>();
		for (Rec r : drop) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			spawned.addAll(dropTagged(level, r, drops));
			OPEN.remove(r.key());
		}
		Stockpiles.unsaved = true;
		WorldJournal.kill("CXDS"); // (TEST) dropped (tagged) and closed in memory, before the barrier that saves both
		DurableFile.Outcome dropSaved = barrier(srv);
		if (testFailDrops > 0) {
			testFailDrops--;
			dropSaved = DurableFile.Outcome.REFUSED; // (TEST) the drop's barrier refused (after the real write)
		}
		if (dropSaved != DurableFile.Outcome.OK) {
			for (var e : spawned) {
				e.discard(); // taken back: never on the ground and owed at once in this session
			}
			for (Rec r : drop) {
				OPEN.put(r.key(), r);
			}
			Stockpiles.unsaved = true;
			Architect.LOGGER.error("Crate stock: the drop's save was not confirmed; {} record(s) stay owed and are tried again", drop.size());
			return new Settle(Map.of(), true);
		}
		for (Rec r : drop) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			if (outs.get(r).restoreCell()) {
				restoreCell(srv, level, r);
			}
			FOUND.remove(r.key());
			r.items().forEach((k, v) -> given.merge(k, v, Integer::sum));
		}
		Stockpiles.unsaved = true; // the cells restored: saved with the next save (a crash first leaves an empty marked crate, no record: no items)
		return new Settle(given, false);
	}

	/** The record's items dropped at its crate's cell, each entity tagged with the record's key. */
	private static List<net.minecraft.world.entity.item.ItemEntity> dropTagged(ServerLevel level, Rec r, Sites.@Nullable Drops drops) {
		List<net.minecraft.world.entity.item.ItemEntity> out = new ArrayList<>();
		BlockPos at = r.pos();
		for (var e : r.items().entrySet()) {
			net.minecraft.world.item.Item it = Cells.item(e.getKey());
			if (it == null || e.getValue() <= 0) {
				continue;
			}
			int left = e.getValue();
			int max = new net.minecraft.world.item.ItemStack(it).getMaxStackSize();
			while (left > 0) {
				int n = Math.min(max, left);
				left -= n;
				var ie = new net.minecraft.world.entity.item.ItemEntity(level, at.getX() + 0.5, at.getY() + 0.25, at.getZ() + 0.5,
					new net.minecraft.world.item.ItemStack(it, n), 0, 0, 0);
				ie.setDefaultPickUpDelay();
				ie.addTag(TAG + r.key());
				level.addFreshEntity(ie);
				if (drops != null) {
					drops.keep(ie);
				}
				out.add(ie);
			}
		}
		return out;
	}

	/** The crate's cell back to its snapshot (a marked crate), the shared crate's journal entry released. */
	private static void restoreCell(MinecraftServer srv, ServerLevel level, Rec r) {
		if (crateAt(level, r) != null) {
			Builder.restoreCrateCell(level, r.crate());
		}
		if (r.shared()) {
			SiteJournal.releaseKind(r.crateOwner(), WorldJournal.CRATE); // the group's crate went (its own entry, phase 4e)
		}
	}

	/** T0's barrier (players, chunks, the ledger); its outcome ({@link #testForce} overrides the next one, after the real write). */
	static DurableFile.Outcome barrier(MinecraftServer srv) {
		DurableBarrier.Result r = Stockpiles.barrier(srv);
		DurableFile.Outcome f = testForce;
		if (f != null) {
			testForce = null;
			Architect.LOGGER.warn("Crate stock: TEST: this barrier's outcome forced to {} (was {})", f, r.outcome());
			return f;
		}
		if (!r.ok()) {
			Architect.LOGGER.error("Crate stock: barrier {} ({})", r.outcome(), r.reason());
		}
		return r.outcome();
	}

	/** The crate of {@code r}'s owner at its cell (its chunk loaded), or null. */
	static @Nullable CrateBlockEntity crateAt(ServerLevel level, Rec r) {
		return level.getBlockEntity(r.pos()) instanceof CrateBlockEntity be && r.crateOwner().equals(be.siteId()) ? be : null;
	}

	/** A shared crate about to be emptied: its delivered counts stay on the group record ({@code Sites.stock} after the build). */
	private static void keepDelivered(MinecraftServer srv, Rec r, CrateBlockEntity crate) {
		SiteGroupRec g = r.shared() ? Sites.group(r.crateOwner().substring(SiteGroupRec.CRATE_PREFIX.length())) : null;
		if (g != null) {
			Sites.putGroup(srv, g.withDelivered(crate.ledger().delivered()));
		}
	}

	static int total(Map<String, Integer> m) {
		return m.values().stream().mapToInt(Integer::intValue).sum();
	}

	// ------------------------------------------------------------------ persistence (Stockpiles' file)

	static void clear() {
		OPEN.clear();
		PENDING.clear();
		CHECKED.clear();
		FOUND.clear();
		CANCELLING.clear();
		IDLE.clear();
		HELD_AT.clear();
	}

	static void write(JsonObject root) {
		if (OPEN.isEmpty()) {
			return;
		}
		JsonArray a = new JsonArray();
		OPEN.values().forEach(r -> a.add(r.toJson()));
		root.add("crateOwed", a);
	}

	static void read(JsonObject root) {
		clear();
		if (root.has("crateOwed")) {
			for (JsonElement e : root.getAsJsonArray("crateOwed")) {
				Rec r = Rec.fromJson(e.getAsJsonObject());
				OPEN.put(r.key(), r);
			}
		}
	}

	/** Dev: the open records and the counters. */
	static JsonObject json() {
		JsonObject o = new JsonObject();
		JsonArray a = new JsonArray();
		OPEN.values().forEach(r -> a.add(r.toJson()));
		o.add("open", a);
		o.addProperty("pending", PENDING.size());
		o.addProperty("settled", settled);
		o.addProperty("putBack", putBack);
		o.addProperty("resolvedAtStart", resolvedAtStart);
		o.addProperty("held", held);
		o.addProperty("unchecked", OPEN.keySet().stream().filter(k -> !CHECKED.contains(k)).count());
		o.addProperty("cancelling", CANCELLING.size());
		o.addProperty("found", FOUND.size());
		JsonArray l = new JsonArray();
		LAST.forEach(l::add);
		o.add("resolutions", l);
		return o;
	}

	/** Test: the keys of the open records. */
	static Set<String> keys() {
		return new HashSet<>(OPEN.keySet());
	}
}
