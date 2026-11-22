package dev.larattalabs.architect.api;

/**
 * (S-DRS-1, feature {@code "removalStopCause"}) Why a removal stopped, typed, beside its text ({@link RegionView#removalStopCause()},
 * {@link SiteGroup#removalStopCause()}): a caller tells the stops apart without parsing {@code removalStopReason} or the blockers. The text
 * is unchanged. Since 1.69.0.
 * <ul>
 * <li>{@link #SAVE_REFUSED}: a survival removal's save before it changes anything (the world and the stockpile ledger) was refused (a
 * chunk write not durable), so it wrote nothing; a later removal tries again.</li>
 * <li>{@link #PLAYER_IN_BOX}: a player stayed in a member's box past the removal's wait.</li>
 * <li>{@link #COVERED}: sites outside the removal cover its cells and the removal was asked to refuse them ({@code COVERED}).</li>
 * <li>{@link #CARGO}: a filled-container member's declared containers hold more than their declaration (cargo), so their custody was not
 * taken.</li>
 * <li>{@link #THINGS_IN_BOX}: the owner's things stand in a member's box (containers they filled, pets, item frames, dropped items): the
 * blockers name them; a forced removal loses them.</li>
 * <li>{@link #WAITING_BEHIND} (since NEXT, slice T4R-D A7b): it waited on its FIFO ticket behind another removal for {@code MAX_WAIT} while
 * nothing ahead made progress; nothing of it was written.</li>
 * <li>{@link #OTHER}: anything else (the owner rule, a journal not readable, a member still being placed, an unloaded dimension, a
 * failure).</li>
 * </ul>
 * Append-only: a caller treats a value it does not know as {@link #OTHER}.
 */
public enum RemovalStopCause {
	SAVE_REFUSED, PLAYER_IN_BOX, COVERED, CARGO, THINGS_IN_BOX, OTHER, WAITING_BEHIND
}
