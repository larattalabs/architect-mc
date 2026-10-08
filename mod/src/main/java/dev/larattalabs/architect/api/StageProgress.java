package dev.larattalabs.architect.api;

/** One stage of a region: its group stage state, tiles written of all, and cells written. Since 1.8.0. */
public record StageProgress(String name, Stage.State state, int tilesDone, int tilesTotal, long cells) {
}
