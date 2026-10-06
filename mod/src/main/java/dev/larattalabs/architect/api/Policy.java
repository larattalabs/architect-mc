package dev.larattalabs.architect.api;

/**
 * How a site's undo treats its cells (docs/CONTRACT.md phase 4e "Layering rules"). Since 1.5.0.
 * <ul>
 * <li>{@code BOX}: always restores what was there (a building's restore box: the player's later changes inside it are put back
 * too, the safe remove).</li>
 * <li>{@code CELL}: restores a cell only where the world still holds what the site wrote (roads, cell sites): cells the player
 * changed since are kept and reported ({@link RemoveResult#kept}).</li>
 * </ul>
 */
public enum Policy {
	BOX, CELL
}
