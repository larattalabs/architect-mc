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
}
