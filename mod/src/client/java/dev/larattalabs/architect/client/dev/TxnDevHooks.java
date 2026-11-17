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
		op("dev.txn.state", "state", "{} - (slice T1) the txn core: open txns (id, kind, phase, decision, held, heldAt, resources), openCount, heldCount, "
			+ "quarantined, done (cache size), loadFailed, unsynced, next; file {path, exists, writtenGen, installedGen, inDoubt}; holds; the last events; recovered");
		op("dev.txn.points", "points", "{kind?} - (slice T1) the kill points reached this session (TX:<kind>:<step>, TX:recover:<kind>:<step>), per kind "
			+ "or for one; arm one with dev.journal.killAt (the +save suffix works)");
		op("dev.txn.trace", "trace", "{on?: bool} - (slice T1) on: start recording every kill point reached; off: stop and answer them in order");
		op("dev.txn.run", "run", "{from: [x,y,z], to: [x,y,z], items: {item: n}, key?, dimension?} - (slice T1) TEST kind test.move: the items from one "
			+ "container to another through a txn (take B with its chunk receipt, the barrier, PREPARED_DONE, the decision, put B, the barrier, "
			+ "EFFECTS_DONE, retirement) -> begin, txn (the id), persist, status, phase, decision, held (or refused / detail / replayed)");
		op("dev.txn.failPersist", "failPersist", "{n?: 1} - (slice T1) TEST: the next n txn.json writes are refused before the rename (model R)");
		op("dev.txn.resolve", "resolve", "{txn, how: commit|abort} - (slice T1) ops resolve (§3.6): abort refused once decided or when the decision probe "
			+ "is APPLIED or UNKNOWN; commit only from PREPARED_DONE -> refused, state");
		op("dev.txn.conservation", "conservation", "{owner?, min: [x,y,z], max: [x,y,z], baseline?: {item: n}} - (slice T1) REPORT ONLY (§5): parts "
			+ "(stock, paidStanding, containers, entities, inventory, crateScan, inTransit by the open txns' probes), total, unread (inconclusive), "
			+ "violations; with baseline: diff and verdict match|differs|inconclusive; never fails");
	}
}
