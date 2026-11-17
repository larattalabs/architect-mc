package dev.larattalabs.architect.api;

/**
 * (DR) What a diagnosis found (docs/CONTRACT.md "Slice DR" §1). Only {@link #LAGGING} cells are ever written by a repair; the rest are
 * reported. New values are appended at the end. Since 1.67.0.
 */
public enum RepairCode {
	/** The owner's committed value is absent and the cell holds that operation's exact pre-op value: rolled forward by a repair. */
	LAGGING,
	/** Anything else, or a cell with a player's record: reported, never repaired. */
	FOREIGN,
	/** A pending site or road that settled KEEP at a start with no job in the queue: its cells are listed under it. */
	STUCK,
	/** Committed operations on shared cells (two removals over one cell): rolled forward top-down. */
	STACKED,
	/** A fill's custody key no standing site, queued removal or credit resolves. */
	CUSTODY,
	/** A paid record whose target is in no record or queued removal: report only. */
	PAID_ORPHAN,
	/** A fed target whose book disagrees with the world: report only (the start's reconcile owns it). */
	BOOK,
	/** Part of the scope not read in this call (the chunk budget): diagnose again with the continuation. */
	UNREAD
}
