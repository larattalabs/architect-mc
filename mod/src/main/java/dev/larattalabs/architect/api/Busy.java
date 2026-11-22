package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (slice T4R-D, Steward's A7a) Why a call answered {@link Reason#SITE_BUSY} because of a removal, typed ({@link ArchitectRefused#busy()}): what
 * blocks it, so a caller can word the wait and retry on the blocker's {@code REMOVAL_FINISHED}. {@code blockingId}: the removal in the way (a
 * site, road, group, region or extraction target id); {@code blockingKind}: {@code site}, {@code road}, {@code group}, {@code region},
 * {@code stage} or {@code extraction}; {@code blockingOwner}: that removal's owner id (null when it has none). (slice T4R-D narrowing round)
 * For {@link Kind#OPERATION_IN_PROGRESS} the blocker is no removal: {@code blockingId} is its txn's id and {@code blockingKind} its txn kind,
 * and no {@code REMOVAL_FINISHED} follows. The matching stable {@link ArchitectRefused#detail()} token is {@link #token()}. Since 1.72.0.
 */
public record Busy(Kind kind, String blockingId, String blockingKind, @Nullable String blockingOwner) {
	/**
	 * <ul>
	 * <li>{@link #REMOVAL_IN_PROGRESS}: another removal's footprint (or its open txn) meets this call's cells.</li>
	 * <li>{@link #WAITING_BEHIND}: an older waiting removal (a FIFO ticket) holds that area first.</li>
	 * <li>{@link #PLAYER_BLOCKS_RETURNING}: a road's player blocks are being given back first (an extraction); retry shortly.</li>
	 * <li>{@link #HELD_DECIDED}: the site is a pending member of another removal that is decided and not yet finished.</li>
	 * <li>{@link #OPERATION_IN_PROGRESS}: (slice T4R-D narrowing round) another operation that is not a removal (a crate settlement, a take,
	 * a delivery, a holder's contents being taken out) holds one of this call's cells. It ends by itself and fires no
	 * {@code REMOVAL_FINISHED}: retry after a short delay (a few seconds).</li>
	 * </ul>
	 * Append-only: a caller treats a value it does not know as {@link #OPERATION_IN_PROGRESS} (retry after a short delay), never as a wait
	 * for an event.
	 */
	public enum Kind {
		REMOVAL_IN_PROGRESS, WAITING_BEHIND, PLAYER_BLOCKS_RETURNING, HELD_DECIDED, OPERATION_IN_PROGRESS
	}

	public Busy {
		blockingId = blockingId == null ? "" : blockingId;
		blockingKind = blockingKind == null ? "" : blockingKind;
	}

	/** The stable detail token: {@code <kind_lower>:<blockingId>}, and {@code held(decided)} for {@link Kind#HELD_DECIDED}. */
	public String token() {
		return kind == Kind.HELD_DECIDED ? "held(decided)" : kind.name().toLowerCase(java.util.Locale.ROOT) + ":" + blockingId;
	}
}
