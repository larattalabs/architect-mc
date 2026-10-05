package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * A design request (docs/CONTRACT.md "Protocol" {@code DesignRequest}, plus review 1's fields and phase 4b's).
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
 */
public record DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
	@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
	@Nullable String bible, @Nullable String group, List<String> profile, @Nullable Integer bibleVersion) {
	public DesignRequest {
		features = features == null ? List.of() : List.copyOf(features);
		ext = ext == null ? new JsonObject() : ext;
		profile = profile == null ? List.of() : List.copyOf(profile);
	}

	/** The 1.1.0 constructor (no profile, no bible version). */
	public DesignRequest(String type, String style, @Nullable String materials, List<String> features, BlockSize maxSize, @Nullable String name,
		@Nullable String notes, @Nullable String remix, @Nullable String owner, JsonObject ext, @Nullable String model, @Nullable Double budgetUsd,
		@Nullable String bible, @Nullable String group) {
		this(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, List.of(), null);
	}

	/** A copy with an open type's profile. Since 1.2.0. */
	public DesignRequest withProfile(List<String> rules) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bible, group, rules,
			bibleVersion);
	}

	/** A copy designed with a style bible (null version = its latest). Since 1.2.0. */
	public DesignRequest withBible(@Nullable String bibleId, @Nullable Integer version) {
		return new DesignRequest(type, style, materials, features, maxSize, name, notes, remix, owner, ext, model, budgetUsd, bibleId, group, profile,
			version);
	}
}
