package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.nio.file.Path;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * A region plan's previews ({@link Regions#previews}, {@link RegionPlan#previews()}): the image files per view, written to the
 * sidecar's plan dir (absolute paths; {@code SECTION} one per axis, {@code SITEPLAN} the SVG then the PNG), and the site plan
 * ({@code siteplan.json}, schema {@code siteplan/1}: lots, paths, utility, anchors, parts and the derived topology graph).
 * Since 1.9.0.
 */
public record RegionPreviews(Map<PreviewView, List<Path>> images, JsonObject sitePlan) {
	public RegionPreviews {
		Map<PreviewView, List<Path>> m = new EnumMap<>(PreviewView.class);
		images.forEach((k, v) -> m.put(k, List.copyOf(v)));
		images = java.util.Collections.unmodifiableMap(m);
		sitePlan = sitePlan == null ? new JsonObject() : sitePlan;
	}
}
