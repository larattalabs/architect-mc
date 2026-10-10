package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import dev.larattalabs.architect.api.BibleRequest;
import dev.larattalabs.architect.api.BlockSize;
import dev.larattalabs.architect.api.CritiqueMode;
import dev.larattalabs.architect.api.CritiqueSpec;
import dev.larattalabs.architect.api.DesignRequest;
import dev.larattalabs.architect.api.GroupRequest;
import dev.larattalabs.architect.api.Limits;
import dev.larattalabs.architect.api.PolishApply;
import dev.larattalabs.architect.api.PolishRequest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.IntFunction;
import org.junit.jupiter.api.Test;

/** 6c slice 0c §5, gate item 4 (unit): every {@link Limits} constant at its boundary (passes) and one past it (refused, with the path). */
class FieldLimitsTest {
	static String s(int n) {
		return "a".repeat(n);
	}

	static List<String> l(int n, String v) {
		return new ArrayList<>(Collections.nCopies(n, v));
	}

	static List<String> distinct(int n, String prefix) {
		List<String> out = new ArrayList<>();
		for (int i = 0; i < n; i++) {
			out.add(prefix + (char) ('a' + i));
		}
		return out;
	}

	static DesignRequest design(String style, String materials, List<String> features, String name, String notes, String remix, List<String> profile,
		String owner, JsonObject ext, String model, String group, com.google.gson.JsonElement context, CritiqueSpec critique) {
		return new DesignRequest("cabin", style, materials, features, new BlockSize(15, 12, 15), name, notes, remix, owner, ext, model, null, null, group,
			profile, null, false, null, null, context, critique);
	}

	static DesignRequest base() {
		return design("rustic", null, List.of(), null, null, null, List.of(), null, new JsonObject(), null, null, null, null);
	}

	/** A field at {@code max} passes; at {@code max + 1} fails, naming {@code path}. */
	static void bound(String path, int max, IntFunction<String> check) {
		assertNull(check.apply(max), path + " at " + max);
		String why = check.apply(max + 1);
		assertNotNull(why, path + " past " + max);
		assertTrue(why.startsWith(path + ":") && why.contains(String.valueOf(max)), why);
	}

	static JsonObject extOf(int jsonChars) {
		JsonObject o = new JsonObject();
		o.addProperty("k", "");
		int pad = jsonChars - o.toString().length();
		o.addProperty("k", "x".repeat(pad));
		assertEquals(jsonChars, o.toString().length());
		return o;
	}

