package dev.larattalabs.architect.api;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A design request (docs/CONTRACT.md "Protocol" {@code DesignRequest}, plus review 1's fields, phase 4b's and phase 4c's).
 *
 * @param type a preset building type ({@code house, cabin, cottage, tower, shop, tavern, barn, smithy, chapel, gatehouse,
 *     custom}) or, since 1.2.0 with a 4b helper, an open type ({@code [a-z][a-z0-9_]{0,39}}, e.g. {@code hellish_lair})
 * @param maxSize x/z 7..96, y 6..64
 * @param remix a library id to remix, or null
 * @param owner, ext, model, budgetUsd sent to the sidecar only when it speaks protocol 2; owner and ext are kept by the mod
 *              either way ({@link Designs#list}, ext copied into the new entry)
 * @param bible a style bible id (since 1.2.0, a 4b helper): the design uses its roles, prose and components; null = none
 * @param group not sent: a group's items are made with {@link Designs#requestGroup}, and a request carrying a group is
 *     refused (kept for the 1.1.0 shape)
 * @param profile (since 1.2.0) an open type's checker rules ({@code door, roof_closed, floors_reachable, lit, no_floating,
 *     interior, min_interior_volume:<n>, passage:<w>x<h>, tall:<ratio>}); empty = {@code door, lit, no_floating}. Preset
 *     types keep their own profiles and ignore it
 * @param bibleVersion (since 1.2.0) the bible version; null = its latest (the sidecar pins it)
 * @param massing (since 1.3.0, a helper with {@code "massing"}) a massing job: a coarse volume design, cents and a minute or
 *     two; {@link SiteEvents#MASSING_DONE} reports it. False = an ordinary design
 * @param fromMassing (since 1.3.0) the detail pass of this massing (binding: part names, boxes within 1, size within 2, roof
 *     forms); the design inherits the massing's bible. A group's massing is approved with {@link Designs#approveGroup} instead
 * @param massingVersion (since 1.3.0) with {@code fromMassing}: the version, or null = its latest (the sidecar pins it)
 * @param context (since 1.3.0) text (at most 4000 characters, a {@link JsonPrimitive}) or a JSON object (at most 4000
 *     characters as JSON) for the brief: the site, the purpose, neighbour lots and the street side; null = none
 * @param critique (since 1.6.0, a helper with {@code "critique"}) critique this design: {@link CritiqueMode#REPORT} (one critic
 *     call) or {@link CritiqueMode#LOOP} (revise on the verdict, install the best round); null or OFF = none (the default).
 *     On a massing request it critiques the massing itself (its own rubric: silhouette, brief, site fit; maxRevisions default 1)
 */
public record DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
	@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
	@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
	@Nullable Integer massingVersion, @Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String versionOf,
	@Nullable String versionOfSite) {
	/** The most characters of a context (text, or JSON as text). */
	public static final int MAX_CONTEXT = 4000;

	public DesignRequest {
		features = features == null ? List.of() : List.copyOf(features);
		ext = ext == null ? new JsonObject() : ext;
		profile = profile == null ? List.of() : List.copyOf(profile);
		if (context != null && context.isJsonNull()) {
			context = null;
		}
		if (critique != null && !critique.on()) {
			critique = null;
		}
	}

	/** The 1.6.0 constructor (no versionOf). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
		@Nullable Integer massingVersion, @Nullable JsonElement context, @Nullable CritiqueSpec critique) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile, bibleVersion, massing,
			fromMassing, massingVersion, context, critique, null, null);
	}

	/**
	 * A copy that designs the next version of {@code entryId} (its {@code notes} are the change request), with the site
	 * {@code siteId} as context (null = none). Since 1.11.0.
	 */
	public DesignRequest versionOf(String entryId, @Nullable String siteId) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, context, critique, entryId, siteId);
	}

	/** The 1.3.0 constructor (no critique). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
		@Nullable Integer massingVersion, @Nullable JsonElement context) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile, bibleVersion, massing,
			fromMassing, massingVersion, context, null);
	}

	/** The 1.1.0 constructor (no profile, no bible version). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, List.of(), null);
	}

	/** The 1.2.0 constructor (no massing fields, no context). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile, bibleVersion, false, null,
			null, null);
	}

	/** A copy with an open type's profile. Since 1.2.0. */
	public DesignRequest withProfile(List<String> rules) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, rules,
			bibleVersion, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite);
	}

	/** A copy designed with a style bible (null version = its latest). Since 1.2.0. */
	public DesignRequest withBible(@Nullable String bibleId, @Nullable Integer version) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bibleId, group, profile,
			version, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite);
	}

	/** A copy that is (true) or is not (false) a massing job. Since 1.3.0. */
	public DesignRequest massing(boolean on) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, on, on ? null : fromMassing, on ? null : massingVersion, context, critique, versionOf, versionOfSite);
	}

	/** A copy that is the detail pass of the massing's latest version. Since 1.3.0. */
	public DesignRequest fromMassing(String massingId) {
		return fromMassing(massingId, null);
	}

	/** A copy that is the detail pass of one massing version (null = its latest). Since 1.3.0. */
	public DesignRequest fromMassing(@Nullable String massingId, @Nullable Integer version) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massingId == null && massing, massingId, massingId == null ? null : version, context, critique, versionOf, versionOfSite);
	}

	/** A copy with a context text (null or blank = none). Since 1.3.0. */
	public DesignRequest withContext(@Nullable String text) {
		return withContext(text == null || text.isBlank() ? null : new JsonPrimitive(text));
	}

	/** A copy with a context: a JSON object, or text as a {@link JsonPrimitive} (null = none). Since 1.3.0. */
	public DesignRequest withContext(@Nullable JsonElement ctx) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, ctx, critique, versionOf, versionOfSite);
	}

	/** A copy critiqued as {@code spec} (null or OFF = none). Since 1.6.0. */
	public DesignRequest critique(@Nullable CritiqueSpec spec) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, context, spec, versionOf, versionOfSite);
	}
}
