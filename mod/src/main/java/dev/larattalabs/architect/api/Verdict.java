package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * {@link Sites#check}: what {@link Sites#place} would do.
 *
 * @param construction whether it would become a construction site (the mode resolved against the world's toggle)
 * @param bom for a construction site, the template's bill of materials (foundation and approach come on top once placed;
 *            the crate screen shows the exact one); empty for an instant placement
 * @param box the template's box; {@code restoreBox} the box its snapshot covers (absent when it could not be planned); for a
 *            road or cell site ({@link Sites#checkRoad}, {@link Sites#checkCells}) both are the box of the cells it changes
 * @param overlaps (1.5.0) the standing sites its restore box overlaps, per site
 * @param cells (1.5.0) a road's or cell site's cell count (0 for a building)
 * @param spans (1.12.0) {@link Sites#checkRoad}: every failing span of the road, partial or not (the first is also the
 *              refusal, unless the road is partial); empty otherwise
 * @param bomFull (1.19.0) for a construction building site, the whole bill of materials: template, foundation fill and approach,
 *                from the dry-run plan this check already builds (cells that end as air are free). Empty for an instant placement,
 *                for a road or cell site, and when the plan was incomplete (then {@code bom}, the template's bill, is the best
 *                answer and {@code bomExact} is false)
 * @param bomExact (1.19.0) true when the plan was complete and no planned cell is a known drift source (a block tick settling at
 *                 placement: a gravity block over a gap, a dirt path under a solid block). On an unchanged world a true
 *                 {@code bomFull} equals the placed site's outstanding bill, item for item; a false one is within 2 units per
 *                 item, and the {@link #notes} list the cells that may differ
 */
public record Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
	Optional<BoundingBox> restoreBox, List<Overlap> overlaps, int cells, List<RoadSpan> spans, Map<Item, Integer> bomFull, boolean bomExact) {
	public Verdict {
		refusals = List.copyOf(refusals);
		notes = List.copyOf(notes);
		bom = Map.copyOf(bom);
		overlaps = List.copyOf(overlaps);
		spans = spans == null ? List.of() : List.copyOf(spans);
		bomFull = bomFull == null ? Map.of() : Map.copyOf(bomFull);
	}

	/** The 1.12.0 constructor (no full bill: empty, not exact). */
	public Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
		Optional<BoundingBox> restoreBox, List<Overlap> overlaps, int cells, List<RoadSpan> spans) {
		this(refusals, notes, construction, bom, box, restoreBox, overlaps, cells, spans, Map.of(), false);
	}

	/** The 1.5.0 constructor (no spans). */
	public Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
		Optional<BoundingBox> restoreBox, List<Overlap> overlaps, int cells) {
		this(refusals, notes, construction, bom, box, restoreBox, overlaps, cells, List.of());
	}

	/** The 1.4.0 constructor. */
	public Verdict(List<Refusal> refusals, List<String> notes, boolean construction, Map<Item, Integer> bom, Optional<BoundingBox> box,
		Optional<BoundingBox> restoreBox) {
		this(refusals, notes, construction, bom, box, restoreBox, List.of(), 0, List.of());
	}

	public boolean ok() {
		return refusals.isEmpty();
	}
}
