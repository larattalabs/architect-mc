package dev.larattalabs.architect.design;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * The rules of the Design tab's "Design a set…" dialog (docs/CONTRACT.md phase 4b "Design groups (A2, R9)"): a name, a style
 * bible, up to 24 items (a type, a name, landmark or ordinary, notes), the concurrency and an optional budget; validation with
 * the sidecar's limits and the exact {@code GroupRequest} JSON sent ({@code design.group} and {@code design.estimate}).
 * Landmarks are anchors (wave 0, designed first with the landmark model); the others are wave 1 and see their renders.
 * Pure logic, no Minecraft classes.
 */
public final class SetSpec {
	public static final int MAX_ITEMS = 24;
	public static final int MAX_NAME = 60;
	public static final int MIN_CONCURRENCY = 1;
	public static final int MAX_CONCURRENCY = 6;
	public static final int DEFAULT_CONCURRENCY = 3;

	/** One item of the set: its type (a preset or an open type), name, role and notes (blank = omitted). */
	public record Item(String type, @Nullable String name, boolean landmark, @Nullable String notes) {
	}

	/** The whole set as the dialog holds it. {@code budgetUsd} null = no budget. */
	public record Draft(String name, @Nullable String bible, List<Item> items, int concurrency, @Nullable Double budgetUsd) {
		public Draft {
			items = List.copyOf(items);
		}
	}

	private SetSpec() {
	}

	/** Field -> problem (empty = the sidecar accepts it). Keys: name, bible, items, item<n> (1-based), concurrency, budget. */
	public static Map<String, String> validate(Draft d) {
		Map<String, String> e = new LinkedHashMap<>();
		if (DesignSpec.blank(d.name())) {
			e.put("name", "name the set");
		} else if (d.name().strip().length() > MAX_NAME) {
			e.put("name", "at most " + MAX_NAME + " characters");
		}
		if (DesignSpec.blank(d.bible())) {
			e.put("bible", "pick a bible, or draft a new one from a prompt");
		}
		if (d.items().isEmpty()) {
			e.put("items", "add at least one building");
		} else if (d.items().size() > MAX_ITEMS) {
			e.put("items", "at most " + MAX_ITEMS + " buildings (" + d.items().size() + ")");
		}
		for (int i = 0; i < d.items().size(); i++) {
			Item it = d.items().get(i);
			String t = it.type() == null ? "" : it.type().strip().toLowerCase(Locale.ROOT);
			String why = null;
			if (t.isEmpty()) {
				why = "a type";
			} else if (!DesignSpec.isPreset(t) && !DesignSpec.OPEN_TYPE.matcher(t).matches()) {
				why = "type: a-z, 0-9 and _, starting with a letter";
			} else if (!DesignSpec.blank(it.name()) && it.name().strip().length() > DesignSpec.MAX_NAME) {
				why = "name: at most " + DesignSpec.MAX_NAME + " characters";
			} else if (it.notes() != null && it.notes().length() > DesignSpec.MAX_NOTES) {
				why = "notes: at most " + DesignSpec.MAX_NOTES + " characters";
			}
			if (why != null) {
				e.put("item" + (i + 1), why);
			}
		}
		if (d.concurrency() < MIN_CONCURRENCY || d.concurrency() > MAX_CONCURRENCY) {
			e.put("concurrency", "1 to 6 at once");
		}
		if (d.budgetUsd() != null && (d.budgetUsd() <= 0 || d.budgetUsd() > 1000)) {
			e.put("budget", "a budget is above $0 and at most $1000");
		}
		return e;
	}

	/**
	 * The {@code GroupRequest} as sent. Every item gets the bible's name as its style (the bible carries the look), the M
	 * size of its type (L for a landmark), the default profile for an open type; a landmark is an anchor
	 * ({@code role: landmark}, wave 0).
	 * {@code bibleName} null = the bible id.
	 */
	public static JsonObject groupJson(Draft d, @Nullable String bibleName) {
		JsonObject g = new JsonObject();
		g.addProperty("name", d.name().strip());
		g.addProperty("bible", d.bible());
		g.addProperty("concurrency", d.concurrency());
		if (d.budgetUsd() != null) {
			g.addProperty("budgetUsd", d.budgetUsd());
		}
		String style = style(bibleName == null ? d.bible() : bibleName);
		JsonArray items = new JsonArray();
		for (Item it : d.items()) {
			String type = it.type().strip().toLowerCase(Locale.ROOT);
			JsonObject r = new JsonObject();
			r.addProperty("type", type);
			r.addProperty("style", style);
			r.add("features", new JsonArray());
			int[] m = DesignSpec.preset(it.landmark() ? "L" : "M", DesignSpec.isPreset(type) ? type : "custom");
			JsonObject size = new JsonObject();
			size.addProperty("x", m[0]);
			size.addProperty("y", m[1]);
			size.addProperty("z", m[2]);
			r.add("maxSize", size);
			if (!DesignSpec.blank(it.name())) {
				r.addProperty("name", it.name().strip());
			}
			if (!DesignSpec.blank(it.notes())) {
				r.addProperty("notes", it.notes());
			}
			if (!DesignSpec.isPreset(type)) {
				JsonArray p = new JsonArray();
				DesignSpec.DEFAULT_PROFILE.forEach(p::add);
				r.add("profile", p);
			}
			r.addProperty("role", it.landmark() ? "landmark" : "ordinary");
			if (it.landmark()) {
				r.addProperty("anchor", true);
			}
			items.add(r);
		}
		g.add("items", items);
		return g;
	}

	/** A style line from a bible's name: at most 40 characters, never blank. */
	public static String style(@Nullable String s) {
		String t = s == null || s.isBlank() ? "the style bible" : s.strip();
		return t.length() > DesignSpec.MAX_STYLE ? t.substring(0, DesignSpec.MAX_STYLE) : t;
	}
}
