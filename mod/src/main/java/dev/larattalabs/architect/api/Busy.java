package dev.larattalabs.architect.api;

import org.jspecify.annotations.Nullable;

/**
 * (slice T4R-D, Steward's A7a) Why a call answered {@link Reason#SITE_BUSY} because of a removal, typed ({@link ArchitectRefused#busy()}): what
 * blocks it, so a caller can word the wait and retry on the blocker's {@code REMOVAL_FINISHED}. {@code blockingId}: the removal in the way (a
 * site, road, group, region or extraction target id); {@code blockingKind}: {@code site}, {@code road}, {@code group}, {@code region},
 * {@code stage} or {@code extraction}; {@code blockingOwner}: that removal's owner id (null when it has none). The matching stable
 * {@link ArchitectRefused#detail()} token is {@link #token()}. Since NEXT.
 */
public record Busy(Kind kind, String blockingId, String blockingKind, @Nullable String blockingOwner) {
	/**
	 * <ul>
	 * <li>{@link #REMOVAL_IN_PROGRESS}: another removal's footprint (or its open txn) meets this call's cells.</li>
	 * <li>{@link #WAITING_BEHIND}: an older waiting removal (a FIFO ticket) holds that area first.</li>
	 * <li>{@link #PLAYER_BLOCKS_RETURNING}: a road's player blocks are being given back first (an extraction); retry shortly.</li>
	 * <li>{@link #HELD_DECIDED}: the site is a pending member of another removal that is decided and not yet finished.</li>
	 * </ul>
	 * Append-only: a caller treats a value it does not know as {@link #REMOVAL_IN_PROGRESS}.
	 */
	public enum Kind {
		REMOVAL_IN_PROGRESS, WAITING_BEHIND, PLAYER_BLOCKS_RETURNING, HELD_DECIDED
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
