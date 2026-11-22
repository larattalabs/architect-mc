package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * The outcome of {@link Sites#remove}.
 *
 * @param blockers why it was not removed: the player's things in the box, the owner rule, a player standing in it, ...
 * @param refund in survival, the items given back now: refunds for paid cells still standing and the crate's stock, credited to the
 *               owner's stockpile, and the player's own blocks found in the box. Never the owed items: those are listed apart in
 *               {@code owed}. Empty for an instant site, and for a crate-fed site whose refunds and stock were all owed.
 * @param restored (1.5.0) cells the undo wrote back
 * @param kept (1.5.0) CELL cells the player changed since: left as they are
 * @param handedDown (1.5.0) cells covered by a site that stays, per covering site id: they stay its blocks until it goes
 * @param cascaded (1.5.0) the covering sites a {@code CASCADE} removed first, top-down
 * @param owed (since 1.72.0) the owed keys ({@link Owed#key}) the removal booked: a crate-fed site's crate stock and refunds go to its owner as
 *             owed collectibles ({@link Sites#owed}, {@link Sites#collectOwed}) instead of dropping. Listed apart: their items are never in
 *             {@code refund}, so a total is {@code refund} plus the owed entries' items. Empty when nothing was owed (a stockpile credit, an
 *             instant site, a refund-free removal)
 * @param owedParts (since 1.72.0, slice T4R-D) each owed key's recipient, reason and the amount the removal booked under it, snapshotted
 *                  before the removal finished: immutable (a later collect or credit never changes it). A T4R removal's player blocks are
 *                  here, reason {@code player_blocks}, owed to their placer (or the site's recipient, the requester, or
 *                  {@code architect:unclaimed}).
 * <p>
 * <b>Semantic change (since 1.72.0, slice T4R-D; STEWARD-SYNC):</b> on a removal begun by this build, {@code refund} no longer lists the
 * player's own blocks found in the box: they are owed ({@code owedParts}, reason {@code player_blocks}), never dropped. {@code refund} is
 * only what went back to the stockpile (and a legacy instant drop). A removal a pre-T4R build left in flight still reports v0.89.0's refund.
 */
public record RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund, int restored, int kept, Map<String, Integer> handedDown,
	List<String> cascaded, List<String> owed, List<OwedPart> owedParts) {
	public RemoveResult {
		owedParts = owedParts == null ? List.of() : List.copyOf(owedParts);
		blockers = List.copyOf(blockers);
		refund = Map.copyOf(refund);
		handedDown = Map.copyOf(handedDown);
		cascaded = List.copyOf(cascaded);
		owed = List.copyOf(owed);
	}

	/** The constructor before T4R-D (no owed parts). */
	public RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund, int restored, int kept, Map<String, Integer> handedDown,
		List<String> cascaded, List<String> owed) {
		this(removed, blockers, refund, restored, kept, handedDown, cascaded, owed, List.of());
	}

	/** The 1.5.0 constructor (no owed keys). */
	public RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund, int restored, int kept, Map<String, Integer> handedDown,
		List<String> cascaded) {
		this(removed, blockers, refund, restored, kept, handedDown, cascaded, List.of());
	}

	/** The 1.4.0 constructor. */
	public RemoveResult(boolean removed, List<String> blockers, Map<Item, Integer> refund) {
		this(removed, blockers, refund, 0, 0, Map.of(), List.of());
	}
}
