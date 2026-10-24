package dev.larattalabs.architect.client.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import dev.larattalabs.architect.client.sidecar.Sidecar;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.StyleForm;
import com.google.gson.JsonObject;
import dev.larattalabs.labui.client.text.TextModel;
import dev.larattalabs.architect.design.CritiqueRules;
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
	/**
	 * (Style unification U2) The picked Style, its materials and the features (StyleForm, NEW mode): a style chip is a built-in Style;
	 * the Style bible list adds the installed hand-made ones (a Claude-made one stays bible set mode: {@link #bible}). The free text
	 * {@link #styleText}, when not empty, means no Style: the words go as the request's style and no palette is sent.
	 */
	public final StyleForm styleForm = new StyleForm(StyleForm.Mode.NEW, StyleForm.Style.preset(Palettes.FALLBACK, "rustic"), List.of("porch"));
	public final TextModel styleText = new TextModel(DesignSpec.MAX_STYLE);
	public final TextModel materials = new TextModel(DesignSpec.MAX_MATERIALS);
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
	/** (4c) "Massing first": null = the default for the size (on for L and plot, {@link dev.larattalabs.architect.design.MassingRules}). */
	public @Nullable Boolean massingFirst;
	/** (5a) "Critique and revise": the critique loop after the design renders (default off, {@link CritiqueRules#DEFAULT_ON}). */
	public boolean critique = UiPrefs.critiqueByDefault();
	/** (5a) The loop's revisions: 1 or 2. */
	public int maxRevisions = CritiqueRules.DEFAULT_REVISIONS;
	// (5a) the live estimate (asked once the form has been still a moment, {@link DesignFeature#tickEstimate})
	@Nullable String estimateKey;
	long estimateChangedAt;
	@Nullable String estimateSentKey;
	boolean estimating;
	public dev.larattalabs.architect.api.@Nullable Estimate estimate;
	public @Nullable String estimateError;

	/** The {@code critique} the request carries (null: off, or a helper without the loop). */
	public @Nullable JsonObject critiqueSpec() {
		return CritiqueRules.spec(critique, maxRevisions, SetFeature.has("critique"));
	}

	/** Whether this request makes a massing first (a remix never does). */
	public boolean massingFirst() {
		if (remix != null) {
			return false;
		}
		return massingFirst != null ? massingFirst : dev.larattalabs.architect.design.MassingRules.massingFirstByDefault(size);
	}

	/** The style sent: the free text when typed, else the picked Style (a built-in's id, as the chips sent before U2; else its name). */
	public String style() {
		String t = styleText.value().strip();
		if (!t.isEmpty()) {
			return t;
		}
		StyleForm.Style b = styleForm.base();
		if (b == null) {
			return "";
		}
		String w = StyleForm.PRESET.equals(b.kind()) && b.id() != null ? b.id() : b.name();
		return w.length() > DesignSpec.MAX_STYLE ? w.substring(0, DesignSpec.MAX_STYLE) : w;
	}

	/** The style chip shown as picked: the built-in Style picked (no free text), or null. */
	public @Nullable String styleChip() {
		StyleForm.Style b = styleForm.base();
		return styleText.value().isBlank() && b != null && StyleForm.PRESET.equals(b.kind()) ? b.id() : null;
	}

	/** A style chip: picks that built-in Style (its materials and suggested features) and clears the free text. */
	public void pickChip(String id) {
		StyleForm.Style s = StyleForm.Style.preset(Palettes.FALLBACK, id);
		if (s == null) {
			styleText.set(id);
			return;
		}
		styleForm.pick(s);
		styleText.clear();
	}

	/** A Style from the Style bible list: a Claude-made one is bible set mode ({@link #bible}); a built-in or hand-made one is picked. */
	public void pickBible(dev.larattalabs.architect.api.@Nullable Bible b) {
		if (b == null) {
			bible = null;
		} else if ("claude".equals(b.origin())) {
			bible = b.id();
		} else {
			bible = null;
			styleForm.pick(StyleForm.Style.of(b));
			styleText.clear();
		}
	}

	/** The features (the Style's suggestions and the player's picks). */
	public List<String> features() {
		return styleForm.features();
	}

	/**
	 * (U2) The materials-only palette the request carries: the picked Style's roles inline ({@code withStyle}), or the custom mix based on
	 * it. None with free text, with a set-mode bible (the bible's roles are the materials) or without a Style.
	 */
	public @Nullable JsonElement palette() {
		if (!styleText.value().isBlank() || bible != null || styleForm.base() == null) {
			return null;
		}
		return styleForm.request().get("palette");
	}

	/** Why the palette can't go to this helper (null: it can): a custom mix needs {@code palette.roles} (an unedited Style falls back to its name). */
	public @Nullable String paletteRefusal() {
		if (palette() == null || !Sidecar.connected() || SetFeature.has("palette.roles")) {
			return null;
		}
		return styleForm.mix() ? "this design helper can't take a custom mix (no palette.roles): Revert, or update it" : null;
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
		styleForm.toggleFeature(id);
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
		return new DesignSpec.Draft(typeSent(), style(), materials.value(), features(), m[0], m[1], m[2], PLOT.equals(size) ? plot : null, remix,
			name.value(), notes.value(), OTHER.equals(type) ? profile : List.of(), bible);
	}

	public Map<String, String> errors() {
		Map<String, String> e = new LinkedHashMap<>(DesignSpec.validate(draft()));
		String pr = paletteRefusal();
		if (pr != null && !e.containsKey("style")) {
			e.put("style", pr);
		}
		if (PLOT.equals(size) && plot == null) {
			e.put("maxSize", "mark a plot first (Mark a plot…)");
		}
		return e;
	}

	/** The request as sent: the draft, plus the palette when the helper takes one ({@code palette.roles}). */
	public JsonObject requestJson() {
		JsonObject r = DesignSpec.requestJson(draft());
		JsonElement p = palette();
		if (p != null && SetFeature.has("palette.roles")) {
			r.add("palette", p.deepCopy());
		}
		return r;
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
		o.addProperty("styleChip", styleChip());
		o.add("styleForm", styleForm.view());
		JsonElement pal = palette();
		o.add("palette", pal == null ? com.google.gson.JsonNull.INSTANCE : pal);
		o.addProperty("styleText", styleText.value());
		o.addProperty("materials", materials.value());
		JsonArray f = new JsonArray();
		features().forEach(f::add);
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
		o.addProperty("massingFirst", massingFirst());
		o.addProperty("massingFirstSet", massingFirst);
		o.addProperty("critique", critique);
		o.addProperty("maxRevisions", maxRevisions);
		o.add("critiqueSpec", critiqueSpec());
		if (estimate != null) {
			o.addProperty("estimate", CritiqueRules.estimateLine(estimate));
		}
		o.addProperty("estimateError", estimateError);
		if (errors().isEmpty()) {
			o.add("request", requestJson());
		}
		return o;
	}
}
