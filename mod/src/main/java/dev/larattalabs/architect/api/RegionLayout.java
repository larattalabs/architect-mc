package dev.larattalabs.architect.api;

import java.util.List;

/**
 * (8b LY, feature {@code "regionLayout"}) A region's geometry for a settlement map ({@link Regions#layout}): its lots (pads too) and
 * parts with kind, box and ends. Cached per {@code irSha} and head revision; the same in creative and survival. Send it to a client on
 * screen open and when {@code irSha} or {@code revision} changes, not in a periodic view. Since NEXT.
 *
 * @param region the region id
 * @param irSha the region's IR sha
 * @param revision the head revision's rid (0 unrevised)
 * @param parts every part, in the IR's order (lots first, then tiles, roads and routes, connectors, forms)
 */
public record RegionLayout(String region, String irSha, int revision, List<PartShape> parts) {
	public RegionLayout {
		parts = List.copyOf(parts);
	}
}
