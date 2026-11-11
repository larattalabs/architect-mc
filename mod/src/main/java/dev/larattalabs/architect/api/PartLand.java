package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;

/**
 * (6d LC) One part's land in a {@link LandReport}: {@code cells}, the part's cells the region holds on top that were read (loaded); of
 * them, each changed cell in exactly one class: {@code removed} (air or fluid now where the region wrote a block: who removed it is not
 * known), {@code playerPlaced} (the block there now carries a player's record, 6c PT), {@code volatileChanged} (a volatile kind changed:
 * leaves, snow, plants, fluids) and otherwise {@code changed}, counted by the block now there in {@code kinds}. {@code sample}: at most
 * 16 changed positions, in scan order. A cell is attributed to its part by the realised record's writer (RP, RV §3.4); a cell no record
 * attributes (a region realised before the record, or a tile whose record can't be read) is under part {@code unattributed}. Roads
 * are named by their IR road id, gate mechanisms {@code mech:<gate>}. Since NEXT.
 */
public record PartLand(String part, long cells, long changed, long removed, long playerPlaced, long volatileChanged, Map<String, Long> kinds,
	List<BlockPos> sample) {
	public PartLand {
		kinds = Map.copyOf(kinds);
		sample = List.copyOf(sample);
	}
}
