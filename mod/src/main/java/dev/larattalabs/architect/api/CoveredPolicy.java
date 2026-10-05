package dev.larattalabs.architect.api;

/**
 * How a removal treats cells of the site that another site covers (docs/CONTRACT.md phase 4e "Removing a covered site").
 * Since 1.5.0.
 * <ul>
 * <li>{@code KEEP} (the default): covered cells stay as they are (the covering site's blocks); every other cell is restored.
 * The site on top later restores the original ground. {@link RemoveResult#handedDown} lists the cells per covering site.</li>
 * <li>{@code CASCADE}: first every site that covers this one is removed, top-down, recursively, as one undo; each is subject
 * to its own blockers, owner rule and refunds, and any refusal stops the whole cascade before anything is written.</li>
 * <li>{@code REFUSE}: refused {@link Reason#COVERED} when another site covers any cell.</li>
 * </ul>
 * New values are only ever appended.
 */
public enum CoveredPolicy {
	KEEP, CASCADE, REFUSE
}
