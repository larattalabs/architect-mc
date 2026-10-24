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
 * @param reserved (since 1.37.0, a helper with {@code "reserved"}; 6c IRR, S-IRR-2) cells of the lot the design must leave as given
 *     (an irrigated farm's sources, their beds and farmland sides and the air over each: the plan-check artifact's
 *     {@code lots[].irrigation.lotCells}), in the lot's frame ({@link Reserved}); the design job leaves them and its checker refuses a
 *     design writing one; null = none. The realise drops any block there anyway
 * @param palette (since NEXT, a helper with {@code "palette.roles"}; Style unification U1) materials only: the design builds with
 *     this palette and its default palette is it: a preset name ({@link JsonPrimitive}), palette inputs ({@code {wood?, stone?,
 *     roof?, accent?}}) or a Style's roles inline ({@code {bible: {id, version, roles}}}, {@link #withStyle}). Never bible set mode
 *     (no shared components, no restraint): {@code bible} excludes it (both set: refused). The entry records it as its
 *     {@code palette}; with roles inline, also {@code {id, version}} as its {@code bible} pin. Null = none (the designer picks)
 *
 * <p>Binary compatibility (Steward's U1 review): every earlier canonical constructor stays as a secondary one (the 14-argument
 * 1.1.0 one Steward calls among them); a later change to this record keeps them all and adds its own.
 */
public record DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
	@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
	@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
	@Nullable Integer massingVersion, @Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String versionOf,
	@Nullable String versionOfSite, @Nullable Reserved reserved, @Nullable JsonElement palette) {
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
		if (palette != null && palette.isJsonNull()) {
			palette = null;
		}
	}

	/**
	 * (Since 1.37.0; 6c IRR, S-IRR-2) A lot's reserved cells, in the lot's frame: the lot seen with its front to the south, {@code x}
	 * across it (0 at its left seen from the street), {@code z} from its back ({@code depth - 1} is the front row), {@code y} from its
	 * floor (0 is the field's level). {@code front} is the lot's real front (north, east, south or west): a design narrower than the
	 * lot is centred across it as the realise centres it, which rounds the other way for a north or east front. The artifact's
	 * {@code lots[].irrigation} carries the same cells ({@code lotCells}, column runs) and the lot's {@code front}.
	 *
	 * @param width the lot across, in the frame
	 * @param depth the lot from back to front, in the frame
	 * @param cells at most {@link #MAX_RESERVED}
	 */
	public record Reserved(String front, int width, int depth, List<net.minecraft.core.BlockPos> cells) {
		public Reserved {
			cells = cells == null ? List.of() : List.copyOf(cells);
		}

		/** The wire form: {@code {front, size: [width, depth], cells: [[x, y, z], ...]}}. */
		public JsonObject wire() {
			JsonObject o = new JsonObject();
			o.addProperty("front", front);
			com.google.gson.JsonArray size = new com.google.gson.JsonArray();
			size.add(width);
			size.add(depth);
			o.add("size", size);
			com.google.gson.JsonArray a = new com.google.gson.JsonArray();
			for (var c : cells) {
				com.google.gson.JsonArray q = new com.google.gson.JsonArray();
				q.add(c.getX());
				q.add(c.getY());
				q.add(c.getZ());
				a.add(q);
			}
			o.add("cells", a);
			return o;
		}
	}

	/** The most reserved cells a request carries. */
	public static final int MAX_RESERVED = Limits.RESERVED_CELLS_MAX;

	/** The 1.37.0 constructor (no palette). Kept for binary compatibility. */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
		@Nullable Integer massingVersion, @Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String versionOf,
		@Nullable String versionOfSite, @Nullable Reserved reserved) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile, bibleVersion, massing,
			fromMassing, massingVersion, context, critique, versionOf, versionOfSite, reserved, null);
	}

	/**
	 * A copy built with this palette, materials only (null = none): a preset name, inputs, or {@code {bible: {id, version, roles}}}.
	 * Since NEXT.
	 */
	public DesignRequest withPalette(@Nullable JsonElement p) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite, reserved, p == null || p.isJsonNull() ? null : p);
	}

	/**
	 * A copy built with a Style's materials only ({@code palette: {bible: {id, version, roles}}} from {@code s}), never bible set mode:
	 * a built-in or hand-made Style's roles, with the designer's own shapes and details. Since NEXT.
	 */
	public DesignRequest withStyle(Bible s) {
		return withPalette(stylePalette(s.id(), s.version(), s.roles()));
	}

	/** The palette JSON of a Style's roles: {@code {bible: {id, version, roles}}}. Since NEXT. */
	public static JsonObject stylePalette(String id, int version, java.util.Map<String, String> roles) {
		JsonObject r = new JsonObject();
		roles.forEach(r::addProperty);
		JsonObject b = new JsonObject();
		b.addProperty("id", id);
		b.addProperty("version", version);
		b.add("roles", r);
		JsonObject o = new JsonObject();
		o.add("bible", b);
		return o;
	}

	/** The 1.11.0 constructor (no reserved). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion, boolean massing, @Nullable String fromMassing,
		@Nullable Integer massingVersion, @Nullable JsonElement context, @Nullable CritiqueSpec critique, @Nullable String versionOf,
		@Nullable String versionOfSite) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile, bibleVersion, massing,
			fromMassing, massingVersion, context, critique, versionOf, versionOfSite, null);
	}

	/** A copy whose design leaves {@code r}'s cells of the lot as given (null = none). Since 1.37.0. */
	public DesignRequest withReserved(@Nullable Reserved r) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite, r, palette);
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
			bibleVersion, massing, fromMassing, massingVersion, context, critique, entryId, siteId, reserved, palette);
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
			bibleVersion, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite, reserved, palette);
	}

	/** A copy designed with a style bible (null version = its latest). Since 1.2.0. */
	public DesignRequest withBible(@Nullable String bibleId, @Nullable Integer version) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bibleId, group, profile,
			version, massing, fromMassing, massingVersion, context, critique, versionOf, versionOfSite, reserved, palette);
	}

	/** A copy that is (true) or is not (false) a massing job. Since 1.3.0. */
	public DesignRequest massing(boolean on) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, on, on ? null : fromMassing, on ? null : massingVersion, context, critique, versionOf, versionOfSite, reserved, palette);
	}

	/** A copy that is the detail pass of the massing's latest version. Since 1.3.0. */
	public DesignRequest fromMassing(String massingId) {
		return fromMassing(massingId, null);
	}

	/** A copy that is the detail pass of one massing version (null = its latest). Since 1.3.0. */
	public DesignRequest fromMassing(@Nullable String massingId, @Nullable Integer version) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massingId == null && massing, massingId, massingId == null ? null : version, context, critique, versionOf, versionOfSite, reserved, palette);
	}

	/** A copy with a context text (null or blank = none). Since 1.3.0. */
	public DesignRequest withContext(@Nullable String text) {
		return withContext(text == null || text.isBlank() ? null : new JsonPrimitive(text));
	}

	/** A copy with a context: a JSON object, or text as a {@link JsonPrimitive} (null = none). Since 1.3.0. */
	public DesignRequest withContext(@Nullable JsonElement ctx) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, ctx, critique, versionOf, versionOfSite, reserved, palette);
	}

	/** A copy critiqued as {@code spec} (null or OFF = none). Since 1.6.0. */
	public DesignRequest critique(@Nullable CritiqueSpec spec) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, profile,
			bibleVersion, massing, fromMassing, massingVersion, context, spec, versionOf, versionOfSite, reserved, palette);
	}
}
