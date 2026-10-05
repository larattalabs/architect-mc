package dev.larattalabs.architect.api;

/**
 * A style bible at one version (docs/CONTRACT.md phase 4b "Style bible (A1)"): what a group, a design or a library entry was
 * built with. Since 1.2.0.
 */
public record BiblePin(String id, int version) {
}
