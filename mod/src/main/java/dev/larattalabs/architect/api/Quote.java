package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (M5 QT, Steward's S-M5-7) A read-only, $0 quote of what a survival realise of a plan takes from its owner's stockpile
 * ({@link Regions#quote}, {@link Regions#quoteApproved}): the whole operation's bill per item, in the plan check's {@code cost.bom} shape,
 * with every bound lot entry in it. Nothing is consumed, reserved or written. Since NEXT.
 *
 * <p>{@code bomParts} names each piece the bill sums, as the plan check's {@code cost.bomParts} does: {@code tiles:<group>} (the region's paid
 * cells of that target group, over the plan survey: the kit's own bill), {@code lot:<lot>} (the bound entry's construction bill at the fit the
 * realise places it: template, foundation and approach, less the lot's masked cells and the cells the land holds already), {@code road:<id>}
 * (a 4e road's construction bill over the land now), {@code mech:<lot>} / {@code mech:<gate>} (a gate mechanism's bill: a first realise only;
 * a revision writes none), {@code fluids} (a lava bucket per lava source, an iron bars per grate cell: once per region, so a revision of a
 * region whose fluids were charged has none; the bucket comes back). Later slices add pieces of their own (FK: {@code fill:<lot>}, a filled
 * container's items) with no API change.
 *
 * @param planId the region plan quoted (an artifact's own plan for {@link Regions#quoteApproved})
 * @param artifactSha the artifact quoted, or null for {@link Regions#quote}
 * @param region the standing region a revision plan revises, or null for a first realise
 * @param survival whether the plan realises in survival; false: an INSTANT plan takes nothing ({@code bom} is empty)
 * @param bom item id to count, sorted by id: the whole bill
 * @param bomParts each piece's items (see above)
 * @param lotEntries the lot entries the quote bound ({@code lot -> id} or {@code id@version}): the artifact's own then the given, and a
 *     revision's refills; a lot with none stays a pad and costs nothing here
 * @param exact true when every piece is known to equal what the realise takes, on the land as it is now: false when a lot's bill may drift
 *     (C26's drift sources, or cells in unloaded chunks), when fluids are an upper bound, or when the land under a lot is written by the plan's
 *     own tiles first; {@code notes} say which
 * @param notes why a piece is not exact, and what the quote read
 */
public record Quote(String planId, @Nullable String artifactSha, @Nullable String region, boolean survival, JsonObject bom, JsonObject bomParts,
	java.util.Map<String, String> lotEntries, boolean exact, List<String> notes) {
	public Quote {
		bom = bom == null ? new JsonObject() : bom;
		bomParts = bomParts == null ? new JsonObject() : bomParts;
		lotEntries = lotEntries == null ? java.util.Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(lotEntries));
		notes = notes == null ? List.of() : List.copyOf(notes);
	}
}
