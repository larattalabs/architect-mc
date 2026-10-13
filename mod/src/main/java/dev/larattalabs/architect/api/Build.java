package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * A player's build (docs/CONTRACT.md "Phase 6c slice PT" §4, §9): a group of structural player-placed cells that every Architect
 * write path keeps unless the request names it in its {@link BuildConsent}.
 *
 * @param id {@code build-<n>} from the world's counter (never from geometry or an owner string); a merged build's ids are aliases
 *        that resolve to it ({@link Sites#build})
 * @param footprint the occupied columns as runs per z: {@code z, x0, x1, z, x0, x1, ...}
 * @param entrances its doors (lower half), fence gates and ground trapdoors with their facing; a road ends on a door's apron
 * @param kind the kind guess with {@code confidence} 0..1
 * @param cells its structural cells (loaded when last classified)
 * @param placers each placer's cell count (S-PT-5: the placer UUIDs on the view); the primary placer has the most
 * @param state ACTIVE, CLAIMED, RELEASED or PROVISIONAL (a component a player is still building, N-PT-2)
 * @param revision bumped on every change (a plan records the revision it used)
 * @param siteId (PT2, SQ-PT2-6) the site an {@link BuildState#ADOPTED} build stands as ({@link Sites#adopt}), else null
 */
public record Build(String id, ResourceKey<Level> dimension, BoundingBox bounds, int[] footprint, List<Entrance> entrances, BuildKind kind,
	float confidence, int cells, Map<UUID, Integer> placers, BuildState state, long revision, @org.jspecify.annotations.Nullable String siteId) {
	public Build {
		footprint = footprint.clone();
		entrances = List.copyOf(entrances);
		placers = Map.copyOf(placers);
	}

	/** PT's shape: no site (siteId null). */
	public Build(String id, ResourceKey<Level> dimension, BoundingBox bounds, int[] footprint, List<Entrance> entrances, BuildKind kind,
		float confidence, int cells, Map<UUID, Integer> placers, BuildState state, long revision) {
		this(id, dimension, bounds, footprint, entrances, kind, confidence, cells, placers, state, revision, null);
	}

	@Override
	public int[] footprint() {
		return footprint.clone();
	}

	/** The placer with the most cells (what a settlement shows: "Alex's house"), or null without placers. */
	public UUID primaryPlacer() {
		UUID best = null;
		int n = -1;
		for (var e : placers.entrySet()) {
			if (e.getValue() > n || e.getValue() == n && best != null && e.getKey().compareTo(best) < 0) {
				n = e.getValue();
				best = e.getKey();
			}
		}
		return best;
	}

	@Override
	public boolean equals(Object o) {
		return o instanceof Build b && id.equals(b.id) && dimension.equals(b.dimension) && bounds.equals(b.bounds) && java.util.Arrays.equals(footprint,
			b.footprint) && entrances.equals(b.entrances) && kind == b.kind && Float.compare(confidence, b.confidence) == 0 && cells == b.cells && placers
				.equals(b.placers) && state == b.state && revision == b.revision && java.util.Objects.equals(siteId, b.siteId);
	}

	@Override
	public int hashCode() {
		return java.util.Objects.hash(id, dimension, bounds, java.util.Arrays.hashCode(footprint), entrances, kind, confidence, cells, placers, state,
			revision, siteId);
	}
}
