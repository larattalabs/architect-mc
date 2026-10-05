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
 */
public record SiteGroup(String id, @Nullable String owner, JsonObject ext, List<String> sites, List<Stage> stages, State state,
	Optional<BlockPos> crate) {
	public SiteGroup {
		ext = ext == null ? new JsonObject() : ext;
		sites = List.copyOf(sites);
		stages = List.copyOf(stages);
	}

	/** {@code ACTIVE}; {@code REMOVING} while {@link Sites#removeGroup} runs; {@code REMOVED} once every site is down. */
	public enum State {
		ACTIVE, REMOVING, REMOVED
	}

	public Optional<Stage> stage(String name) {
		return stages.stream().filter(s -> s.name().equals(name)).findFirst();
	}
}
