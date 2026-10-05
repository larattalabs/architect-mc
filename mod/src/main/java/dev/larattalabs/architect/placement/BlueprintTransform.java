package dev.larattalabs.architect.placement;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The placement math, free of Minecraft types so it is unit-tested without a game.
 *
 * <p><b>Rotation.</b> A rotation is a number of clockwise quarter turns seen from above:
 * 0 = {@code NONE}, 1 = {@code CLOCKWISE_90}, 2 = {@code CLOCKWISE_180}, 3 = {@code COUNTERCLOCKWISE_90}
 * (the order of Minecraft's {@code Rotation} enum). Vanilla rotates template block {@code (x, z)} about
 * the pivot block (0,0) to {@code (-z, x)} for one clockwise turn. Translated so the rotated template's
 * minimum corner lands on the placement origin, a template of size {@code sx x sz} maps
 *
 * <pre>
 * block (bx, bz)                     continuous point (x, z) (blocks span [b, b+1])
 * NONE   (bx,          bz)           (x,      z)
 * CW_90  (sz-1-bz,     bx)           (sz - z, x)
 * 180    (sx-1-bx,     sz-1-bz)      (sx - x, sz - z)
 * CCW_90 (bz,          sx-1-bx)      (z,      sx - x)
 * </pre>
 *
 * The continuous form is the exact rotation of the template's footprint {@code [0,sx] x [0,sz]} onto the
 * rotated footprint, so a feet spot at a block centre ({@code bx + .5}) stays at the centre of the
 * block that block went to, and a surface point on a block face ({@code z = 15.0}) stays on that face.
 * Y is unchanged. Yaw (0 = south/+Z, 90 = west/-X) gains 90 degrees per clockwise turn.
 */
public final class BlueprintTransform {
	/** Clockwise order seen from above; {@link #directionIndex} indexes it. */
	public static final List<String> DIRECTIONS = List.of("north", "east", "south", "west");
	/** Lower-case names of Minecraft's {@code Rotation} constants, indexed by quarter turns. */
	public static final List<String> ROTATIONS = List.of("none", "clockwise_90", "clockwise_180", "counterclockwise_90");

	private BlueprintTransform() {
	}

	// ------------------------------------------------------------------ rotation basics

	public static int directionIndex(String dir) {
		return DIRECTIONS.indexOf(dir.toLowerCase(Locale.ROOT));
	}

	/** Quarter turns clockwise that make a template whose entrance faces {@code front} face {@code wanted}. */
	public static int turnsToFace(String front, String wanted) {
		int f = directionIndex(front);
		int w = directionIndex(wanted);
		if (f < 0 || w < 0) {
			throw new IllegalArgumentException("bad direction " + front + " / " + wanted);
		}
		return Math.floorMod(w - f, 4);
	}

	/** The direction {@code dir} points to after {@code turns} clockwise quarter turns. */
	public static String rotateDirection(String dir, int turns) {
		return DIRECTIONS.get(Math.floorMod(directionIndex(dir) + turns, 4));
	}

	/**
	 * Parses a rotation: Minecraft names ({@code none}, {@code clockwise_90}, {@code clockwise_180},
	 * {@code counterclockwise_90}) and short forms ({@code 0}, {@code cw}, {@code 90}, {@code 180},
	 * {@code ccw}, {@code 270}, {@code -90}). Returns quarter turns, or -1 when not a rotation.
	 */
	public static int parseTurns(String s) {
		return switch (s.toLowerCase(Locale.ROOT)) {
			case "none", "0" -> 0;
			case "clockwise_90", "cw", "90", "cw90" -> 1;
			case "clockwise_180", "180", "cw180", "ccw180" -> 2;
			case "counterclockwise_90", "ccw", "270", "-90", "ccw90" -> 3;
			default -> -1;
		};
	}

	public static String rotationName(int turns) {
		return ROTATIONS.get(Math.floorMod(turns, 4));
	}

	/** Rotated template size along X / Z. */
	public static int rotatedSizeX(int sx, int sz, int turns) {
		return (turns & 1) == 0 ? sx : sz;
	}

	public static int rotatedSizeZ(int sx, int sz, int turns) {
		return (turns & 1) == 0 ? sz : sx;
	}

	/** Continuous template-local (x, z) to rotated-local (x, z) in the rotated footprint (see class doc). */
	public static double[] rotatePoint(double x, double z, int sx, int sz, int turns) {
		return switch (Math.floorMod(turns, 4)) {
			case 1 -> new double[] {sz - z, x};
			case 2 -> new double[] {sx - x, sz - z};
			case 3 -> new double[] {z, sx - x};
			default -> new double[] {x, z};
		};
	}

	/** Template-local block (bx, bz) to rotated-local block (see class doc). */
	public static int[] rotateBlock(int bx, int bz, int sx, int sz, int turns) {
		return switch (Math.floorMod(turns, 4)) {
			case 1 -> new int[] {sz - 1 - bz, bx};
			case 2 -> new int[] {sx - 1 - bx, sz - 1 - bz};
			case 3 -> new int[] {bz, sx - 1 - bx};
			default -> new int[] {bx, bz};
		};
	}

	/** Yaw after {@code turns} clockwise quarter turns, normalised to (-180, 180] (north stays 180). */
	public static float rotateYaw(float yaw, int turns) {
		double y = ((yaw + 90.0 * Math.floorMod(turns, 4)) % 360.0 + 360.0) % 360.0;
		return (float) (y > 180.0 ? y - 360.0 : y);
	}

	/** A template-local anchor in world space for a template placed with its rotated minimum corner at (ox, oy, oz). */
	public static Anchor toWorld(Anchor a, int sx, int sz, int turns, int ox, int oy, int oz) {
		double[] p = rotatePoint(a.x(), a.z(), sx, sz, turns);
		return new Anchor(a.name(), ox + p[0], oy + a.y(), oz + p[1], rotateYaw(a.yaw(), turns), a.pitch());
	}

	/** A template-local block box (inclusive) in world block coordinates. */
	public static Anchors.Bounds boxToWorld(Anchors.Bounds b, int sx, int sz, int turns, int ox, int oy, int oz) {
		int[] p = rotateBlock(b.minX(), b.minZ(), sx, sz, turns);
		int[] q = rotateBlock(b.maxX(), b.maxZ(), sx, sz, turns);
		return new Anchors.Bounds(ox + Math.min(p[0], q[0]), oy + Math.min(b.minY(), b.maxY()), oz + Math.min(p[1], q[1]),
			ox + Math.max(p[0], q[0]), oy + Math.max(b.minY(), b.maxY()), oz + Math.max(p[1], q[1]));
	}

	// ------------------------------------------------------------------ anchors

	/**
	 * Every sidecar anchor in world space: what a placed site stores.
	 *
	 * @param ox world X of the rotated template's minimum corner (likewise oy, oz)
	 */
	public static Map<String, Anchor> worldAnchors(Blueprint bp, int turns, int ox, int oy, int oz) {
		Map<String, Anchor> out = new LinkedHashMap<>();
		for (Anchor a : bp.anchors().values()) {
			out.put(a.name(), toWorld(a, bp.sizeX(), bp.sizeZ(), turns, ox, oy, oz));
		}
		return out;
	}

	/** World interior bounds: the sidecar's interior box (or the whole template) in world space. */
	public static Anchors.Bounds worldBounds(Blueprint bp, int turns, int ox, int oy, int oz) {
		Anchors.Bounds in = bp.interior() != null ? bp.interior() : new Anchors.Bounds(0, 0, 0, bp.sizeX() - 1, bp.sizeY() - 1, bp.sizeZ() - 1);
		return boxToWorld(in, bp.sizeX(), bp.sizeZ(), turns, ox, oy, oz);
	}

	// ------------------------------------------------------------------ placement in front of a player

	/**
	 * Origin (rotated minimum corner) for a building placed in front of a player: the template's ground
	 * row at the player's feet, the near edge {@code gap} blocks ahead along {@code facing}, centred
	 * sideways on the player.
	 *
	 * @param rsx rotated size along X, {@code rsz} along Z
	 */
	public static int[] originInFront(int px, int py, int pz, String facing, int rsx, int rsz, int groundY, int gap) {
		int oy = py - groundY;
		return switch (facing.toLowerCase(Locale.ROOT)) {
			case "south" -> new int[] {px - rsx / 2, oy, pz + gap};
			case "north" -> new int[] {px - rsx / 2, oy, pz - gap - (rsz - 1)};
			case "east" -> new int[] {px + gap, oy, pz - rsz / 2};
			case "west" -> new int[] {px - gap - (rsx - 1), oy, pz - rsz / 2};
			default -> throw new IllegalArgumentException("bad facing " + facing);
		};
	}
}
