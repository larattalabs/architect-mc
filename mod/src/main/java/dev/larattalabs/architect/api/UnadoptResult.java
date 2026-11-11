package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Map;

/**
 * (6d AD) {@link Regions#unadopt}: the adopted region is gone (its record deleted; nothing written to the world) and every site it held is in
 * a group again: {@code groups} names each site's group (its old group, or a new standalone one), {@code newGroups} the groups made because a
 * site's old group was gone.
 *
 * @since 1.52.0
 */
public record UnadoptResult(String regionId, Map<String, String> groups, List<String> newGroups) {
	public UnadoptResult {
		groups = groups == null ? Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(groups));
		newGroups = newGroups == null ? List.of() : List.copyOf(newGroups);
	}
}
