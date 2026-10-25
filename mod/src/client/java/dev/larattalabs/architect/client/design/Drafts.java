package dev.larattalabs.architect.client.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.library.Palettes;
import dev.larattalabs.architect.library.StyleForm;
import dev.larattalabs.architect.library.StyleRoles;
import dev.larattalabs.architect.library.VariantForm;
import dev.larattalabs.architect.placement.Blueprints;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) "Save draft": the design editor as it is, kept on disk so it outlives the session. One draft for a new design
 * ({@code <gameDir>/architect/drafts/design.json}) and one per design for its variant ({@code variant-<entry>.json}). Nothing restores
 * itself: the editor offers "Restore draft" when one is there, and a draft is dropped when its design is sent. The Style is kept by id,
 * with its four main rows and roles, so a restore re-picks it and re-applies the edits. Client thread.
 */
public final class Drafts {
	private Drafts() {
	}

	static Path dir() {
		return Blueprints.gameDataDir().resolve("architect").resolve("drafts");
	}

	static Path designFile() {
		return dir().resolve("design.json");
	}

	static Path variantFile(String entry) {
		return dir().resolve("variant-" + entry.replaceAll("[^A-Za-z0-9_.-]", "_") + ".json");
	}

	private static void write(Path f, JsonObject o) throws IOException {
		Files.createDirectories(f.getParent());
		o.addProperty("savedAt", System.currentTimeMillis());
		Path tmp = f.resolveSibling(f.getFileName() + ".tmp");
		Files.writeString(tmp, o.toString(), StandardCharsets.UTF_8);
		Files.move(tmp, f, java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE);
	}

	private static @Nullable JsonObject read(Path f) {
		try {
			return Files.isRegularFile(f) ? JsonParser.parseString(Files.readString(f, StandardCharsets.UTF_8)).getAsJsonObject() : null;
		} catch (IOException | RuntimeException e) {
			Architect.LOGGER.warn("drafts: {} unreadable ({})", f, e.toString());
			return null;
		}
	}

	/** When the draft was saved (ms), or 0 when there is none. */
	public static long designSavedAt() {
		JsonObject o = read(designFile());
		return o != null && o.has("savedAt") ? o.get("savedAt").getAsLong() : 0;
	}

	public static long variantSavedAt(String entry) {
		JsonObject o = read(variantFile(entry));
		return o != null && o.has("savedAt") ? o.get("savedAt").getAsLong() : 0;
	}

	public static void dropDesign() {
		try {
			Files.deleteIfExists(designFile());
		} catch (IOException e) {
			Architect.LOGGER.warn("drafts: {}", e.toString());
		}
	}

	public static void dropVariant(String entry) {
		try {
			Files.deleteIfExists(variantFile(entry));
		} catch (IOException e) {
			Architect.LOGGER.warn("drafts: {}", e.toString());
		}
	}

	static JsonObject styleOf(StyleForm sf) {
		JsonObject o = new JsonObject();
		StyleForm.Style b = sf.base();
		if (b == null) {
			return o;
		}
		o.addProperty("kind", b.kind());
		if (b.id() != null) {
			o.addProperty("id", b.id());
		}
		o.addProperty("name", b.name());
		o.addProperty("version", b.version());
		if (b.inputs() != null) {
			o.add("inputs", b.inputs().toJson());
		}
		JsonObject base = new JsonObject();
		b.roles().forEach(base::addProperty);
		o.add("baseRoles", base);
		JsonObject main = new JsonObject();
		if (sf.main() != null) {
			sf.main().forEach(main::addProperty);
		}
		o.add("main", main);
		JsonObject roles = new JsonObject();
		sf.roles().forEach(roles::addProperty);
		o.add("roles", roles);
		return o;
	}

	/** Re-picks the saved Style and re-applies its edits (the main rows first, then any role still different). */
	static void restoreStyle(StyleForm sf, JsonObject o, java.util.function.Consumer<StyleForm.Style> pick) {
		if (!o.has("kind")) {
			return;
		}
		String kind = o.get("kind").getAsString();
		Map<String, String> baseRoles = new java.util.LinkedHashMap<>();
		o.getAsJsonObject("baseRoles").entrySet().forEach(e -> baseRoles.put(e.getKey(), e.getValue().getAsString()));
		StyleForm.Style s = kind.equals(StyleForm.INPUTS) && o.has("inputs") ? StyleForm.Style.inputs(Palettes.Inputs.of(o.getAsJsonObject("inputs")),
			StyleRoles.fallback()) : new StyleForm.Style(o.has("id") ? o.get("id").getAsString() : null, o.get("name").getAsString(), o.get("version")
				.getAsInt(), kind, null, baseRoles, java.util.List.of(), java.util.List.of(), false, false);
		// (U5) the helper's record when it has that version (it knows the Style's own parts), for a built-in too
		var installed = s.id() != null && !kind.equals(StyleForm.INPUTS) ? SetFeature.bible(s.id()).filter(b -> b.version() == s.version()) : java.util
			.Optional.<dev.larattalabs.architect.api.Bible>empty();
		pick.accept(installed.map(StyleForm.Style::of).orElse(s));
		JsonObject main = o.getAsJsonObject("main");
		for (String field : StyleRoles.MAIN_FIELDS) {
			if (main.has(field) && sf.main() != null && !main.get(field).getAsString().equals(sf.main().get(field))) {
				try {
					sf.editMain(field, main.get(field).getAsString());
				} catch (RuntimeException e) {
					Architect.LOGGER.warn("drafts: {} {}: {}", field, main.get(field), e.getMessage());
				}
			}
		}
		for (var e : o.getAsJsonObject("roles").entrySet()) {
			if (!e.getValue().getAsString().equals(sf.roles().get(e.getKey()))) {
				try {
					sf.setRole(e.getKey(), e.getValue().getAsString());
				} catch (RuntimeException ex) {
					Architect.LOGGER.warn("drafts: role {}: {}", e.getKey(), ex.getMessage());
				}
			}
		}
	}

