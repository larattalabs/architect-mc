package dev.larattalabs.architect.apiimpl;

import org.jspecify.annotations.Nullable;

/**
 * How long the API's futures wait (docs/CONTRACT.md phase 4a; the previous agent's open issue: they never timed out). Read
 * once from a system property or an environment variable:
 * <pre>
 * architect.api.designTimeoutMs  / ARCHITECT_API_DESIGN_TIMEOUT_MS   Designs.request (default 10 min)
 * architect.api.variantTimeoutMs / ARCHITECT_API_VARIANT_TIMEOUT_MS  Library.makeVariant (default 2 min)
 * </pre>
 * Internal.
 */
public final class ApiTimeouts {
	public static final long DESIGN_DEFAULT_MS = 10 * 60_000L;
	public static final long VARIANT_DEFAULT_MS = 2 * 60_000L;
	public static final long DESIGN_MS = read("architect.api.designTimeoutMs", "ARCHITECT_API_DESIGN_TIMEOUT_MS", DESIGN_DEFAULT_MS);
	public static final long VARIANT_MS = read("architect.api.variantTimeoutMs", "ARCHITECT_API_VARIANT_TIMEOUT_MS", VARIANT_DEFAULT_MS);

	private ApiTimeouts() {
	}

	/** A positive number of ms from the property, else the variable, else {@code def}. Pure apart from the lookups. */
	static long parse(@Nullable String prop, @Nullable String env, long def) {
		for (String s : new String[] {prop, env}) {
			if (s != null && !s.isBlank()) {
				try {
					long v = Long.parseLong(s.strip());
					if (v > 0) {
						return v;
					}
				} catch (NumberFormatException ignored) {
					// next
				}
			}
		}
		return def;
	}

	private static long read(String prop, String env, long def) {
		return parse(System.getProperty(prop), System.getenv(env), def);
	}
}
