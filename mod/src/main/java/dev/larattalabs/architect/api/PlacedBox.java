package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * The player-placed cells of a box (loaded chunks only; §9): how many are tracked, how many of those are incidental (in no kept
 * build), the tracked count per placer, and the builds the box meets with their cells in it (blocking = their cells in the box,
 * {@code first} at most 8). Since PT.
 */
public record PlacedBox(int tracked, int incidental, Map<UUID, Integer> byPlacer, List<BuildHit> builds) {
	public PlacedBox {
		byPlacer = Map.copyOf(byPlacer);
		builds = List.copyOf(builds);
	}
}
