package dev.larattalabs.architect.txn;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.4) An effect's class, by how recovery observes it: {@code L} ledger key, {@code B} block entity or
 * container (a receipt in the chunk attachment), {@code D} the external decision (the journal undo group), {@code W} world restore (per
 * chunk), {@code R} record upsert or drop (tombstone with a persisted generation), {@code P} player inventory (player attachment and an
 * acknowledged save), {@code O} owed collectible (a keyed ledger entry).
 */
public enum EffectClass {
	L, B, D, W, R, P, O
}
