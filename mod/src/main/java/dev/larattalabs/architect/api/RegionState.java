package dev.larattalabs.architect.api;

/** A region's state (A5B N8 plus prepare). New values are only ever appended. Since 1.8.0. */
public enum RegionState { PLANNED, PREPARING, PREPARED, PLACING, PLACED, PARTIAL, FAILED, REMOVING }
