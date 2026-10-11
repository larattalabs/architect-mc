package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.Level;

/**
 * An owner's settlement stockpile (C24, docs/CONTRACT.md phase 6c slice Y): a ledger with block inlets. Every new construction
 * item of the owner draws from it. Per item, {@code stock = delivered + returned - consumed - withdrawn - dropped}; refunds that
 * did not fit are in {@code refundOverflow}, outside that identity. Since 1.18.0.
 *
 * @param crates the crate cells (missing ones included, see {@code missingCrates})
 * @param capacityStacks 27 stacks per present crate
 * @param usedStacks the sum over items of ceil(stock / max stack size)
 * @param reserved per item, what the targets in feed order hold for themselves (at most the stock)
 * @param credit per item, the stock beyond what every building target still needs (what {@link Sites#withdraw} can take)
 * @param outstandingByTarget per building target, what its unbuilt cells cost
 * @param outstanding the sum of {@code outstandingByTarget}
 * @param feedOrder the building targets, first fed first
 * @param waiting C25's waits per target (slice Y2; empty in 1.18.0)
 * @param missingCrates crate cells whose block is gone (they hold nothing: capacity drops by 27 stacks each)
 */
public record Stockpile(String owner, ResourceKey<Level> dimension, List<BlockPos> crates, int capacityStacks, int usedStacks,
	Map<Item, Integer> stock, Map<Item, Integer> reserved, Map<Item, Integer> credit, Map<Item, Integer> delivered, Map<Item, Integer> consumed,
	Map<Item, Integer> returned, Map<Item, Integer> withdrawn, Map<Item, Integer> dropped, Map<Item, Integer> refundOverflow,
	Map<String, Map<Item, Integer>> outstandingByTarget, Map<Item, Integer> outstanding, List<String> feedOrder, Map<String, SiteWait> waiting,
	List<BlockPos> missingCrates) {
	public Stockpile {
		crates = List.copyOf(crates);
		stock = Map.copyOf(stock);
		reserved = Map.copyOf(reserved);
		credit = Map.copyOf(credit);
		delivered = Map.copyOf(delivered);
		consumed = Map.copyOf(consumed);
		returned = Map.copyOf(returned);
		withdrawn = Map.copyOf(withdrawn);
		dropped = Map.copyOf(dropped);
		refundOverflow = Map.copyOf(refundOverflow);
		outstandingByTarget = Map.copyOf(outstandingByTarget);
		outstanding = Map.copyOf(outstanding);
		feedOrder = List.copyOf(feedOrder);
		waiting = Map.copyOf(waiting);
		missingCrates = List.copyOf(missingCrates);
	}
}
