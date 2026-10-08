package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A lot of a region plan: its pad's box (footprint x the program's max height, from {@code floorY}), the side it faces and the
 * brief. A realise maps it to a library entry ({@code RealiseRequest.lotEntries}); an unmapped lot stays a pad. Since 1.8.0.
 */
public record LotSpec(String id, String stage, BoundingBox lot, int floorY, Direction front, @Nullable String brief, BlockSize max, JsonObject ext) {
	public LotSpec {
		ext = ext == null ? new JsonObject() : ext;
	}
}
