package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (6d AD) {@link Regions#adopt}: a standing VillageLayout settlement (the owner's street road sites and lot sites, placed before regions) to
 * record as a region (docs/CONTRACT.md "Phase 6d slice AD" §2). Nothing is written to the world.
 *
 * @param owner the sites' owner (the region's); every site must be this owner's
 * @param dimension the sites' dimension (Overworld only)
 * @param claim the region's claim: every site's box inside it
 * @param layout {@code "village_layout"} (the only layout in this version)
 * @param geometry the street: {@code {streetZ, xLo, xHi}} (it runs east-west along x at z = streetZ) or {@code {streetX, zLo, zHi}}
 * @param roadSiteIds the street's 4e road sites along that line (Steward's {@code street}, {@code street#2}, ...)
 * @param lots lot id (the region's, {@code [a-z][a-z0-9_]{0,47}}) -> its standing site id; each box faces the street
 * @param opKey the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}): adopting again with the same key and body answers the same region;
 *              with another body {@link Reason#OP_KEY_CONFLICT}; null: none
 * @param ext the region's ext (the caller's keys; {@code architect_mc:} keys are Architect's and refused)
 * @since 1.52.0
 */
public record AdoptRegionRequest(@Nullable String owner, ResourceKey<Level> dimension, BoundingBox claim, String layout, JsonObject geometry, List<String> roadSiteIds,
	Map<String, String> lots, @Nullable String opKey, JsonObject ext) {
	/** The layout name of a VillageLayout settlement. */
	public static final String VILLAGE_LAYOUT = "village_layout";

	public AdoptRegionRequest {
		geometry = geometry == null ? new JsonObject() : geometry.deepCopy();
		roadSiteIds = roadSiteIds == null ? List.of() : List.copyOf(roadSiteIds);
		lots = lots == null ? Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(lots));
		ext = ext == null ? new JsonObject() : ext.deepCopy();
	}
}
