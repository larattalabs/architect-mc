package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonDeserializationContext;
import com.google.gson.JsonDeserializer;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSerializationContext;
import com.google.gson.JsonSerializer;
import com.google.gson.annotations.JsonAdapter;
import java.lang.reflect.Type;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * A region plan's previews ({@link Regions#previews}, {@link RegionPlan#previews()}): the image files per view, written to the
 * sidecar's plan dir (absolute paths; {@code SECTION} one per axis, {@code SITEPLAN} the SVG then the PNG), and the site plan
 * ({@code siteplan.json}, schema {@code siteplan/1}: lots, paths, utility, anchors, parts and the derived topology graph).
 * Since 1.9.0.
 *
 * <p>A plain {@code new Gson().toJson(plan)} works (an API caller logging a {@link RegionPlan}, the 1.8.0 apitest): the record
 * carries a Gson adapter ({@code {images: {top: [path...], ...}, sitePlan}}), since Gson can't reflect into the JDK's
 * {@code Path} classes.
 */
@JsonAdapter(RegionPreviews.Json.class)
public record RegionPreviews(Map<PreviewView, List<Path>> images, JsonObject sitePlan) {
	public RegionPreviews {
		Map<PreviewView, List<Path>> m = new EnumMap<>(PreviewView.class);
		images.forEach((k, v) -> m.put(k, List.copyOf(v)));
		images = java.util.Collections.unmodifiableMap(m);
		sitePlan = sitePlan == null ? new JsonObject() : sitePlan;
	}

	/** The Gson form: {@code {images: {view (lower case): [path...]}, sitePlan}}. */
	static final class Json implements JsonSerializer<RegionPreviews>, JsonDeserializer<RegionPreviews> {
		@Override
		public JsonElement serialize(RegionPreviews p, Type type, JsonSerializationContext ctx) {
			JsonObject o = new JsonObject();
			JsonObject im = new JsonObject();
			p.images().forEach((v, l) -> {
				JsonArray a = new JsonArray();
				l.forEach(x -> a.add(x.toString()));
				im.add(v.name().toLowerCase(Locale.ROOT), a);
			});
			o.add("images", im);
			o.add("sitePlan", p.sitePlan().deepCopy());
			return o;
		}

		@Override
		public RegionPreviews deserialize(JsonElement e, Type type, JsonDeserializationContext ctx) {
			JsonObject o = e.getAsJsonObject();
			Map<PreviewView, List<Path>> m = new EnumMap<>(PreviewView.class);
			if (o.get("images") instanceof JsonObject im) {
				for (Map.Entry<String, JsonElement> en : im.entrySet()) {
					List<Path> l = new ArrayList<>();
					en.getValue().getAsJsonArray().forEach(x -> l.add(Path.of(x.getAsString())));
					m.put(PreviewView.valueOf(en.getKey().toUpperCase(Locale.ROOT)), l);
				}
			}
			return new RegionPreviews(m, o.get("sitePlan") instanceof JsonObject sp ? sp : new JsonObject());
		}
	}
}
