package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.PolishRequest;
import dev.larattalabs.architect.api.Reason;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;
import org.jspecify.annotations.Nullable;

/**
 * 6c 0c §5: {@link Limits} checked before a request is sent (the helper's zod rules: trimmed where zod trims, UTF-16 length,
 * the pattern where zod has one). Each check returns the first violation ({@code "items[3].request.style: 47 characters, at
 * most 40"}) or null. Pure.
 */
public final class FieldLimits {
	private FieldLimits() {
	}

	/** A failed future with {@link ArchitectRefused} ({@link Reason#FIELD_LIMIT}), or null when {@code why} is null. */
	static <T> @Nullable CompletableFuture<T> refuse(@Nullable String why) {
		return why == null ? null : ApiImpl.onServerFuture(CompletableFuture.failedFuture(new ArchitectRefused(Reason.FIELD_LIMIT, why)));
	}

	private static @Nullable String len(String path, @Nullable String v, int max, boolean trim) {
		if (v == null) {
			return null;
		}
		int n = (trim ? v.strip() : v).length();
		return n > max ? path + ": " + n + " characters, at most " + max : null;
	}

	private static @Nullable String count(String path, @Nullable List<?> l, int max) {
		return l != null && l.size() > max ? path + ": " + l.size() + " entries, at most " + max : null;
	}

	private static @Nullable String pattern(String path, @Nullable String v, Pattern p, boolean trim) {
		return v != null && !p.matcher(trim ? v.strip() : v).matches() ? path + ": \"" + v + "\" doesn't match " + p.pattern() : null;
	}

	private static @Nullable String first(String... why) {
		for (String w : why) {
			if (w != null) {
				return w;
			}
		}
		return null;
	}

	static @Nullable String ext(String path, @Nullable JsonObject ext) {
		if (ext == null) {
			return null;
		}
		for (String k : ext.keySet()) {
			if (k.length() > Limits.EXT_KEY_MAX) {
				return path + ": a key of " + k.length() + " characters, at most " + Limits.EXT_KEY_MAX;
			}
		}
		// zod: JSON.stringify(v).length (UTF-16 units of the compact JSON)
		int n = ext.toString().length();
		return n > Limits.EXT_MAX_BYTES ? path + ": " + n + " characters as JSON, at most " + Limits.EXT_MAX_BYTES : null;
	}

	static @Nullable String context(String path, @Nullable JsonElement c) {
		if (c == null) {
			return null;
		}
		if (c.isJsonPrimitive() && c.getAsJsonPrimitive().isString()) {
			return len(path, c.getAsString(), Limits.CONTEXT_MAX, true);
		}
		int n = c.toString().length();
		return n > Limits.CONTEXT_MAX ? path + ": " + n + " characters as JSON, at most " + Limits.CONTEXT_MAX : null;
	}

	static @Nullable String model(String path, @Nullable String m) {
		return first(len(path, m, Limits.MODEL_ID_MAX, true), pattern(path, m, Limits.MODEL_ID_RE, true));
	}

	public static @Nullable String critique(String path, @Nullable CritiqueSpec c) {
		if (c == null) {
			return null;
		}
		String why = first(model(path + ".model", c.model()), count(path + ".views", c.views(), Limits.CRITIQUE_VIEWS_MAX), count(path + ".extraCriteria",
			c.extraCriteria(), Limits.EXTRA_CRITERIA_MAX));
		if (why != null) {
			return why;
		}
		for (int i = 0; c.extraCriteria() != null && i < c.extraCriteria().size(); i++) {
			why = len(path + ".extraCriteria[" + i + "]", c.extraCriteria().get(i), Limits.EXTRA_CRITERION_MAX, true);
			if (why != null) {
				return why;
			}
		}
		return null;
	}

