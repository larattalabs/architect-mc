package dev.larattalabs.architect.client.dev;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.world.ServerTasks;
import dev.larattalabs.architect.txn.TxnDev;

/**
 * (slice T1, docs/TXN-DESIGN.md §4.2, docs/DEVBRIDGE.md) The {@code dev.txn.*} hooks through {@link TxnDev}, as the client's player, on
 * the server thread. TEST and dev only.
 */
public final class TxnDevHooks {
	private TxnDevHooks() {
	}

	private static void op(String name, String op, String doc) {
		DevBridge.register(name, 120_000, doc, (req, mc) -> {
			JsonObject r = req.deepCopy();
			return DevBridge.onClient(mc, () -> ServerTasks.callAsPlayer((level, player) -> TxnDev.dev(level.getServer(), player, op, r))).thenCompose(x -> x);
		});
	}

	public static void init() {
		op("dev.stockpile.owed", "owedList", "{recipient?} - (slice T2b) owed collectibles: one recipient's (a player UUID or an owner id such as "
			+ "steward_mc:settlement/<id>), oldest first, or every entry: owed [{key, recipient, dimension, at, items, reason, createdTick}], total");
		op("dev.owed.add", "owedAdd", "{key, items: {item: n}, recipient?: the player, reason?, at?} - (slice T2b) TEST: an owed entry, as a source's "
			+ "O effect writes it (published by the next ledger save)");
		op("dev.owed.collect", "owedCollect", "{recipient, key} - (slice T2b) collectOwed to the client's player through the owed.collect txn -> "
			+ "{status: DONE|HELD|REFUSED, given, stillOwed, why, detail}");
		op("dev.owed.failPlayerSave", "owedFailPlayerSave", "{n?: 1} - (slice T2b fix round) TEST: the next n confirmed player saves of a collect's give fail "
			+ "(the give is taken back in its tick, the txn held)");
		op("dev.owed.throwPlayerSave", "owedThrowPlayerSave", "{n?: 1} - (T2b final check P1-3) TEST: the next n confirmed player saves "
			+ "(DurableBarrier.savePlayersConfirmed, the give's own) throw: the give and its receipt taken back in the same tick");
		op("dev.owed.credit", "owedCredit", "{owner, key} - (slice T2b) creditOwedToStock through the owed.credit txn -> {status, given, stillOwed, why}");
		op("dev.txn.cells", "cells", "{cells: [[x,y,z], ..]} - (slice T2a) per cell: state, be (type), beId (identity: a replaced block entity changes it), "
			+ "slots {slot: 'item xN'}, nbt (the saved data), drops (item entities within 2 blocks): what txn-holds compares before and after a writer");
		op("dev.txn.poke", "poke", "{pos, how} - (slice T2a) TEST: one raw write at a cell as another mod would make it: setBlock (air) | destroyBlock | "
			+ "removeBlock | removeBlockEntity | setItem (slot 0 emptied) | removeItem (slot 0) | clearContent | load (from empty data); and (fix round) "
			+ "menu (open the cell's menu for the player) | menuMove {slot?} (a quick-move click packet through the server's handler) | cacheStorage "
			+ "(the Transfer API storage looked up now) | cachedExtract {item?} (64 extracted through that cached handle) | swap {with} (ChestBlockEntity.swapContents) -> result");
		op("dev.txn.state", "state", "{} - (slice T1) the txn core: open txns (id, kind, phase, decision, held, heldAt, resources), openCount, heldCount, "
			+ "quarantined, done (cache size), loadFailed, unsynced, next; file {path, exists, writtenGen, installedGen, inDoubt}; holds; the last events; recovered");
		op("dev.txn.points", "points", "{kind?} - (slice T1) the kill points reached this session (TX:<kind>:<step>, TX:recover:<kind>:<step>), per kind "
			+ "or for one; arm one with dev.journal.killAt (the +save suffix works)");
		op("dev.txn.trace", "trace", "{on?: bool} - (slice T1) on: start recording every kill point reached; off: stop and answer them in order");
		op("dev.txn.run", "run", "{from: [x,y,z], to: [x,y,z], items: {item: n}, key?, dimension?} - (slice T1) TEST kind test.move: the items from one held container "
			+ "to another (T2a: chests and either half of a double chest with its partner, barrels, shulker boxes, hoppers, droppers, dispensers, crafters, "
			+ "furnaces, brewing stands; anything else refused; dimension a canonical key) through a txn (take B with its chunk receipt, the barrier, PREPARED_DONE, the decision, put B, the barrier, "
			+ "EFFECTS_DONE, retirement) -> begin, txn (the id), persist, status, phase, decision, held (or refused / detail / replayed)");
		op("dev.txn.failPersist", "failPersist", "{n?: 1} - (slice T1) TEST: the next n txn.json writes are refused before the rename (model R)");
		op("dev.txn.resolve", "resolve", "{txn, how: commit|abort} - (slice T1) ops resolve (§3.6): abort refused once decided or when the decision probe "
			+ "is APPLIED or UNKNOWN; commit only from PREPARED_DONE -> refused, state");
		op("dev.txn.conservation", "conservation", "{owner?, min: [x,y,z], max: [x,y,z], baseline?: {item: n}} - (slice T1) REPORT ONLY (§5): parts "
			+ "(stock, paidStanding, containers, entities, inventory, crateScan, inTransit by the open txns' probes), total, unread (inconclusive), "
			+ "violations; with baseline: diff and verdict match|differs|inconclusive; never fails");
	}
}
