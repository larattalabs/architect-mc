package dev.larattalabs.architect.batch;

import dev.larattalabs.architect.placement.Anchor;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.Blueprint;
import dev.larattalabs.architect.placement.BlueprintTransform;
import org.jspecify.annotations.Nullable;

/**
 * The geometry of {@code Sites.fitToLot} (docs/CONTRACT.md phase 4d "Lot fitting"), pure so it is tested for every street side
 * and rotation without a game.
 *
 * <ul>
 * <li><b>Rotation:</b> the entrance faces the street side.</li>
 * <li><b>Across the street:</b> the entrance column on the centre column of the lot's street-side span ({@code floor((lo + hi)
 * / 2)}), or the footprint centred ({@code box}); a box that would stick out sideways is moved back inside the lot.</li>
 * <li><b>Depth:</b> the front face {@code setback} cells in from the street edge (default the approach length: the approach's
 * last row lands on the lot's edge row); {@code intoStreet} puts the front face on the edge row itself.</li>
 * <li><b>Height:</b> {@code origin.y = lot.minY - groundY}.</li>
 * </ul>
 */
public final class LotFitting {
	private LotFitting() {
	}

	/**
	 * A fit.
	 *
	 * @param turns clockwise quarter turns
	 * @param box the rotated template box at the origin (its minimum corner)
	 * @param fits whether the footprint (after rotation and setback) lies inside the lot; else {@code why}
	 * @param setback the setback used
	 */
	public record Fit(int turns, Anchors.Bounds box, boolean fits, @Nullable String why, int setback) {
		public int ox() {
			return box.minX();
		}

		public int oy() {
			return box.minY();
		}

		public int oz() {
			return box.minZ();
		}
	}

	/** {@link #fit(int, int, int, String, double, double, boolean, int, int, Anchors.Bounds, String, boolean, Integer, boolean)} for a blueprint. */
	public static Fit fit(Blueprint bp, Anchors.Bounds lot, String streetSide, boolean centreOnBox, @Nullable Integer setback, boolean intoStreet) {
		Anchor e = bp.anchors().get(Blueprint.ENTRANCE);
		int length = bp.approach().enabled() && e != null ? bp.approach().length() : 0;
		return fit(bp.sizeX(), bp.sizeY(), bp.sizeZ(), bp.front(), e == null ? 0 : e.x(), e == null ? 0 : e.z(), e != null, bp.groundY(), length, lot,
			streetSide, centreOnBox, setback, intoStreet);
	}

	/**
	 * @param ex the entrance anchor's template-local x (continuous, unrotated); likewise {@code ez}
	 * @param hasEntrance false: the footprint is centred (no entrance to centre)
	 * @param approachLength the design's approach length (0 = none): the default setback
	 * @param lot the lot (inclusive); {@code minY} is its ground height
	 * @param streetSide {@code north/east/south/west}: the lot side the street runs along
	 */
	public static Fit fit(int sizeX, int sizeY, int sizeZ, String front, double ex, double ez, boolean hasEntrance, int groundY, int approachLength,
		Anchors.Bounds lot, String streetSide, boolean centreOnBox, @Nullable Integer setback, boolean intoStreet) {
		String side = streetSide.toLowerCase(java.util.Locale.ROOT);
		int turns = BlueprintTransform.turnsToFace(front, side);
		int rsx = BlueprintTransform.rotatedSizeX(sizeX, sizeZ, turns);
		int rsz = BlueprintTransform.rotatedSizeZ(sizeX, sizeZ, turns);
		double[] re = BlueprintTransform.rotatePoint(ex, ez, sizeX, sizeZ, turns);
		int sb = intoStreet ? 0 : setback != null ? setback : approachLength;
		boolean alongX = side.equals("north") || side.equals("south"); // the street-side span runs along x
		int lo = alongX ? lot.minX() : lot.minZ();
		int hi = alongX ? lot.maxX() : lot.maxZ();
		int width = alongX ? rsx : rsz;
		int depth = alongX ? rsz : rsx;
		int lotDepth = alongX ? lot.maxZ() - lot.minZ() + 1 : lot.maxX() - lot.minX() + 1;
		int span = hi - lo + 1;
		int lateral;
		if (centreOnBox || !hasEntrance) {
			lateral = lo + Math.floorDiv(span - width, 2);
		} else {
			int centre = Math.floorDiv(lo + hi, 2);
			int entranceCol = (int) Math.floor(alongX ? re[0] : re[1]);
			lateral = centre - entranceCol;
		}
		if (width <= span) {
			lateral = Math.max(lo, Math.min(lateral, hi - width + 1));
		}
		int ox;
		int oz;
		switch (side) {
			case "north" -> {
				ox = lateral;
				oz = lot.minZ() + sb;
			}
			case "south" -> {
				ox = lateral;
				oz = lot.maxZ() - sb - rsz + 1;
			}
			case "west" -> {
				ox = lot.minX() + sb;
				oz = lateral;
			}
			case "east" -> {
				ox = lot.maxX() - sb - rsx + 1;
				oz = lateral;
			}
			default -> throw new IllegalArgumentException("street side must be north/east/south/west, not " + streetSide);
		}
		int oy = lot.minY() - groundY;
		Anchors.Bounds box = new Anchors.Bounds(ox, oy, oz, ox + rsx - 1, oy + sizeY - 1, oz + rsz - 1);
		String why = null;
		if (width > span) {
			why = "the footprint is " + width + " wide along the street, the lot " + span;
		} else if (depth + sb > lotDepth) {
			why = "the footprint is " + depth + " deep" + (sb > 0 ? " plus a setback of " + sb : "") + ", the lot " + lotDepth;
		}
		return new Fit(turns, box, why == null, why, sb);
	}

	/** The worst-case growth of a restore box past its template box at the front: the approach plus its extension. */
	public static int frontMargin(Blueprint bp) {
		return bp.approach().enabled() && bp.anchors().containsKey(Blueprint.ENTRANCE) ? bp.approach().length() + Approach.EXTEND : 0;
	}
}
