package dev.larattalabs.architect.api;

/**
 * One layer of the stack at a cell ({@link Sites#stack}): the site it belongs to, its kind ({@code site}, {@code road},
 * {@code leaves}, {@code crate} or a cell site's kind), its policy, its layer number (later changes are higher) and whether it
 * is the top (the one the world shows). Since 1.5.0.
 */
public record Layer(String siteId, String kind, Policy policy, long layer, boolean top) {
}
