package dev.larattalabs.architect.api;

import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (VOC-c) An approved plan's palette rules measured with a set of lot entries ({@link Regions#checkPalette}): the cheap pre-check
 * before {@link Regions#realiseApproved}, which refuses {@link Reason#PALETTE} on the same measure for a required rule. The parts' counts
 * are the plan check's (the artifact's {@code palette} rows); each lot bound in the given entries (the artifact's own, then the ones
 * given) is measured from its entry's template (its non-air blocks less the artifact row's unmeasured {@code natural} blocks); a lot
 * with no entry is pending (it stays a pad, so it adds nothing). {@code ok}: every required rule fits. Since 1.37.0.
 *
 * @param ok every required rule fits
 * @param rules each palette rule with lots in its scope, by rule id
 */
public record PaletteCheck(boolean ok, List<Rule> rules) {
	public PaletteCheck {
		rules = List.copyOf(rules);
	}

	/**
	 * One rule measured.
	 *
	 * @param rule the rule's id in the plan
	 * @param required whether the rule is required (only a required rule refuses a realise)
	 * @param family the family or group it measures (vocab/1)
	 * @param shareMin the share's lower bound
	 * @param shareMax the share's upper bound
	 * @param cells the measured cells: the parts' and the bound lots'
	 * @param familyCells those of the family
	 * @param share {@code familyCells / cells}, or null with no measured cell (then it fits)
	 * @param fits the share is within [shareMin, shareMax]
	 * @param worstLot the bound lot that pushes the share furthest out (most cells outside the family when shareMin is above 0, else
	 *     the most family cells), or null
	 * @param lots the lots in the rule's scope that are bound, in id order
	 * @param pendingLots the lots in its scope with no entry
	 */
	public record Rule(String rule, boolean required, String family, double shareMin, double shareMax, long cells, long familyCells, @Nullable Double share,
		boolean fits, @Nullable String worstLot, List<Lot> lots, List<String> pendingLots) {
		public Rule {
			lots = List.copyOf(lots);
			pendingLots = List.copyOf(pendingLots);
		}
	}

	/**
	 * A bound lot measured from its entry.
	 *
	 * @param lot the lot id
	 * @param entry the entry bound ({@code id} or {@code id@version}; the realise places the entry's current template)
	 * @param cells its measured cells
	 * @param familyCells those of the family
	 */
	public record Lot(String lot, String entry, long cells, long familyCells) {
	}
}
