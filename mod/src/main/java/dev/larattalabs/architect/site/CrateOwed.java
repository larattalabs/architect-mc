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

	/** What a resolution does with one record. */
	record Outcome(boolean putBack, boolean dropRecord, boolean dropCrateStock, boolean restoreCell) {
	}

	/**
	 * The resolution table (pure: the units' seam). {@code stands}: the site the removal takes down is still live (not pending, not
	 * released). A record is closed after any outcome.
	 */
	static Outcome resolve(boolean stands, CrateState c) {
		return switch (c) {
			case MARKED -> stands ? new Outcome(true, false, false, false) : new Outcome(false, true, true, true);
			case PRESENT -> stands ? new Outcome(false, false, false, false) : new Outcome(false, false, true, true);
			case ABSENT -> new Outcome(false, true, false, false);
		};
	}

	/** The open records, by key (saved in stockpiles.json). */
	private static final Map<String, Rec> OPEN = new LinkedHashMap<>();
	/** Captured this call, not saved or taken yet: {@link #commit} or {@link #dropPending}. */
	private static final List<Rec> PENDING = new ArrayList<>();
	/** (TEST, dev) records settled, put back and resolved at the start this session. */
	static volatile int settled, putBack, resolvedAtStart;

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
		Map<String, Integer> stock = new TreeMap<>();
		crate.ledger().stock().forEach((k, v) -> {
			if (v > 0) {
				stock.put(k, v);
			}
		});
		if (stock.isEmpty()) {
			return null;
		}
		Rec r = new Rec(key, s.id(), siteKey, crateOwner, Sites.dimensionId(level), cell, stock);
		OPEN.put(key, r);
		PENDING.removeIf(p -> p.key().equals(key));
		PENDING.add(r);
		Stockpiles.unsaved = true;
		return r;
	}

	/**
	 * Steps 2 and 3: the captures saved confirmed ({@link Stockpiles#saveConfirmed}), then each crate's stock taken (its ledger, the
	 * marker; the crate block stays until the settle). A refused save drops the captures (nothing was taken) and throws.
	 */
	static void commit(MinecraftServer srv) {
		if (PENDING.isEmpty()) {
			return;
		}
		WorldJournal.kill("CXD1"); // (TEST) captured, the record not saved
		try {
			Stockpiles.saveConfirmed(srv);
		} catch (IllegalStateException e) {
			dropPending();
			throw e;
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

	/** The captures of a removal that was refused before {@link #commit}: dropped (the crates were never touched). */
	static void dropPending() {
		for (Rec r : PENDING) {
			OPEN.remove(r.key());
		}
		if (!PENDING.isEmpty()) {
			Stockpiles.unsaved = true;
		}
		PENDING.clear();
	}

	/**
	 * Step 5: the removal of {@code siteKey} committed and its member restored: each of its open records settles once (the stock drops at
	 * the crate's cell, the crate cell restored). Returns what was given back.
	 */
	static Map<String, Integer> settle(ServerLevel level, String siteKey, Sites.@Nullable Drops drops) {
		List<Rec> rs = OPEN.values().stream().filter(r -> r.siteKey().equals(siteKey)).toList();
		if (rs.isEmpty()) {
			return Map.of();
		}
		WorldJournal.kill("CXD4"); // (TEST) committed and restored, the stock not settled
		Map<String, Integer> out = resolveAll(level.getServer(), rs, r -> false, drops);
		settled += rs.size();
		return out;
	}

	/** A removal that ended before its commit: the records of its sites ({@code siteIds}) put back (resolved as standing). */
	static void putBackSites(MinecraftServer srv, Collection<String> siteIds) {
		dropPending();
		List<Rec> rs = OPEN.values().stream().filter(r -> siteIds.contains(r.site())).toList();
		if (!rs.isEmpty()) {
			resolveAll(srv, rs, r -> true, null);
			putBack += rs.size();
		}
	}

	/** At the world's start (the first tick, after Sites.reconcile): every open record resolved against its crate and its site. */
	static void atStart(MinecraftServer srv) {
		PENDING.clear();
		List<Rec> rs = List.copyOf(OPEN.values());
		if (rs.isEmpty()) {
			return;
		}
		resolveAll(srv, rs, CrateOwed::stands, null);
		resolvedAtStart += rs.size();
	}

	/** Whether the site {@code r} takes down is still live: its record with that placement, not pending removal. */
	static boolean stands(Rec r) {
		Site s = Sites.get(r.site());
		return s != null && r.siteKey().equals(Builder.creditKey(s)) && Sites.pendingRecord(r.site()) == null;
	}

	/**
	 * Resolves {@code rs} by the table ({@link #resolve}). Order: whatever the ledger has pending is saved with the world first (refused:
	 * everything stays open for the next start); the put-backs then (the crate's ledger, the marker cleared) saved with the world (chunks
	 * before the ledger: a crash between leaves PRESENT and an open record, closed at the next start); the drops last, saved ledger first
	 * (loss never dupe, the HF/J1 order). Returns what dropped.
	 */
	private static Map<String, Integer> resolveAll(MinecraftServer srv, List<Rec> rs, java.util.function.Predicate<Rec> stands,
		Sites.@Nullable Drops drops) {
		if (Stockpiles.unsaved) {
			try {
				Stockpiles.saveWithWorld(srv);
			} catch (IllegalStateException e) {
				Architect.LOGGER.error("Crate stock: {} owed record(s) left open (the save before them was refused: {}); resolved at the next start",
					rs.size(), e.getMessage());
				return Map.of();
			}
		}
		List<Rec> drop = new ArrayList<>();
		Map<Rec, Outcome> outs = new LinkedHashMap<>();
		boolean back = false;
		for (Rec r : rs) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			if (level == null) {
				continue; // unverifiable: left open
			}
			CrateBlockEntity crate = crateAt(level, r);
			CrateState st = crate == null ? CrateState.ABSENT : r.key().equals(crate.taken()) ? CrateState.MARKED : CrateState.PRESENT;
			Outcome o = resolve(stands.test(r), st);
			Architect.LOGGER.info("Crate stock: owed record {} ({} items, crate {}, site {}): {}", r.key(), total(r.items()), st,
				stands.test(r) ? "stands" : "removed", o);
			if (o.putBack()) {
				crate.ledger().restoreStock(r.items());
				crate.setTaken("");
				OPEN.remove(r.key());
				back = true;
			} else if (!o.dropRecord() && !o.dropCrateStock()) {
				OPEN.remove(r.key()); // nothing taken: closed
				back = true;
			} else {
				drop.add(r);
				outs.put(r, o);
			}
		}
		if (back) {
			Stockpiles.unsaved = true;
			WorldJournal.kill("CXDB"); // (TEST) put back in memory (the crate's ledger, the marker cleared), before its save
			try {
				Stockpiles.saveWithWorld(srv);
			} catch (IllegalStateException e) {
				Architect.LOGGER.error("Crate stock: the put-back's save was refused ({}); the next start resolves the record again", e.getMessage());
			}
		}
		Map<String, Integer> given = new TreeMap<>();
		if (drop.isEmpty()) {
			return given;
		}
		// (rule 17, persist before mutate) the records closed and that ledger written, confirmed, before any item moves: a crash after it
		// loses the drop (never a dupe; the HF/J1 order); a write that fails leaves them open (the next start resolves them)
		for (Rec r : drop) {
			OPEN.remove(r.key());
		}
		Stockpiles.unsaved = true;
		Stockpiles.save();
		if (Stockpiles.unsaved || Stockpiles.loadFailed()) {
			for (Rec r : drop) {
				OPEN.put(r.key(), r);
			}
			Architect.LOGGER.error("Crate stock: the ledger write closing {} owed record(s) failed; they stay open and resolve at the next start", drop.size());
			return given;
		}
		WorldJournal.kill("CXDS"); // (TEST) the records closed on disk, nothing dropped yet: the accepted loss window
		for (Rec r : drop) {
			ServerLevel level = Sites.levelOf(srv, r.dim());
			Outcome o = outs.get(r);
			CrateBlockEntity crate = crateAt(level, r);
			Map<String, Integer> items = new TreeMap<>();
			if (o.dropRecord()) {
				r.items().forEach((k, v) -> items.merge(k, v, Integer::sum));
			}
			if (o.dropCrateStock() && crate != null) {
				if (!r.key().equals(crate.taken())) {
					keepDelivered(srv, r, crate); // not taken before (a marked crate's were kept at its take)
				}
				crate.ledger().takeStock().forEach((k, v) -> {
					if (v > 0) {
						items.merge(k, v, Integer::sum);
					}
				});
			}
			if (o.restoreCell() && crate != null) {
				Builder.restoreCrateCell(level, r.crate());
			}
			if (r.shared()) {
				SiteJournal.releaseKind(r.crateOwner(), WorldJournal.CRATE); // the group's crate went (its own entry, phase 4e)
			}
			Builder.dropItems(level, r.pos(), items, drops);
			items.forEach((k, v) -> given.merge(k, v, Integer::sum));
		}
		try {
			Stockpiles.saveWithWorld(srv); // the players and the chunks (the drop, the restored cell); the ledger again (unchanged since)
		} catch (IllegalStateException e) {
			Architect.LOGGER.error("Crate stock: the save after the drop was refused ({}); the world writes it later", e.getMessage());
		}
		return given;
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
		OPEN.clear();
		PENDING.clear();
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
		return o;
	}

	/** Test: the keys of the open records. */
	static Set<String> keys() {
		return new HashSet<>(OPEN.keySet());
	}
}
