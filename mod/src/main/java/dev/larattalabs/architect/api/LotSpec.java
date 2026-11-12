package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import net.minecraft.core.Direction;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * A lot of a region plan: its pad's box (footprint x the program's max height, from {@code floorY}), the side it faces and the
 * brief. A realise maps it to a library entry ({@code RealiseRequest.lotEntries}); an unmapped lot stays a pad. Since 1.8.0.
 *
 * @param site (since NEXT, 7b) a site lot's site ({@link SiteSpec}, with its {@code lotId}): design it with
 *        {@link DesignRequest#withSite}; the lot volume is the site's volume. Null (every pad lot, and the 1.8.0 constructor) = a pad
 *        lot as before. Site lots are slice SL's: until then every lot's site is null.
 */
public record LotSpec(String id, String stage, BoundingBox lot, int floorY, Direction front, @Nullable String brief, BlockSize max, JsonObject ext,
	@Nullable SiteSpec site) {
	public LotSpec {
		ext = ext == null ? new JsonObject() : ext;
	}

	/** The 1.8.0 constructor (a pad lot: no site). Kept for binary compatibility. */
	public LotSpec(String id, String stage, BoundingBox lot, int floorY, Direction front, @Nullable String brief, BlockSize max, JsonObject ext) {
		this(id, stage, lot, floorY, front, brief, max, ext, null);
	}
}
