package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A request for a new style bible ({@code bible.request}, docs/CONTRACT.md phase 4b "Style bible (A1)" and "4b review
 * folded in" items 5 and 7). Since 1.2.0.
 *
 * @param prompt what the place is ("weathered fishing village on stilts"), up to 2000 characters
 * @param name the bible's name (its id is {@code bib_<slug>}); null: from the prompt
 * @param owner by convention {@code <modid>:<thing>}; null = the player
 * @param model null = the sidecar's {@code bibleModel} (claude-opus-5-5)
 * @param budgetUsd a hard stop on the job's estimated cost, or null
 * @param references library entries whose look to learn from (at most 8)
 * @param scope {@code "building"} (default) or {@code "settlement"} (also the macro roles for region programs)
 * @param seedPreset start from a built-in bible (a palette preset name), or null
 * @param sheetCritique (since 1.6.0, a helper with {@code "critique"}) the job ends with one report critique of its
 *     {@code sheet.png} (component legibility and restraint, about $0.05), kept as {@link Bible#critique()}
 */
public record BibleRequest(String prompt, @Nullable String name, @Nullable String owner, JsonObject ext, @Nullable String model,
	@Nullable Double budgetUsd, List<String> references, @Nullable String scope, @Nullable String seedPreset, boolean sheetCritique) {
	public BibleRequest {
		ext = ext == null ? new JsonObject() : ext;
		references = references == null ? List.of() : List.copyOf(references);
	}

	/** The 1.2.0 constructor (no sheet critique). */
	public BibleRequest(String prompt, @Nullable String name, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		List<String> references, @Nullable String scope, @Nullable String seedPreset) {
		this(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, false);
	}

	/** A copy with (or without) the sheet critique. Since 1.6.0. */
	public BibleRequest withSheetCritique(boolean on) {
		return new BibleRequest(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, on);
	}

	/** Just a prompt (and an optional name). */
	public static BibleRequest of(String prompt, @Nullable String name) {
		return new BibleRequest(prompt, name, null, null, null, null, List.of(), null, null);
	}
}
