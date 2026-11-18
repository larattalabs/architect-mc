package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * A site group (R1 minimum): the sites of one or more batches, undone as one ({@link Sites#removeGroup}), with ordered
 * {@link Stage}s. Recorded in {@code <world>/architect-sites.json}. Since 1.4.0.
 *
 * @param sites its standing sites, in placement order
 * @param stages every stage, in order (appended batches add theirs at the end)
 * @param crate the shared crate (survival, {@code sharedCrate}), when it has one
 * @param removedAt (since 1.14.0) when the removal finished (epoch ms), for a {@link State#REMOVED} group: its tombstone, kept across save and reload
 * @param removalStop (S-DRS-1, feature {@code "removalStopCause"}; Since NEXT) how the group's last whole-group removal
 *                    ({@link Sites#removeGroup}) stopped, as {@link RegionView#removalStop}: NONE (none stopped since this world loaded, or it
 *                    removed the group), NOT_STARTED (nothing written) or PARTIAL. Kept in memory: a restart answers NONE
 * @param removalStopCause (Since NEXT) that stop's typed cause ({@link RemovalStopCause}); null with NONE. The blockers' text is unchanged
 */
public record SiteGroup(String id, @Nullable String owner, JsonObject ext, List<String> sites, List<Stage> stages, State state,
	Optional<BlockPos> crate, Optional<Long> removedAt, RemovalStop removalStop, @Nullable RemovalStopCause removalStopCause) {
	public SiteGroup {
		removalStop = removalStop == null ? RemovalStop.NONE : removalStop;
		removalStopCause = removalStop == RemovalStop.NONE ? null : removalStopCause == null ? RemovalStopCause.OTHER : removalStopCause;
		removedAt = removedAt == null ? Optional.empty() : removedAt;
		ext = ext == null ? new JsonObject() : ext;
		sites = List.copyOf(sites);
		stages = List.copyOf(stages);
	}

	/** The 1.14.0 constructor: no removal stop (NONE). */
	public SiteGroup(String id, @Nullable String owner, JsonObject ext, List<String> sites, List<Stage> stages, State state, Optional<BlockPos> crate,
		Optional<Long> removedAt) {
		this(id, owner, ext, sites, stages, state, crate, removedAt, RemovalStop.NONE, null);
	}

	/** The 1.4.0 constructor (no removedAt). */
	public SiteGroup(String id, @Nullable String owner, JsonObject ext, List<String> sites, List<Stage> stages, State state, Optional<BlockPos> crate) {
		this(id, owner, ext, sites, stages, state, crate, Optional.empty());
	}

	/** {@code ACTIVE}; {@code REMOVING} while {@link Sites#removeGroup} runs; {@code REMOVED} once every site is down. */
	public enum State {
		ACTIVE, REMOVING, REMOVED
	}

	public Optional<Stage> stage(String name) {
		return stages.stream().filter(s -> s.name().equals(name)).findFirst();
	}
}
