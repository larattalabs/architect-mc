package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * The verdict on a delta before any write (docs/CONTRACT.md phase 5b, Steward SHOULD 1: the preview as data): ok, or the
 * refusals (waits among them: {@link Reason#SITE_BUSY}, occupancy, {@link Reason#OVERLAP_BUSY}); the world delta's counts (cells
 * the new version adds, removes and changes, terrain included); the per-part summary of the blueprint delta; the cells the
 * player changed ({@code kept} under KEEP, or the ones that refuse under REFUSE); growth into other sites; in survival the bill
 * of materials of the delta and the refunds; the box of the cells it writes (null: nothing to write); the mode it would run in;
 * notes. The client ghost and Architect's UI render from this same object. Since 1.7.0.
 */
public record DeltaVerdict(boolean ok, List<Refusal> refusals, int added, int removed, int changed, Map<String, PartDelta> parts, List<KeptCell> kept,
	List<Overlap> overlaps, Map<Item, Integer> bom, Map<Item, Integer> refund, BoundingBox box, Mode mode, List<String> notes) {
	public DeltaVerdict {
		refusals = List.copyOf(refusals);
		parts = Map.copyOf(parts);
		kept = List.copyOf(kept);
		overlaps = List.copyOf(overlaps);
		bom = Map.copyOf(bom);
		refund = Map.copyOf(refund);
		notes = List.copyOf(notes);
	}
}
