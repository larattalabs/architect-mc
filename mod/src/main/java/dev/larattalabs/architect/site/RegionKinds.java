package dev.larattalabs.architect.site;

/** The journal entry kinds of region tiles (CONTRACT §3 "The unit of writing: tile entries"). */
public final class RegionKinds {
	public static final String TERRAIN = "architect:terrain";
	public static final String PATH = "architect:path";

	private RegionKinds() {
	}

	public static String of(String set) {
		return "path".equals(set) ? PATH : TERRAIN;
	}

	/** A path tile's walk-surface cells (its record's spec {@code walk}). */
	public static long[] walk(String b64) {
		return TileCheck.walkOf(b64);
	}

	public static boolean tile(String kind) {
		return TERRAIN.equals(kind) || PATH.equals(kind);
	}
}
