package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.Optional;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.jspecify.annotations.Nullable;

/**
 * (7b) A library entry's binding to the site it was designed for (docs/CONTRACT.md "Phase 7b" §2, S-7b-6): stored in the entry's
 * {@code ext} under {@link #EXT_KEY}, so {@link Library.Entry} gains no component. Read with {@link #of(Library.Entry)}. A site-bound
 * entry places only in its own frame ({@link Sites#fitToSite}); elsewhere it is adapted ({@link Designs#siteVariant}). Written by
 * the slices that make site-bound entries (placement and the designer). Since 1.53.0.
 *
 * @param volumeSha the frozen volume's ARVX sha the design was made for ({@link SiteSpec#volumeSha()})
 * @param fit the design's fit
 * @param lotId the region lot it was made for, or null on the standalone path
 * @param volume the lot volume in the world
 * @param regionPlanId the region plan the lot belongs to, or null on the standalone path
 */
public record SiteBinding(String volumeSha, FitMode fit, @Nullable String lotId, BoundingBox volume, @Nullable String regionPlanId) {
	/** The key in {@link Library.Entry#ext()}. */
	public static final String EXT_KEY = "architect_mc:site";

	public SiteBinding {
		java.util.Objects.requireNonNull(volumeSha, "volumeSha");
		java.util.Objects.requireNonNull(fit, "fit");
		java.util.Objects.requireNonNull(volume, "volume");
	}

	/** The binding of a site spec (its sha, fit, lot and volume) in a region plan (null: standalone). */
	public static SiteBinding of(SiteSpec site, @Nullable String regionPlanId) {
		return new SiteBinding(site.volumeSha(), site.fit(), site.lotId(), site.volume(), regionPlanId);
	}

	/** An entry's binding: empty when the entry is not site-bound, or its {@code ext} member is malformed. */
	public static Optional<SiteBinding> of(Library.Entry entry) {
		return entry == null ? Optional.empty() : ofExt(entry.ext());
	}

	/** The binding in an {@code ext} object: empty when there is none or it is malformed. */
	public static Optional<SiteBinding> ofExt(@Nullable JsonObject ext) {
		if (ext == null || !(ext.get(EXT_KEY) instanceof JsonObject o)) {
			return Optional.empty();
		}
		try {
			String sha = SiteSpec.str(o, "volumeSha", true);
			Optional<FitMode> fit = FitMode.of(SiteSpec.str(o, "fit", true));
			if (fit.isEmpty() || !(o.get("volume") instanceof JsonObject vb)) {
				return Optional.empty();
			}
			return Optional.of(new SiteBinding(sha, fit.get(), SiteSpec.str(o, "lotId", false), SiteSpec.boxOf(vb), SiteSpec.str(o, "regionPlanId", false)));
		} catch (RuntimeException e) {
			return Optional.empty();
		}
	}

	/** The wire form under {@link #EXT_KEY}: {@code {volumeSha, fit, volume: {minX..maxZ}, lotId?, regionPlanId?}}. */
	public JsonObject wire() {
		JsonObject o = new JsonObject();
		o.addProperty("volumeSha", volumeSha);
		o.addProperty("fit", fit.wire());
		o.add("volume", SiteSpec.box(volume));
		if (lotId != null) {
			o.addProperty("lotId", lotId);
		}
		if (regionPlanId != null) {
			o.addProperty("regionPlanId", regionPlanId);
		}
		return o;
	}
}
