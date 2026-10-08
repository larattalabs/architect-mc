package dev.larattalabs.architect.api;

import java.util.List;

/**
 * What a polish does with the entry's placed sites once its version installs: {@code siteIds} (empty = every site standing at
 * an older version of the entry); {@code preview} true (the UI's way): the sites show "Update available" with the delta ghost
 * and nothing is written until applied; false (API only): the deltas are queued as one batch with the caller as actor. Since
 * 1.7.0.
 */
public record PolishApply(List<String> siteIds, boolean preview) {
	public PolishApply {
		siteIds = List.copyOf(siteIds);
	}
}
