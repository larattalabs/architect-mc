package dev.larattalabs.architect.api;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
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
 * @param opKey (since 1.10.0) the caller's operation key ({@code [A-Za-z0-9_.:-]{1,128}}), scoped by (owner, kind, opKey); a null
 *     owner means the player. Sending again with the same key and the same body returns the first operation and starts no new
 *     work (in any state); with a different body the future fails {@link ArchitectRefused} {@link Reason#OP_KEY_CONFLICT}.
 *     Bodies are compared by the sha256 of the request's canonical JSON without the key. Kept as long as the record, and at
 *     least 30 days after it is final. See {@link Bibles#jobByKey}.
 * @param rarity (since 1.35.0, 6c VOC, S-VOC-1/S-VOC-5) the style's rarity budget, copied by code into the made bible's {@code rarity}
 *     member (the prompt is unchanged, N-VOC-1); null: none (the bible is measured at the defaults, into metrics only)
 */
public record BibleRequest(String prompt, @Nullable String name, @Nullable String owner, JsonObject ext, @Nullable String model,
	@Nullable Double budgetUsd, List<String> references, @Nullable String scope, @Nullable String seedPreset, boolean sheetCritique,
	@Nullable String opKey, @Nullable Rarity rarity) {
	/**
	 * A bible's rarity budget (docs/CONTRACT.md "Phase 6c slice VOC" §4.1; kit/lib/vocab/rarity.mjs holds the schema, the limits and the
	 * defaults). Every member is optional (null: the default, or free for {@code colours}). Shares are over a design's non-air cells (a
	 * region's non-terrain written cells); the blocks the bible's roles, patterns and {@code allow} name are the style's own and exempt
	 * from the shares; precious cells are counted everywhere. Since 1.35.0.
	 *
	 * @param uncommonShareMax 0..0.5 (default 0.10)
	 * @param rareShareMax 0..0.25 (default 0.02)
	 * @param preciousMax precious cells per building, 0..64 (default 0)
	 * @param preciousRegionMax precious cells per region, 0..256 (default 0)
	 * @param families a per-family share cap, {@code {family: 0..1}}
	 * @param colours the dye colours the style uses (free when null)
	 * @param coloursMax 1..16 (default 3)
	 * @param rareFamiliesMax 1..8 (default 2)
	 * @param allow blocks or {@code #tags} counted as the style's own
	 */
	public record Rarity(@Nullable Double uncommonShareMax, @Nullable Double rareShareMax, @Nullable Integer preciousMax,
		@Nullable Integer preciousRegionMax, @Nullable Map<String, Double> families, @Nullable List<String> colours, @Nullable Integer coloursMax,
		@Nullable Integer rareFamiliesMax, @Nullable List<String> allow) {
		public Rarity {
			families = families == null ? null : Map.copyOf(families);
			colours = colours == null ? null : List.copyOf(colours);
			allow = allow == null ? null : List.copyOf(allow);
		}

		/** No member set: every default. */
		public static Rarity defaults() {
			return new Rarity(null, null, null, null, null, null, null, null, null);
		}

		/** The bible member as JSON: only the members set, families in name order (the wire's and the bible's shape). */
		public JsonObject toJson() {
			JsonObject o = new JsonObject();
			if (uncommonShareMax != null) {
				o.addProperty("uncommonShareMax", uncommonShareMax);
			}
			if (rareShareMax != null) {
				o.addProperty("rareShareMax", rareShareMax);
			}
			if (preciousMax != null) {
				o.addProperty("preciousMax", preciousMax);
			}
			if (preciousRegionMax != null) {
				o.addProperty("preciousRegionMax", preciousRegionMax);
			}
			if (families != null) {
				JsonObject f = new JsonObject();
				new TreeMap<>(families).forEach(f::addProperty);
				o.add("families", f);
			}
			if (colours != null) {
				JsonArray a = new JsonArray();
				colours.forEach(a::add);
				o.add("colours", a);
			}
			if (coloursMax != null) {
				o.addProperty("coloursMax", coloursMax);
			}
			if (rareFamiliesMax != null) {
				o.addProperty("rareFamiliesMax", rareFamiliesMax);
			}
			if (allow != null) {
				JsonArray a = new JsonArray();
				allow.forEach(a::add);
				o.add("allow", a);
			}
			return o;
		}
	}

	/** The 1.10.0 constructor (no rarity). */
	public BibleRequest(String prompt, @Nullable String name, @Nullable String owner, JsonObject ext, @Nullable String model,
		@Nullable Double budgetUsd, List<String> references, @Nullable String scope, @Nullable String seedPreset, boolean sheetCritique,
		@Nullable String opKey) {
		this(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, sheetCritique, opKey, null);
	}

	/** A copy with (or without) a rarity budget. Since 1.35.0. */
	public BibleRequest withRarity(@Nullable Rarity r) {
		return new BibleRequest(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, sheetCritique, opKey, r);
	}

	/** The 1.6.0 constructor (no opKey). */
	public BibleRequest(String prompt, @Nullable String name, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		List<String> references, @Nullable String scope, @Nullable String seedPreset, boolean sheetCritique) {
		this(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, sheetCritique, null);
	}

	/** A copy with an operation key. Since 1.10.0. */
	public BibleRequest withOpKey(@Nullable String key) {
		return new BibleRequest(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, sheetCritique, key, rarity);
	}

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
		return new BibleRequest(prompt, name, owner, ext, model, budgetUsd, references, scope, seedPreset, on, opKey, rarity);
	}

	/** Just a prompt (and an optional name). */
	public static BibleRequest of(String prompt, @Nullable String name) {
		return new BibleRequest(prompt, name, null, null, null, null, List.of(), null, null);
	}
}
