package dev.larattalabs.architect.api;

import java.util.List;
import java.util.Locale;
import java.util.Optional;

/**
 * A collection re-skin ({@code reskin.request}, docs/CONTRACT.md phase 4b "Collections (R10)", "4b review folded in" item 6):
 * one variant per entry of the collection, built with another bible's roles. Free (no Claude; the variant queue). Since 1.2.0.
 *
 * @param bible the bible it re-skins with
 * @param from the collection: {@link Library.CollectionRef}
 * @param variants the variant jobs, one per entry
 * @param entries the new library entries, as they finish (loaded when {@link SiteEvents#RESKIN_DONE} fires)
 * @param error the failed variants' first lines, one per line
 */
public record Reskin(String id, BiblePin bible, Library.CollectionRef from, Status status, String step, List<String> variants, List<String> entries,
	int done, int failed, Optional<String> error, long createdAt, long updatedAt) {
	public Reskin {
		variants = List.copyOf(variants);
		entries = List.copyOf(entries);
	}

	/** {@code building -> done | failed} (done: at least one variant was built). */
	public enum Status {
		BUILDING, DONE, FAILED, UNKNOWN;

		public boolean isFinal() {
			return this == DONE || this == FAILED;
		}

		public static Status of(String s) {
			try {
				return s == null ? UNKNOWN : valueOf(s.toUpperCase(Locale.ROOT));
			} catch (IllegalArgumentException e) {
				return UNKNOWN;
			}
		}
	}

	public boolean finished() {
		return status.isFinal();
	}
}
