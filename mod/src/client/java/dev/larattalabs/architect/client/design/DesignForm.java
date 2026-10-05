package dev.larattalabs.architect.client.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.client.text.TextModel;
import dev.larattalabs.architect.design.DesignSpec;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The Design tab's model (docs/CONTRACT.md "Mod scope": type, style chips + free text, materials, features, size
 * S/M/L/plot/custom, name, notes). Kept across tab switches and plot marking for the session. Validation is
 * {@link DesignSpec#validate}; the wire form is {@link DesignSpec#requestJson}. Client thread.
 */
public final class DesignForm {
	public static final String PLOT = "plot";
	public static final String CUSTOM = "custom";
	/** The type chip that means "my own type" (phase 4b open types): the type is {@link #openType}'s text. */
	public static final String OTHER = "other";

	public String type = "cabin";
	/** The style: a chip id, or the free text when {@link #styleText} is not empty. */
	public String styleChip = "rustic";
	public final TextModel styleText = new TextModel(DesignSpec.MAX_STYLE);
	public final TextModel materials = new TextModel(DesignSpec.MAX_MATERIALS);
	public final List<String> features = new ArrayList<>(List.of("porch"));
	public String size = "M";
	public int customX = 21;
	public int customY = 14;
	public int customZ = 21;
	public DesignSpec.@Nullable Plot plot;
	public @Nullable String remix;
	public final TextModel name = new TextModel(DesignSpec.MAX_NAME + 20);
	public final TextModel notes = new TextModel(DesignSpec.MAX_NOTES + 200);
	/** (4b) An open type's name when {@link #type} is {@link #OTHER} ({@code hellish_lair}). */
	public final TextModel openType = new TextModel(40);
	/** (4b) An open type's checker rules ({@link DesignSpec#PROFILE_RULES}); empty = the default (door, lit, no_floating). */
	public final List<String> profile = new ArrayList<>(DesignSpec.DEFAULT_PROFILE);
	/** (4b) The style bible to design with, or null (today's behaviour). */
	public @Nullable String bible;
	/** Shown under the form after a refused or failed send; cleared by any edit. */
	public @Nullable String sendError;

	/** The style sent: the free text when typed, else the chip. */
	public String style() {
		String t = styleText.value().strip();
		return t.isEmpty() ? styleChip : t;
	}

	/** The size limit {x, y, z}: the preset for the type, the plot's, or the custom one. */
	public int[] maxSize() {
		if (PLOT.equals(size) && plot != null) {
			return plot.maxSize();
		}
		if (CUSTOM.equals(size) || PLOT.equals(size)) {
			return new int[] {customX, customY, customZ};
		}
		return DesignSpec.preset(size, OTHER.equals(type) ? "custom" : type);
	}

	/** A marked plot sets the size to it (and keeps it for a design sent with it). */
	public void setPlot(DesignSpec.Plot p) {
		plot = p;
		size = PLOT;
	}

	public void toggleFeature(String id) {
		if (!features.remove(id)) {
			features.add(id);
		}
	}

	/** The type sent: the chip, or the open type typed for {@link #OTHER}. */
	public String typeSent() {
		return OTHER.equals(type) ? openType.value().strip().toLowerCase(java.util.Locale.ROOT) : type;
	}

	public void toggleProfile(String rule) {
		if (!profile.remove(rule)) {
			profile.add(rule);
		}
	}

	public DesignSpec.Draft draft() {
		int[] m = maxSize();
		return new DesignSpec.Draft(typeSent(), style(), materials.value(), features, m[0], m[1], m[2], PLOT.equals(size) ? plot : null, remix,
			name.value(), notes.value(), OTHER.equals(type) ? profile : List.of(), bible);
	}

	public Map<String, String> errors() {
		Map<String, String> e = new LinkedHashMap<>(DesignSpec.validate(draft()));
		if (PLOT.equals(size) && plot == null) {
			e.put("maxSize", "mark a plot first (Mark a plot…)");
		}
		return e;
	}

	public JsonObject requestJson() {
		return DesignSpec.requestJson(draft());
	}

	/** For the DevBridge ({@code dev.design.state}). */
	public JsonObject stateJson() {
		JsonObject o = new JsonObject();
		o.addProperty("type", typeSent());
		o.addProperty("typeChip", type);
		JsonArray pr = new JsonArray();
		profile.forEach(pr::add);
		o.add("profile", pr);
		o.addProperty("bible", bible);
		o.addProperty("style", style());
		o.addProperty("styleChip", styleChip);
		o.addProperty("styleText", styleText.value());
		o.addProperty("materials", materials.value());
		JsonArray f = new JsonArray();
		features.forEach(f::add);
		o.add("features", f);
		o.addProperty("size", size);
		int[] m = maxSize();
		o.addProperty("maxSize", m[0] + "x" + m[1] + "x" + m[2]);
		o.addProperty("plot", plot == null ? null : plot.dx() + "x" + plot.dz() + " at " + plot.minX() + "," + plot.y() + "," + plot.minZ() + " front "
			+ plot.front());
		o.addProperty("remix", remix);
		o.addProperty("name", name.value());
		o.addProperty("notes", notes.value());
		JsonObject errs = new JsonObject();
		errors().forEach(errs::addProperty);
		o.add("errors", errs);
		o.addProperty("sendError", sendError);
		if (errors().isEmpty()) {
			o.add("request", requestJson());
		}
		return o;
	}
}
