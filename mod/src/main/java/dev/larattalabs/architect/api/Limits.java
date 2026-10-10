package dev.larattalabs.architect.api;

import java.util.regex.Pattern;

/**
 * The bounds of request fields, the same as the helper's (sidecar {@code protocol.ts} zod schemas) for {@link DesignRequest},
 * {@link GroupRequest} and its items, {@link BibleRequest}, {@link CritiqueSpec}, {@link PolishRequest} and massing redirect
 * notes (docs/CONTRACT.md phase 6c slice 0c §5). A request over one fails in the mod, before anything is sent, with
 * {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}); its message gives the path and the limit
 * ({@code items[3].request.style: 47 characters, at most 40}). The rule is zod's: trimmed where zod trims, the length in UTF-16
 * code units ({@link String#length}), and the pattern where zod has one. A sidecar test keeps these equal to the zod bounds.
 * Since 1.12.0.
 */
public final class Limits {
	private Limits() {
	}

	// ---- DesignRequest (and a group item's request)
	/** {@code style}, trimmed: 1-40. */
	public static final int STYLE_MAX = 40;
	/** {@code materials}, trimmed. */
	public static final int MATERIALS_MAX = 200;
	/** {@code features}: at most 6, each {@link #FEATURE_RE}. */
	public static final int FEATURES_MAX = 6;
	public static final Pattern FEATURE_RE = Pattern.compile("^[a-z][a-z0-9_]{0,31}$");
	/** {@code name}, trimmed: 1-40. */
	public static final int NAME_MAX = 40;
	/** {@code notes} (not trimmed). */
	public static final int NOTES_MAX = 2000;
	/** {@code remix}: a library id. */
	public static final int REMIX_MAX = 64;
	/** {@code profile}: at most 12 rules. */
	public static final int PROFILE_MAX = 12;
	/** {@code owner}, trimmed (every request). */
	public static final int OWNER_MAX = 200;
	/** {@code ext}: each key at most 200 characters, the whole at most 64 KB as JSON (every request). */
	public static final int EXT_KEY_MAX = 200;
	public static final int EXT_MAX_BYTES = 65536;
	/** {@code model}, trimmed, {@link #MODEL_ID_RE} (every request and critique). */
	public static final int MODEL_ID_MAX = 100;
	public static final Pattern MODEL_ID_RE = Pattern.compile("^[A-Za-z0-9._:@/\\[\\]-]+$");
	/** {@code group} (set by Architect for a group's designs). */
	public static final int GROUP_ID_MAX = 200;
	/** {@code context}: text (trimmed) or JSON, at most 4000 characters. */
	public static final int CONTEXT_MAX = 4000;
	/** A plot's {@code dimension}. */
	public static final int PLOT_DIMENSION_MAX = 200;

	// ---- GroupRequest
	/** {@code name}, trimmed: 1-60. */
	public static final int GROUP_NAME_MAX = 60;
	/** {@code items}: 1-24. */
	public static final int GROUP_ITEMS_MAX = 24;
	/** An item's {@code itemKey}: {@link #ITEM_KEY_RE}, at most 100. */
	public static final int ITEM_KEY_MAX = 100;
	public static final Pattern ITEM_KEY_RE = Pattern.compile("^[A-Za-z0-9_.:/-]+$");

	// ---- CritiqueSpec
	/** {@code views}: at most 5. */
	public static final int CRITIQUE_VIEWS_MAX = 5;
	/** {@code extraCriteria}: at most 3, each trimmed 1-200. */
	public static final int EXTRA_CRITERIA_MAX = 3;
	public static final int EXTRA_CRITERION_MAX = 200;

	// ---- BibleRequest
	/** {@code prompt}, trimmed: 1-2000. */
	public static final int BIBLE_PROMPT_MAX = 2000;
	/** {@code name}, trimmed. */
	public static final int BIBLE_NAME_MAX = 40;
	/** {@code references}: at most 8 library ids, each at most 64. */
	public static final int BIBLE_REFERENCES_MAX = 8;
	public static final int BIBLE_REFERENCE_MAX = 64;

	// ---- PolishRequest
	/** {@code issues} and {@code parts}: at most 3 each. */
	public static final int POLISH_ISSUES_MAX = 3;
	public static final int POLISH_PARTS_MAX = 3;
	/** {@code notes}, trimmed: 1-500. */
	public static final int POLISH_NOTES_MAX = 500;
	/** {@code apply}'s sites: at most 256 ids, each at most 200. */
	public static final int POLISH_SITES_MAX = 256;
	public static final int POLISH_SITE_MAX = 200;

	// ---- massing redirects
	/** Redirect notes, trimmed: 1-2000. */
	public static final int REDIRECT_NOTES_MAX = 2000;
}