	public static @Nullable String design(String path, DesignRequest r) {
		String p = path.isEmpty() ? "" : path + ".";
		String why = first(len(p + "style", r.style(), Limits.STYLE_MAX, true), len(p + "materials", r.materials(), Limits.MATERIALS_MAX, true), count(p
			+ "features", r.features(), Limits.FEATURES_MAX), len(p + "name", r.name(), Limits.NAME_MAX, true), len(p + "notes", r.notes(), Limits.NOTES_MAX,
				false), len(p + "remix", r.remix(), Limits.REMIX_MAX, false), count(p + "profile", r.profile(), Limits.PROFILE_MAX), len(p + "owner", r.owner(),
					Limits.OWNER_MAX, true), ext(p + "ext", r.ext()), model(p + "model", r.model()), len(p + "group", r.group(), Limits.GROUP_ID_MAX, false),
			context(p + "context", r.context()), critique(p + "critique", r.critique()));
		if (why != null) {
			return why;
		}
		for (int i = 0; r.features() != null && i < r.features().size(); i++) {
			why = pattern(p + "features[" + i + "]", r.features().get(i), Limits.FEATURE_RE, false);
			if (why != null) {
				return why;
			}
		}
		return null;
	}

	public static @Nullable String group(GroupRequest g) {
		String why = first(len("name", g.name(), Limits.GROUP_NAME_MAX, true), len("owner", g.owner(), Limits.OWNER_MAX, true), ext("ext", g.ext()), count(
			"items", g.items(), Limits.GROUP_ITEMS_MAX), context("context", g.context()), critique("critique", g.critique()));
		if (why != null) {
			return why;
		}
		for (int i = 0; i < g.items().size(); i++) {
			GroupRequest.Item it = g.items().get(i);
			String p = "items[" + i + "]";
			why = first(len(p + ".itemKey", it.itemKey(), Limits.ITEM_KEY_MAX, false), pattern(p + ".itemKey", it.itemKey(), Limits.ITEM_KEY_RE, false), design(p
				+ ".request", it.request()), critique(p + ".critique", it.critique()));
			if (why != null) {
				return why;
			}
		}
		return null;
	}

	public static @Nullable String bible(BibleRequest b) {
		String why = first(len("prompt", b.prompt(), Limits.BIBLE_PROMPT_MAX, true), len("name", b.name(), Limits.BIBLE_NAME_MAX, true), len("owner", b
			.owner(), Limits.OWNER_MAX, true), ext("ext", b.ext()), model("model", b.model()), count("references", b.references(),
				Limits.BIBLE_REFERENCES_MAX));
		for (int i = 0; why == null && i < b.references().size(); i++) {
			why = len("references[" + i + "]", b.references().get(i), Limits.BIBLE_REFERENCE_MAX, false);
		}
		return why;
	}

	public static @Nullable String polish(PolishRequest r) {
		String why = first(count("issues", r.issues(), Limits.POLISH_ISSUES_MAX), count("parts", r.parts(), Limits.POLISH_PARTS_MAX), len("notes", r.notes(),
			Limits.POLISH_NOTES_MAX, true), model("model", r.model()), len("owner", r.owner(), Limits.OWNER_MAX, true), ext("ext", r.ext()));
		if (why == null && r.apply() != null) {
			why = count("apply.siteIds", r.apply().siteIds(), Limits.POLISH_SITES_MAX);
			for (int i = 0; why == null && i < r.apply().siteIds().size(); i++) {
				why = len("apply.siteIds[" + i + "]", r.apply().siteIds().get(i), Limits.POLISH_SITE_MAX, false);
			}
		}
		return why;
	}

	public static @Nullable String redirect(@Nullable String notes, @Nullable String owner) {
		return first(len("notes", notes, Limits.REDIRECT_NOTES_MAX, true), len("owner", owner, Limits.OWNER_MAX, true));
	}

	/** UTF-8 size (unused by zod's rule; kept for messages that want bytes). */
	static int utf8(String s) {
		return s.getBytes(StandardCharsets.UTF_8).length;
	}
}