	/** Saves the new-design editor. */
	public static void saveDesign(DesignForm f) throws IOException {
		JsonObject o = new JsonObject();
		o.addProperty("type", f.type);
		o.addProperty("openType", f.openType.value());
		JsonArray pr = new JsonArray();
		f.profile.forEach(pr::add);
		o.add("profile", pr);
		o.add("style", styleOf(f.styleForm));
		// (U5b) "Use this style's parts" as chosen
		o.addProperty("useParts", f.styleForm.usePartsChosen());
		o.addProperty("styleText", f.styleText.value());
		o.addProperty("ownWords", f.ownWordsMode);
		o.addProperty("styleNote", f.styleNote.value());
		o.addProperty("materials", f.materials.value());
		JsonArray fe = new JsonArray();
		f.features().forEach(fe::add);
		o.add("features", fe);
		o.addProperty("size", f.size);
		JsonArray c = new JsonArray();
		c.add(f.customX);
		c.add(f.customY);
		c.add(f.customZ);
		o.add("custom", c);
		o.addProperty("name", f.name.value());
		o.addProperty("notes", f.notes.value());
		if (f.massingFirst != null) {
			o.addProperty("massingFirst", f.massingFirst);
		}
		o.addProperty("critique", f.critique);
		o.addProperty("maxRevisions", f.maxRevisions);
		write(designFile(), o);
	}

	/** Restores the new-design draft into {@code f}; false when there is none. */
	public static boolean restoreDesign(DesignForm f) {
		JsonObject o = read(designFile());
		if (o == null) {
			return false;
		}
		f.type = str(o, "type", f.type);
		f.openType.set(str(o, "openType", ""));
		if (o.has("profile")) {
			f.profile.clear();
			o.getAsJsonArray("profile").forEach(e -> f.profile.add(e.getAsString()));
		}
		if (o.has("style") && o.getAsJsonObject("style").has("kind")) {
			restoreStyle(f.styleForm, o.getAsJsonObject("style"), f.styleForm::pick);
		} else {
			f.styleForm.unpick();
		}
		// (U5b) the parts toggle; a draft from before U5 named a Claude-made Style as its set-mode bible: pick it, its parts on
		if (o.has("bible") && !o.get("bible").isJsonNull()) {
			SetFeature.bible(o.get("bible").getAsString()).ifPresent(b -> f.styleForm.pick(StyleForm.Style.of(b)));
			f.setUseParts(true);
		} else if (o.has("useParts")) {
			f.setUseParts(o.get("useParts").getAsBoolean());
		}
		f.styleText.set(str(o, "styleText", ""));
		f.ownWordsMode = o.has("ownWords") && o.get("ownWords").getAsBoolean();
		f.styleNote.set(str(o, "styleNote", ""));
		f.materials.set(str(o, "materials", ""));
		if (o.has("features")) {
			java.util.List<String> l = new java.util.ArrayList<>();
			o.getAsJsonArray("features").forEach(e -> l.add(e.getAsString()));
			try {
				f.styleForm.setFeatures(l);
			} catch (RuntimeException e) {
				Architect.LOGGER.warn("drafts: features: {}", e.getMessage());
			}
		}
		f.size = str(o, "size", f.size);
		if (o.has("custom")) {
			JsonArray c = o.getAsJsonArray("custom");
			f.customX = c.get(0).getAsInt();
			f.customY = c.get(1).getAsInt();
			f.customZ = c.get(2).getAsInt();
		}
		f.name.set(str(o, "name", ""));
		f.notes.set(str(o, "notes", ""));
		f.massingFirst = o.has("massingFirst") ? o.get("massingFirst").getAsBoolean() : null;
		f.critique = o.has("critique") && o.get("critique").getAsBoolean();
		if (o.has("maxRevisions")) {
			f.maxRevisions = o.get("maxRevisions").getAsInt();
		}
		f.sendError = null;
		return true;
	}

	/** Saves a Variants dialog's form. */
	public static void saveVariant(VariantForm v) throws IOException {
		JsonObject o = new JsonObject();
		o.addProperty("from", v.from());
		o.add("style", styleOf(v.style()));
		JsonObject values = new JsonObject();
		for (VariantForm.Param p : v.params()) {
			values.add(p.name(), v.value(p.name()));
		}
		o.add("values", values);
		o.addProperty("name", v.name());
		write(variantFile(v.from()), o);
	}

	/** Restores a variant draft into {@code v} (same entry); false when there is none. */
	public static boolean restoreVariant(VariantForm v) {
		JsonObject o = read(variantFile(v.from()));
		if (o == null) {
			return false;
		}
		if (o.has("style") && o.getAsJsonObject("style").has("kind")) {
			restoreStyle(v.style(), o.getAsJsonObject("style"), v::chooseStyle);
		}
		if (o.has("values")) {
			for (var e : o.getAsJsonObject("values").entrySet()) {
				try {
					JsonElement val = e.getValue();
					v.set(e.getKey(), val.isJsonPrimitive() ? (JsonPrimitive) val : null);
				} catch (RuntimeException ex) {
					Architect.LOGGER.warn("drafts: param {}: {}", e.getKey(), ex.getMessage());
				}
			}
		}
		v.setName(str(o, "name", ""));
		return true;
	}

	private static String str(JsonObject o, String k, String def) {
		return o.has(k) && o.get(k).isJsonPrimitive() ? o.get(k).getAsString() : def;
	}
}
