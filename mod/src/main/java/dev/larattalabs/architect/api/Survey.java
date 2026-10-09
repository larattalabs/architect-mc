package dev.larattalabs.architect.api;

import java.util.concurrent.CompletableFuture;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/** Terrain sampling for site surveys (R1/A5b section 7.1). */
public interface Survey {
	/**
	 * Samples the columns of {@code area} (its x/z extent; y is ignored). Time-sliced on the server thread (a few ms per
	 * tick), so a big area never stalls a tick; the future completes on the server thread.
	 *
	 * @param resolution 1 = every column, allowed up to 256x256 columns; otherwise (or for any value other than 1) one column
	 *                   in 4 along each axis. {@link Sample#resolution()} says which was used.
	 * @param load {@link LoadPolicy#LOADED_ONLY} (unloaded chunks are reported missing) or {@link LoadPolicy#LOAD_BOUNDED}
	 */
	CompletableFuture<Sample> sample(ServerLevel level, BoundingBox area, int resolution, LoadPolicy load);

	/** {@link #sample} with {@link LoadPolicy#LOADED_ONLY}. */
	default CompletableFuture<Sample> sample(ServerLevel level, BoundingBox area, int resolution) {
		return sample(level, area, resolution, LoadPolicy.LOADED_ONLY);
	}

	/**
	 * A 3D volume survey (docs/CONTRACT.md phase 6b §5): every cell of {@code box} classified ({@link VoxelClass}), sliced on the
	 * server thread under the same per-tick budget as {@link #sample} (a single-valued chunk section costs one lookup), encoded
	 * as ARVX and frozen to {@code <world>/architect/volumes/<sha>.bin} (written, fsynced, renamed, read back and its sha
	 * checked; never rewritten). {@code load} as {@link #sample}; {@link LoadPolicy#GENERATED_ONLY} never generates a chunk.
	 * Fails with {@link RegionRefused} {@link Reason#REGION_LIMIT} when the box has more cells than the per-call limit.
	 * Since 1.9.0.
	 */
	default CompletableFuture<Volume> volume(ServerLevel level, BoundingBox box, LoadPolicy load) {
		throw new UnsupportedOperationException("Survey.volume needs Architect API 1.9.0");
	}
}