	@Test
	void designRequestFields() {
		bound("style", Limits.STYLE_MAX, n -> FieldLimits.design("", design(s(n), null, List.of(), null, null, null, List.of(), null, null, null, null, null,
			null)));
		bound("materials", Limits.MATERIALS_MAX, n -> FieldLimits.design("", design("x", s(n), List.of(), null, null, null, List.of(), null, null, null, null,
			null, null)));
		bound("features", Limits.FEATURES_MAX, n -> FieldLimits.design("", design("x", null, distinct(n, "f"), null, null, null, List.of(), null, null, null,
			null, null, null)));
		bound("name", Limits.NAME_MAX, n -> FieldLimits.design("", design("x", null, List.of(), s(n), null, null, List.of(), null, null, null, null, null,
			null)));
		bound("notes", Limits.NOTES_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, s(n), null, List.of(), null, null, null, null, null,
			null)));
		bound("remix", Limits.REMIX_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, s(n), List.of(), null, null, null, null, null,
			null)));
		bound("profile", Limits.PROFILE_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, l(n, "door"), null, null, null, null,
			null, null)));
		bound("owner", Limits.OWNER_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), s(n), null, null, null, null,
			null)));
		bound("ext", Limits.EXT_MAX_BYTES, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), null, extOf(n), null, null,
			null, null)));
		bound("ext", Limits.EXT_KEY_MAX, n -> {
			JsonObject e = new JsonObject();
			e.addProperty(s(n), 1);
			return FieldLimits.ext("ext", e);
		});
		bound("model", Limits.MODEL_ID_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), null, null, s(n), null,
			null, null)));
		bound("group", Limits.GROUP_ID_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), null, null, null, s(n),
			null, null)));
		bound("context", Limits.CONTEXT_MAX, n -> FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), null, null, null, null,
			new JsonPrimitive(s(n)), null)));
		// trimmed where zod trims: 40 characters plus spaces pass; notes are not trimmed
		assertNull(FieldLimits.design("", design("  " + s(40) + "  ", null, List.of(), null, null, null, List.of(), null, null, null, null, null, null)));
		assertNotNull(FieldLimits.design("", design("x", null, List.of(), null, " " + s(2000), null, List.of(), null, null, null, null, null, null)));
		// patterns
		assertNotNull(FieldLimits.design("", design("x", null, List.of("Porch"), null, null, null, List.of(), null, null, null, null, null, null)));
		assertNotNull(FieldLimits.design("", design("x", null, List.of(), null, null, null, List.of(), null, null, "bad model", null, null, null)));
		assertNull(FieldLimits.design("", base()));
	}

	@Test
	void critiqueFields() {
		CritiqueSpec ok = new CritiqueSpec(CritiqueMode.REPORT, null, s(Limits.MODEL_ID_MAX), null, null, null, null, CritiqueSpec.VIEWS, null, l(
			Limits.EXTRA_CRITERIA_MAX, s(Limits.EXTRA_CRITERION_MAX)));
		assertNull(FieldLimits.critique("critique", ok));
		assertEquals(Limits.CRITIQUE_VIEWS_MAX, CritiqueSpec.VIEWS.size());
		// past the bounds the record itself refuses at construction (IllegalArgumentException, before 1.12.0 too)
		org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class, () -> new CritiqueSpec(CritiqueMode.REPORT, null, null, null, null, null,
			null, List.of(), null, l(Limits.EXTRA_CRITERIA_MAX + 1, "x")));
		org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class, () -> new CritiqueSpec(CritiqueMode.REPORT, null, null, null, null, null,
			null, List.of(), null, List.of(s(Limits.EXTRA_CRITERION_MAX + 1))));
		org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class, () -> new CritiqueSpec(CritiqueMode.REPORT, null, s(Limits.MODEL_ID_MAX
			+ 1), null, null, null, null, List.of(), null, List.of()));
	}

	@Test
	void groupFields() {
		GroupRequest.Item it = GroupRequest.Item.of("k1", base());
		bound("name", Limits.GROUP_NAME_MAX, n -> FieldLimits.group(new GroupRequest(s(n), "birch", null, null, new JsonObject(), null, null, List.of(it),
			false, null, null, null, null)));
		bound("items", Limits.GROUP_ITEMS_MAX, n -> {
			List<GroupRequest.Item> items = new ArrayList<>();
			for (int i = 0; i < n; i++) {
				items.add(GroupRequest.Item.of("k" + i, base()));
			}
			return FieldLimits.group(new GroupRequest("g", "birch", null, null, new JsonObject(), null, null, items, false, null, null, null, null));
		});
		bound("items[0].itemKey", Limits.ITEM_KEY_MAX, n -> FieldLimits.group(new GroupRequest("g", "birch", null, null, new JsonObject(), null, null, List.of(
			GroupRequest.Item.of(s(n), base())), false, null, null, null, null)));
		bound("items[3].request.style", Limits.STYLE_MAX, n -> {
			List<GroupRequest.Item> items = new ArrayList<>();
			for (int i = 0; i < 3; i++) {
				items.add(GroupRequest.Item.of("k" + i, base()));
			}
			items.add(GroupRequest.Item.of("k3", design(s(n), null, List.of(), null, null, null, List.of(), null, null, null, null, null, null)));
			return FieldLimits.group(new GroupRequest("g", "birch", null, null, new JsonObject(), null, null, items, false, null, null, null, null));
		});
		String why = FieldLimits.group(new GroupRequest("g", "birch", null, null, new JsonObject(), null, null, List.of(GroupRequest.Item.of("k", design(s(41),
			null, List.of(), null, null, null, List.of(), null, null, null, null, null, null))), false, null, null, null, null));
		assertEquals("items[0].request.style: 41 characters, at most 40", why);
	}

	@Test
	void bibleFields() {
		bound("prompt", Limits.BIBLE_PROMPT_MAX, n -> FieldLimits.bible(new BibleRequest(s(n), null, null, new JsonObject(), null, null, List.of(), null, null,
			false)));
		bound("name", Limits.BIBLE_NAME_MAX, n -> FieldLimits.bible(new BibleRequest("p", s(n), null, new JsonObject(), null, null, List.of(), null, null,
			false)));
		bound("references", Limits.BIBLE_REFERENCES_MAX, n -> FieldLimits.bible(new BibleRequest("p", null, null, new JsonObject(), null, null, l(n, "cabin"),
			null, null, false)));
		bound("references[0]", Limits.BIBLE_REFERENCE_MAX, n -> FieldLimits.bible(new BibleRequest("p", null, null, new JsonObject(), null, null, List.of(s(
			n)), null, null, false)));
	}

	@Test
	void polishAndRedirectFields() {
		bound("issues", Limits.POLISH_ISSUES_MAX, n -> FieldLimits.polish(new PolishRequest("e", null, new ArrayList<>(Collections.nCopies(n, 0)), null, null,
			2, null, null, null, new JsonObject(), null)));
		bound("parts", Limits.POLISH_PARTS_MAX, n -> FieldLimits.polish(new PolishRequest("e", null, null, l(n, "roof"), null, 2, null, null, null,
			new JsonObject(), null)));
		bound("notes", Limits.POLISH_NOTES_MAX, n -> FieldLimits.polish(new PolishRequest("e", null, null, null, s(n), 2, null, null, null, new JsonObject(),
			null)));
		bound("apply.siteIds", Limits.POLISH_SITES_MAX, n -> FieldLimits.polish(new PolishRequest("e", null, null, null, null, 2, null, null, null,
			new JsonObject(), new PolishApply(l(n, "s1"), false))));
		bound("apply.siteIds[0]", Limits.POLISH_SITE_MAX, n -> FieldLimits.polish(new PolishRequest("e", null, null, null, null, 2, null, null, null,
			new JsonObject(), new PolishApply(List.of(s(n)), false))));
		bound("notes", Limits.REDIRECT_NOTES_MAX, n -> FieldLimits.redirect(s(n), null));
		bound("owner", Limits.OWNER_MAX, n -> FieldLimits.redirect("x", s(n)));
	}

	@Test
	void plotDimensionAndPatternsAreConstants() {
		assertEquals(200, Limits.PLOT_DIMENSION_MAX);
		assertTrue(Limits.FEATURE_RE.matcher("big_windows").matches());
		assertTrue(Limits.ITEM_KEY_RE.matcher("lot:3/a").matches());
		assertTrue(Limits.MODEL_ID_RE.matcher("claude-opus-5-5[1m]").matches());
	}
}
