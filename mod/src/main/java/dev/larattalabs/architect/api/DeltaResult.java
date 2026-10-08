package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;

/**
 * What an apply or a revert did: applied (false with refusals), the site, the versions, the cells written, the cells the
 * player changed that were kept, the refunds (survival), how many of the site's own neighbour cells vanilla reshaped, notes.
 * Since 1.7.0.
 */
public record DeltaResult(boolean applied, String siteId, int fromVersion, int toVersion, int written, List<KeptCell> kept, Map<Item, Integer> refund,
	int reshaped, List<Refusal> refusals, List<String> notes) {
	public DeltaResult {
		kept = List.copyOf(kept);
		refund = Map.copyOf(refund);
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
	}
}
