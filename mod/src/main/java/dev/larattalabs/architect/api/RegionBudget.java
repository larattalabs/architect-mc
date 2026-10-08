package dev.larattalabs.architect.api;

/**
 * A region plan's size: cells the evaluator emits over the plan survey (removed: air written; added: blocks written), its
 * tiles (tile entries over every stage and change-set), the chunks of claim + 2 chunks, and how many of those were never
 * generated (what {@link Regions#prepare} would generate). Since 1.8.0.
 */
public record RegionBudget(long cells, long removed, long added, int tiles, int chunks, int chunksToGenerate) {
}
