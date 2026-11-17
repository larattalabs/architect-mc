package dev.larattalabs.architect.txn;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.4) What an effect's own marker says: {@code APPLIED} (its receipt is in its store), {@code ABSENT}
 * (never applied), {@code COMPENSATED} (applied, then undone: the {@code /i!c} receipt), {@code UNKNOWN} (the store can't be read now: an
 * unloaded chunk, an offline player, a decision whose write is IN_DOUBT). UNKNOWN is never read as ABSENT: its txn is held.
 */
public enum Probe {
	APPLIED, ABSENT, COMPENSATED, UNKNOWN
}
