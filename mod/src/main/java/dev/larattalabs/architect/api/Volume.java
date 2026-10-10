package dev.larattalabs.architect.api;

import java.util.EnumMap;
import java.util.Map;
import net.minecraft.world.level.levelgen.structure.BoundingBox;

/**
 * A 3D volume survey ({@link Survey#volume}, docs/CONTRACT.md phase 6b §5): every cell of {@code box} classified
 * ({@link VoxelClass}), encoded as ARVX (kit/REGIONS.md) and frozen to disk. Since 1.9.0.
 *
 * @param sha SHA-256 (hex) of the uncompressed ARVX bytes: the same land gives the same sha
 * @param box the box sampled (inclusive)
 * @param blobId where the frozen file can be read: the sidecar's blob id (kind {@code region.volume}) when the helper was
 *     connected, else {@code "local:<sha>"} (the file {@code <world>/architect/volumes/<sha>.bin}, gzip of the ARVX bytes)
 * @param counts cells per class (every class present, zeros included)
 * @param missingColumns columns not read (unloaded or never generated under the load policy): their cells are MISSING
 * @param stats summary numbers (Steward S-6b-6)
  * @param ground (1.12.0) per box column, indexed {@code i + j * width} ({@code i = x - minX}, {@code j = z - minZ}): the y of the
 *               highest cell that isn't air, a fluid, LOG, LEAVES or PLANT (OWNED, PLAYER and BLOCK_ENTITY count), or
 *               {@link Sample#MISSING} where the column has none inside the box or wasn't read; empty past
 *               {@link #GROUND_MAX_COLUMNS} columns. Derived from the cells: the ARVX bytes and sha don't change
 */
public record Volume(String sha, BoundingBox box, String blobId, Map<VoxelClass, Long> counts, int missingColumns, Stats stats, int[] ground) {
	/** (1.12.0) At most this many columns get a {@link #ground} array; a wider box leaves it empty (and logs so). */
	public static final int GROUND_MAX_COLUMNS = 16 << 20;

	/** The 1.9.0 constructor (no ground array). */
	public Volume(String sha, BoundingBox box, String blobId, Map<VoxelClass, Long> counts, int missingColumns, Stats stats) {
		this(sha, box, blobId, counts, missingColumns, stats, new int[0]);
	}

	public Volume {
		ground = ground == null ? new int[0] : ground;
		Map<VoxelClass, Long> m = new EnumMap<>(VoxelClass.class);
		for (VoxelClass c : VoxelClass.values()) {
			m.put(c, counts.getOrDefault(c, 0L));
		}
		counts = java.util.Collections.unmodifiableMap(m);
	}

	public long count(VoxelClass c) {
		return counts.get(c);
	}

	/** (1.12.0) The ground y of box column ({@code x}, {@code z}) (world coordinates), or {@link Sample#MISSING}. */
	public int groundAt(int x, int z) {
		int i = x - box.minX();
		int j = z - box.minZ();
		int w = box.getXSpan();
		if (ground.length == 0 || i < 0 || j < 0 || i >= w || j >= box.getZSpan()) {
			return Sample.MISSING;
		}
		return ground[i + j * w];
	}

	/**
	 * Summary numbers over the columns read (Steward S-6b-6). The <b>surface</b> of a column is its highest terrain-solid cell
	 * (ROCK, SOIL, LOOSE, ICE or SNOW); a column without one has no surface and counts in neither the slope nor the overhang
	 * numbers.
	 *
	 * @param surfaceColumns columns with a surface
	 * @param meanSlope the mean over surface columns of the largest surface height difference to the 4 neighbouring columns
	 *     (inside the box)
	 * @param steepFraction the share of surface columns with that difference at least {@link #STEEP}
	 * @param overhangFraction the share of surface columns with a gap (a cell that is not terrain-solid: air, water, lava,
	 *     plant, log, leaves) under a terrain-solid cell within {@link #OVERHANG_DEPTH} cells below the surface: cliffs and
	 *     shallow caves read as overhangs
	 * @param treeCells LOG and LEAVES cells
	 * @param caveCells AIR cells more than {@link #OVERHANG_DEPTH} cells below their column's surface (enclosed air: caves)
	 */
	public record Stats(int surfaceColumns, double meanSlope, double steepFraction, double overhangFraction, long treeCells, long caveCells) {
		/** The slope (blocks between neighbouring columns) from which a column counts as steep. */
		public static final int STEEP = 3;
		/** How deep below the surface a gap still counts as an overhang (deeper air is a cave). */
		public static final int OVERHANG_DEPTH = 8;

		public boolean trees() {
			return treeCells > 0;
		}

		public boolean caves() {
			return caveCells > 0;
		}
	}
}
