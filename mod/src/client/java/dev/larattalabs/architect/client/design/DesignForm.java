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
	 * the Style browser adds the installed ones. (U5) Every Style is picked here; "Use this style's parts" ({@link #setUseParts}, a Style
	 * with its own parts) turns bible set mode on ({@link #bible()}). The free text {@link #styleText}, when not empty, means no Style:
	 * the words go as the request's style and no palette is sent.
	 */
	public final StyleForm styleForm = new StyleForm(StyleForm.Mode.NEW, StyleForm.Style.preset(Palettes.FALLBACK, "rustic"), List.of("porch"));
	public final TextModel styleText = new TextModel(DesignSpec.MAX_STYLE);
	/**
	 * (U3) Words alongside the picked Style ("mossy, lived-in" with Medieval): sent first in the notes ({@link
	 * dev.larattalabs.architect.design.StyleNote}); the request's style stays the Style. Ignored with your own words.
	 */
	public final TextModel styleNote = new TextModel(dev.larattalabs.architect.design.StyleNote.MAX);
	/** (U3) "Own words" chosen with nothing typed yet: the words field is the style itself (no Style, no palette). */
	public boolean ownWordsMode;
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
	/**
	 * (4b) The style bible to design with (set mode), or null. (U5) Derived: the picked Style's id when its parts are used
	 * ({@link StyleForm#partsOn}), else null (materials only, the hybrid default).
	 */
	public @Nullable String bible() {
		StyleForm.Style b = styleForm.base();
		return !ownWords() && b != null && styleForm.partsOn() ? b.id() : null;
	}

	/** (U5) The set-mode bible's version (the picked Style's), or null. */
	public @Nullable Integer bibleVersion() {
		StyleForm.Style b = styleForm.base();
		return bible() != null && b != null ? b.version() : null;
	}

	/** (U5b) "Use this style's parts" (a Style with its own parts; ignored otherwise). */
	public void setUseParts(boolean on) {
		if (styleForm.partsOffered()) {
			styleForm.useParts(on);
		}
	}
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

	/** (U3) Your own words instead of a Style: words typed in the style field, or "Own words" picked (U2: free text = no Style). */
	public boolean ownWords() {
		return ownWordsMode || !styleText.value().isBlank();
	}

	/** (U3) Own words: the words field becomes the style (the Style's untouched suggestions stay until a Style is picked again). */
	public void useOwnWords() {
		ownWordsMode = true;
		if (styleText.value().isBlank() && !styleNote.value().isBlank()) {
			styleText.set(styleNote.value().length() > DesignSpec.MAX_STYLE ? styleNote.value().substring(0, DesignSpec.MAX_STYLE) : styleNote.value());
			styleNote.clear();
		}
	}

	/** (U3) The style note as sent: only with a Style picked (not your own words, not a set-mode bible's own text). */
	public String noteSent() {
		return ownWords() || styleForm.base() == null ? "" : styleNote.value().strip();
	}

	/** The style sent: the free text when typed, else the picked Style (a built-in's id, as the chips sent before U2; else its name). */
	public String style() {
		String t = styleText.value().strip();
		if (!t.isEmpty() || ownWordsMode) {
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
		return !ownWords() && b != null && StyleForm.PRESET.equals(b.kind()) ? b.id() : null;
	}

	/** A style chip: picks that built-in Style (its materials and suggested features) and clears the free text. */
	public void pickChip(String id) {
		// (U5) the helper's record when it lists one (it knows the built-in's own parts: rustic's), else the kit's fallback
		StyleForm.Style s = SetFeature.bible(id).filter(dev.larattalabs.architect.api.Bible::builtin).map(StyleForm.Style::of).orElse(StyleForm.Style
			.preset(Palettes.FALLBACK, id));
		if (s == null) {
			styleText.set(id);
			return;
		}
		styleForm.pick(s);
		styleText.clear();
		ownWordsMode = false;
	}

	/**
	 * A Style from the Style browser: picked, whoever made it (U5). A Style with its own parts offers "Use this style's parts": on at
	 * once for a Claude-made one (set mode, as before), off for any other (the hybrid: materials plus its look as guidance).
	 */
	public void pickBible(dev.larattalabs.architect.api.@Nullable Bible b) {
		if (b != null) {
			styleForm.pick(StyleForm.Style.of(b));
			styleText.clear();
		}
		ownWordsMode = false;
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
		if (ownWords() || bible() != null || styleForm.base() == null) {
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
		// (U3) words alongside the Style go first in the notes
		return new DesignSpec.Draft(typeSent(), style(), materials.value(), features(), m[0], m[1], m[2], PLOT.equals(size) ? plot : null, remix,
			name.value(), dev.larattalabs.architect.design.StyleNote.compose(noteSent(), notes.value()), OTHER.equals(type) ? profile : List.of(), bible());
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
		// (U5b) set mode with the Style's parts: pin the version the player picked
		if (bibleVersion() != null && r.has("bible")) {
			r.addProperty("bibleVersion", bibleVersion());
		}
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
		o.addProperty("bible", bible());
		o.addProperty("bibleVersion", bibleVersion());
		o.addProperty("partsOffered", styleForm.partsOffered());
		o.addProperty("useParts", styleForm.usePartsChosen());
		o.addProperty("style", style());
		o.addProperty("styleChip", styleChip());
		o.add("styleForm", styleForm.view());
		JsonElement pal = palette();
		o.add("palette", pal == null ? com.google.gson.JsonNull.INSTANCE : pal);
		o.addProperty("styleText", styleText.value());
		o.addProperty("styleNote", styleNote.value());
		o.addProperty("ownWords", ownWords());
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
