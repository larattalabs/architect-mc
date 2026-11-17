package dev.larattalabs.architect.api;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (M5 QT, Steward's S-M5-7) A read-only, $0 quote of what a survival realise of a plan takes from its owner's stockpile
 * ({@link Regions#quote}, {@link Regions#quoteApproved}): the whole operation's bill per item, in the plan check's {@code cost.bom} shape,
 * with every bound lot entry in it. Nothing is consumed, reserved or written. Since 1.55.0.
 *
 * <p>{@code bomParts} names each piece the bill sums, as the plan check's {@code cost.bomParts} does: {@code tiles:<group>} (the region's paid
 * cells of that target group, over the plan survey: the kit's own bill), {@code lot:<lot>} (the bound entry's construction bill at the fit the
 * realise places it: template, foundation and approach, less the lot's masked cells; its approach stops at the plan's own 4e roads, which stand by then), {@code road:<id>}
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
 *     own tiles first, or (since 1.59.0) when the region's paid cells include natural terrain (dirt, stone, ...) that may already stand in
 *     the land and the quote could not read: a realise skips a cell that already holds its block, so those cells are an upper bound
 *     (consumed at most the quote, never more). Since 1.60.0 (BC) the plan keeps its paid terrain cells by position and the quote reads the
 *     world at each: a cell that already holds its block is left out of {@code tiles:<group>}, so the quote equals what the realise
 *     consumes; only cells in unloaded chunks (or past the kit's cap) stay an upper bound; {@code notes} say which
 * @param notes why a piece is not exact, and what the quote read
 * @param terrain (QL, since 1.62.0, feature {@code "quoteTerrain"}) item id to count, sorted: the part of {@code bom} that comes from the
 *     plan's kept paid terrain cells (plan.json's {@code survivalTerrain}, every group) read at quote time. Its keys are every item of
 *     those cells, <b>including an item whose count is 0</b> (every cell already stands), so a caller can tell a terrain item from any
 *     other; its count is the units those cells bill (cells not holding their block now, plus cells in unloaded chunks, billed with
 *     {@code exact} false), each at most its {@code bom} count ({@code bom} leaves out a 0 item). A cell already standing is in neither.
 *     Everything else in {@code bom} (other tile cells, lots, roads, mechanisms, fluids, fills) is not terrain, nor are natural cells the plan
 *     could not keep (past the kit's cap: an upper bound, they can only bill less). Empty for a creative quote and a plan with no
 *     {@code survivalTerrain}. A terrain cell can change between the quote and the realise (grass over dirt, farmland drying back), so a
 *     caller's {@code maxBill} may allow a little over on these items only; Steward's rule is {@code bom[item] + max(2, ceil(2% of
 *     terrain[item]))} over the union of {@code bom}'s and {@code terrain}'s keys, every other item exact
 */
public record Quote(String planId, @Nullable String artifactSha, @Nullable String region, boolean survival, JsonObject bom, JsonObject bomParts,
	java.util.Map<String, String> lotEntries, boolean exact, List<String> notes, java.util.Map<String, Integer> terrain) {
	public Quote {
		bom = bom == null ? new JsonObject() : bom;
		bomParts = bomParts == null ? new JsonObject() : bomParts;
		lotEntries = lotEntries == null ? java.util.Map.of() : java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(lotEntries));
		notes = notes == null ? List.of() : List.copyOf(notes);
		terrain = terrain == null ? java.util.Map.of() : java.util.Collections.unmodifiableMap(new java.util.TreeMap<>(terrain));
	}

	/** The 1.55.0 shape: no terrain part ({@link #terrain} empty). */
	public Quote(String planId, @Nullable String artifactSha, @Nullable String region, boolean survival, JsonObject bom, JsonObject bomParts,
		java.util.Map<String, String> lotEntries, boolean exact, List<String> notes) {
		this(planId, artifactSha, region, survival, bom, bomParts, lotEntries, exact, notes, null);
	}

	/** (LCAP, since 1.67.0) The pieces of {@code bomParts} that are one lot's own bill, the ones {@link RealiseRequest#maxBillPerLot} caps. */
	public static final List<String> LOT_PIECES = List.of("lot:", "fill:", "mech:");

	/**
	 * (LCAP, S-M5-16, since 1.67.0, feature {@code "maxBillPerLot"}) One lot's own bill, item id to count, sorted: the sum of its
	 * {@code lot:<lot>}, {@code fill:<lot>} and {@code mech:<lot>} pieces. This is what a lot's {@link RealiseRequest#maxBillPerLot} cap is
	 * checked against at put-down (the same quote, read by the realise). Empty for a pad, a lot this quote does not bind, or a creative quote.
	 */
	public java.util.Map<String, Integer> lotBill(String lot) {
		return lotBill(bomParts, lot);
	}

	/** (LCAP, since 1.67.0) {@link #lotBill(String)} over a {@code bomParts} object. */
	public static java.util.Map<String, Integer> lotBill(@Nullable JsonObject bomParts, String lot) {
		java.util.TreeMap<String, Integer> out = new java.util.TreeMap<>();
		if (bomParts == null || lot == null) {
			return java.util.Collections.unmodifiableMap(out);
		}
		for (String p : LOT_PIECES) {
			if (bomParts.get(p + lot) instanceof JsonObject o) {
				o.entrySet().forEach(e -> out.merge(e.getKey(), e.getValue().getAsInt(), Integer::sum));
			}
		}
		out.values().removeIf(v -> v == 0);
		return java.util.Collections.unmodifiableMap(out);
	}
}
