package dev.larattalabs.architect.api;

import java.util.List;

/**
 * A detail pass's massing conformance (docs/CONTRACT.md "Phase 4c contract", the kit's {@code build.mjs --massing}): the
 * same part names as the massing, each part's box within 1 block per face, the size within 2, the same roof forms. Errors
 * failed a design round (they went back to the designer); {@code issues} are the warnings of the final design. Since 1.3.0.
 *
 * @param ok whether the final design conforms
 */
public record Conformance(boolean ok, List<String> errors, List<String> issues) {
	public Conformance {
		errors = errors == null ? List.of() : List.copyOf(errors);
		issues = issues == null ? List.of() : List.copyOf(issues);
	}

	/** The warnings a player sees: the errors (if any survived) and the issues. */
	public int warnings() {
		return errors.size() + issues.size();
	}
}
