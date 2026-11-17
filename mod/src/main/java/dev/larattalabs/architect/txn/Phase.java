package dev.larattalabs.architect.txn;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.3) A txn's progress, never its decision: {@code PREPARED} (the intent is durable; prepare effects may
 * be applied), {@code PREPARED_DONE} (every prepare effect applied and a barrier covered them, §3.4), {@code EFFECTS_DONE} (every effect
 * applied and covered: futures complete here, §3.12.6), {@code ABORTING} (compensation running), {@code RETIRING} (awaiting the stores'
 * generations, §3.7). No phase implies or erases a {@link Decision}.
 */
public enum Phase {
	PREPARED, PREPARED_DONE, EFFECTS_DONE, ABORTING, RETIRING
}
