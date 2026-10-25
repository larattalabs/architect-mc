package dev.larattalabs.architect.library;

import dev.larattalabs.architect.api.Bible;
import dev.larattalabs.architect.design.DesignSpec;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.jspecify.annotations.Nullable;

/**
 * (Style unification U3) The Style browser's catalogue: which rail a Style sits on, what its detail pane says, and what may be done
 * with it. Built-in Styles (the palette presets) and a mod's Styles (Steward's settlements) are Duplicate-only ({@link Bible#editable()},
 * {@link Bible#modOwned()}); the player's hand-made and Claude-made Styles can be edited (every save is a new version). Archived Styles
 * are left out. Pure.
 */
public final class StyleCatalog {
	public static final String YOURS = "Yours";
	public static final String BUILT_IN = "Built-in";
	public static final String CLAUDE = "Made by Claude";
	public static final String SETTLEMENTS = "Settlements";
	/** The rail's order (the browser's "All" comes first; favourites are its ★ Favourites chip). */
	public static final List<String> RAIL = List.of(YOURS, BUILT_IN, CLAUDE, SETTLEMENTS);

	/** One card: the Style, its rail, how many library designs use it, and the lines of its detail pane. */
	public record Card(Bible bible, String rail, int usedBy, List<String> details) {
		public String id() {
			return bible.id();
		}

		/** "Use this style" always; Edit only for the player's own; Duplicate always (a copy is a new hand-made Style). */
		public boolean canEdit() {
			return bible.editable();
		}

		/** (U5b) "Add parts…": the player's own Style or a built-in (its parts go on a copy); never a mod's. */
		public boolean canAddParts() {
			return !bible.modOwned();
		}
	}

	private StyleCatalog() {
	}

	/** The rail of a Style: a mod's first (even one Claude made for it), then built-in, Claude-made, else the player's own. */
	public static String rail(Bible b) {
		if (b.modOwned()) {
			return SETTLEMENTS;
		}
		if (b.builtin()) {
			return BUILT_IN;
		}
		return "claude".equals(b.origin()) ? CLAUDE : YOURS;
	}

	/** "Built-in", "Made by Claude", "Yours · made by hand", "Steward's settlement Style" ... */
	public static String originLine(Bible b) {
		if (b.modOwned()) {
			String owner = b.owner().orElse("");
			int colon = owner.indexOf(':');
			String mod = colon > 0 ? owner.substring(0, colon) : owner;
			return (mod.equals("steward_mc") ? "Steward's" : mod + "'s") + " settlement Style (duplicate to change it)";
		}
		if (b.builtin()) {
			return "Built-in (duplicate to change it)";
		}
		return "claude".equals(b.origin()) ? "Made by Claude · yours" : "Yours · made by hand";
	}

	/**
	 * (U5b) Whether a Style has its own parts: "Parts: 7" or "No parts · Add parts… (+ New style)" (a built-in's go on your copy; a
	 * mod's: only its owner adds them).
	 */
	public static String partsLine(Bible b) {
		if (b.hasParts()) {
			return "Parts: " + b.parts().size();
		}
		return b.modOwned() ? "No parts (only its owner adds them)" : "No parts · Add parts… (+ New style)" + (b.builtin() ? ": on your copy" : "");
	}

	/**
	 * The helper's Styles plus every built-in one it didn't send (no helper yet, or an older one): the kit's presets checked in with the
	 * mod, as built-in Styles with their metadata. The helper's order first.
	 */
	public static List<Bible> withBuiltins(List<Bible> helper, Palettes p) {
		List<Bible> out = new ArrayList<>(helper);
		java.util.Set<String> have = new java.util.HashSet<>();
		helper.forEach(b -> have.add(b.id()));
		for (String name : p.presets().keySet()) {
			Map<String, String> roles = p.presetRoles(name);
			if (have.contains(name) || roles == null) {
				continue;
			}
			Palettes.Meta m = Palettes.presetMeta(name);
			String label = name.isEmpty() ? name : Character.toUpperCase(name.charAt(0)) + name.substring(1).replace('_', ' ');
			out.add(new Bible(name, label, 1, List.of(1), true, "building", roles, java.util.Optional.empty(), java.util.Optional.empty(), List.of(),
				java.util.Optional.empty(), new com.google.gson.JsonObject(), 1, Bible.Restraint.DEFAULT, false, java.util.Optional.empty(), m == null ? List.of()
					: m.tags(), m == null ? List.of() : m.suggestedFeatures(), m == null || m.blurb().isBlank() ? java.util.Optional.empty()
						: java.util.Optional.of(m.blurb()), java.util.Optional.empty(), "builtin"));
		}
		return out;
	}

	/** How many designs pin each Style (an entry's {@code bible} id). */
	public static Map<String, Integer> usage(Collection<LibraryCard> cards) {
		Map<String, Integer> m = new HashMap<>();
		for (LibraryCard c : cards) {
			if (c.bible() != null) {
				m.merge(c.bible(), 1, Integer::sum);
			}
		}
		return m;
	}

	/** The features' labels ("Chimney, Porch"), unknown ids as they are. */
	public static String features(List<String> ids) {
		List<String> l = new ArrayList<>();
		for (String id : ids) {
			DesignSpec.Choice c = DesignSpec.find(DesignSpec.FEATURES, id);
			l.add(c == null ? id : c.label());
		}
		return String.join(", ", l);
	}

	/**
	 * The catalogue: every Style not archived (or archived but {@code keep}, e.g. the one picked now), in the order given, each on its
	 * rail with its detail lines (origin, version, based on, suggests, used by). {@code nameOf} names a based-on Style (null: its id).
	 */
	public static List<Card> cards(List<Bible> bibles, Map<String, Integer> usage, @Nullable String keep,
		java.util.function.Function<String, @Nullable String> nameOf) {
		List<Card> out = new ArrayList<>();
		for (Bible b : bibles) {
			if (b.archived() && !b.id().equals(keep)) {
				continue;
			}
			int used = usage.getOrDefault(b.id(), 0);
			List<String> d = new ArrayList<>();
			d.add(originLine(b) + (b.builtin() ? "" : " · v" + b.version()));
			d.add(partsLine(b));
			b.basedOn().ifPresent(p -> {
				String n = nameOf.apply(p.id());
				d.add("Based on " + (n == null ? p.id() : n) + " v" + p.version());
			});
			b.blurb().filter(s -> !s.isBlank()).ifPresent(d::add);
			if (!b.suggestedFeatures().isEmpty()) {
				d.add("Suggests: " + features(b.suggestedFeatures()));
			}
			d.add(used == 0 ? "Not used by your designs yet" : "Used by " + used + " of your designs");
			out.add(new Card(b, rail(b), used, List.copyOf(d)));
		}
		return out;
	}
}
