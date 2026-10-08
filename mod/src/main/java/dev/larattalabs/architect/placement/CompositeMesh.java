package dev.larattalabs.architect.placement;

import java.util.Arrays;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * One layer of a composite preview (docs/CONTRACT.md "Phase 4c contract", {@code ArchitectClientApi.previewComposite}) as a
 * ready-to-draw mesh, built once from a {@link GhostModel} (the placement ghost's model: rotated cells and their exposed faces)
 * and drawn every frame by streaming its arrays with the camera offset. Free of Minecraft types so it is unit-tested without a
 * game. Also the composite rules: the per-key cell cap and the distance past which a layer draws as its box outline.
 *
 * <p>Vertices are relative to the layer's origin (the rotated box's minimum corner): 4 vertices x 3 floats per quad, one colour
 * per quad (ARGB), in the order the debug-box render type wants (as the ghost renderer).
 */
public final class CompositeMesh {
	/** A layer's tint (mirrors the API's {@code PreviewStyle}). */
	public enum Style {
		GHOST, MASSING, ADDED, REMOVED, CHANGED, KEPT
	}

	/** The cap per key and the full-detail distance (ArchitectClientApi). */
	public static final int MAX_CELLS = 200_000;
	public static final int FULL_DISTANCE = 160;

	static final int SLATE = 0xFF5F86D0;
	static final int GREEN = 0xFF3CCB5A;
	static final int AMBER = 0xFFF2A21C;
	static final int RED = 0xFFE0302A;
	/** KEPT (phase 5b): cells the player changed that a KEEP delta leaves: a yellow frame. */
	static final int YELLOW = 0xFFF5E11E;
	/** REMOVED: the frame's width on a face (blocks). */
	static final float FRAME = 0.075f;
	private static final float[] FACE_SHADE = {0.62f, 1.0f, 0.86f, 0.86f, 0.74f, 0.74f};

	public final Style style;
	public final int sizeX;
	public final int sizeY;
	public final int sizeZ;
	/** Visible cells drawn (what the cap counts). */
	public final int cells;
	public final int quads;
	public final float[] xyz;
	public final int[] argb;

	private CompositeMesh(Style style, int sizeX, int sizeY, int sizeZ, int cells, int quads, float[] xyz, int[] argb) {
		this.style = style;
		this.sizeX = sizeX;
		this.sizeY = sizeY;
		this.sizeZ = sizeZ;
		this.cells = cells;
		this.quads = quads;
		this.xyz = xyz;
		this.argb = argb;
	}

	/** An empty mesh for a layer that draws only its box outline (over the cap: its cells are not built). */
	public static CompositeMesh outlineOnly(Style style, int sizeX, int sizeY, int sizeZ, int cells) {
		return new CompositeMesh(style, sizeX, sizeY, sizeZ, cells, 0, new float[0], new int[0]);
	}

	/** Whether this mesh has its cells (false: it only ever draws its outline). */
	public boolean hasCells() {
		return quads > 0 || cells == 0;
	}

	// ------------------------------------------------------------------ colours

	/** {@code a} moved towards {@code b} by {@code t} (0..1), RGB only. */
	static int mix(int a, int b, float t) {
		int r = Math.round(((a >> 16) & 0xFF) * (1 - t) + ((b >> 16) & 0xFF) * t);
		int g = Math.round(((a >> 8) & 0xFF) * (1 - t) + ((b >> 8) & 0xFF) * t);
		int bl = Math.round((a & 0xFF) * (1 - t) + (b & 0xFF) * t);
		return (r << 16) | (g << 8) | bl;
	}

	static int shade(int argb, float f) {
		int r = Math.min(255, Math.round(((argb >> 16) & 0xFF) * f));
		int g = Math.min(255, Math.round(((argb >> 8) & 0xFF) * f));
		int b = Math.min(255, Math.round((argb & 0xFF) * f));
		return (argb & 0xFF000000) | (r << 16) | (g << 8) | b;
	}

	/** A cell's fill colour in a style (alpha included), from the block's map colour. REMOVED: a faint red. */
	public static int tint(Style s, int blockArgb) {
		return switch (s) {
			case GHOST -> 0x5A000000 | (blockArgb & 0xFFFFFF);
			case MASSING -> 0x88000000 | mix(blockArgb, SLATE, 0.35f);
			case ADDED -> 0x96000000 | mix(blockArgb, GREEN, 0.72f);
			case CHANGED -> 0x96000000 | mix(blockArgb, AMBER, 0.72f);
			case REMOVED -> 0x2E000000 | (RED & 0xFFFFFF);
			case KEPT -> 0x24000000 | (YELLOW & 0xFFFFFF);
		};
	}

	/** The colour of a style's outlines (the layer's box, a REMOVED cell's frame). */
	public static int outlineColor(Style s) {
		return switch (s) {
			case GHOST -> 0xC8E8E0D0;
			case MASSING -> 0xE05F86D0;
			case ADDED -> 0xF03CCB5A;
			case CHANGED -> 0xF0F2A21C;
			case REMOVED -> 0xF0E0302A;
			case KEPT -> 0xF8F5E11E;
		};
	}

	/** How far each style's cubes are inflated, so overlapping layers (a REMOVED over a GHOST) do not z-fight. */
	static float inflate(Style s) {
		return switch (s) {
			case GHOST -> 0.005f;
			case MASSING -> 0.007f;
			case ADDED, CHANGED -> 0.012f;
			case REMOVED -> 0.02f;
			case KEPT -> 0.026f;
		};
	}

	// ------------------------------------------------------------------ building

	/** A packed template-local cell (x, y, z each 0..2^20). */
	public static long cellKey(int x, int y, int z) {
		return ((long) (x & 0xFFFFF) << 40) | ((long) (y & 0xFFFFF) << 20) | (z & 0xFFFFF);
	}

	/**
	 * Only the cells in {@code only} (packed {@link #cellKey}, template coordinates); a listed cell the template writes as air
	 * gets {@code airArgb} so it is drawn. Null = all cells.
	 */
	public static GhostModel.Cells filter(GhostModel.Cells c, @Nullable Set<Long> only, int airArgb) {
		if (only == null) {
			return c;
		}
		int n = c.count();
		int[] xyz = new int[n * 3];
		int[] argb = new int[n];
		int k = 0;
		for (int i = 0; i < n; i++) {
			int x = c.xyz()[i * 3];
			int y = c.xyz()[i * 3 + 1];
			int z = c.xyz()[i * 3 + 2];
			if (!only.contains(cellKey(x, y, z))) {
				continue;
			}
			xyz[k * 3] = x;
			xyz[k * 3 + 1] = y;
			xyz[k * 3 + 2] = z;
			argb[k] = (c.argb()[i] >>> 24) == 0 ? airArgb : c.argb()[i];
			k++;
		}
		return new GhostModel.Cells(c.sizeX(), c.sizeY(), c.sizeZ(), c.groundY(), Arrays.copyOf(xyz, k * 3), Arrays.copyOf(argb, k));
	}

	/** The mesh of a model (its exposed faces) in a style. */
	public static CompositeMesh build(GhostModel m, Style s) {
		int faces = m.faceCount();
		boolean framed = s == Style.REMOVED || s == Style.KEPT;
		int perFace = framed ? 5 : 1; // REMOVED, KEPT: the faint fill plus a frame of 4 bars
		float[] xyz = new float[faces * perFace * 12];
		int[] argb = new int[faces * perFace];
		int q = 0;
		float g = inflate(s);
		int frame = outlineColor(s);
		for (int i = 0; i < m.count(); i++) {
			int mask = m.faces(i);
			if (mask == 0) {
				continue;
			}
			int fill = tint(s, m.argb(i));
			float x0 = m.x(i) - g;
			float y0 = m.y(i) - g;
			float z0 = m.z(i) - g;
			float x1 = m.x(i) + 1 + g;
			float y1 = m.y(i) + 1 + g;
			float z1 = m.z(i) + 1 + g;
			for (int f = 0; f < 6; f++) {
				if ((mask & (1 << f)) == 0) {
					continue;
				}
				int c = framed ? fill : shade(fill, FACE_SHADE[f]);
				q = face(xyz, argb, q, f, x0, y0, z0, x1, y1, z1, c);
				if (framed) {
					q = frame(xyz, argb, q, f, x0, y0, z0, x1, y1, z1, frame);
				}
			}
		}
		return new CompositeMesh(s, m.sizeX, m.sizeY, m.sizeZ, m.visibleCount(), q, q * 12 == xyz.length ? xyz : Arrays.copyOf(xyz, q * 12), q
			== argb.length ? argb : Arrays.copyOf(argb, q));
	}

	/** One face of a box (bit order down up north south west east), as the ghost renderer's cube. */
	private static int face(float[] v, int[] c, int q, int f, float x0, float y0, float z0, float x1, float y1, float z1, int argb) {
		switch (f) {
			case 0 -> put(v, q, x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
			case 1 -> put(v, q, x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
			case 2 -> put(v, q, x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0);
			case 3 -> put(v, q, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
			case 4 -> put(v, q, x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
			default -> put(v, q, x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
		}
		c[q] = argb;
		return q + 1;
	}

	/** A frame of 4 thin bars in the plane of one face (a REMOVED cell's red outline), drawn just off the face. */
	private static int frame(float[] v, int[] c, int q, int f, float x0, float y0, float z0, float x1, float y1, float z1, int argb) {
		float w = FRAME;
		float e = 0.004f; // off the fill, towards the viewer side of the face
		switch (f) {
			case 0, 1 -> { // a horizontal face: bars along x at z0/z1, along z at x0/x1
				float y = f == 0 ? y0 - e : y1 + e;
				q = hquad(v, c, q, x0, z0, x1, z0 + w, y, argb, f == 1);
				q = hquad(v, c, q, x0, z1 - w, x1, z1, y, argb, f == 1);
				q = hquad(v, c, q, x0, z0 + w, x0 + w, z1 - w, y, argb, f == 1);
				q = hquad(v, c, q, x1 - w, z0 + w, x1, z1 - w, y, argb, f == 1);
			}
			case 2, 3 -> { // a z face
				float z = f == 2 ? z0 - e : z1 + e;
				q = zquad(v, c, q, x0, y0, x1, y0 + w, z, argb, f == 3);
				q = zquad(v, c, q, x0, y1 - w, x1, y1, z, argb, f == 3);
				q = zquad(v, c, q, x0, y0 + w, x0 + w, y1 - w, z, argb, f == 3);
				q = zquad(v, c, q, x1 - w, y0 + w, x1, y1 - w, z, argb, f == 3);
			}
			default -> { // an x face
				float x = f == 4 ? x0 - e : x1 + e;
				q = xquad(v, c, q, z0, y0, z1, y0 + w, x, argb, f == 5);
				q = xquad(v, c, q, z0, y1 - w, z1, y1, x, argb, f == 5);
				q = xquad(v, c, q, z0, y0 + w, z0 + w, y1 - w, x, argb, f == 5);
				q = xquad(v, c, q, z1 - w, y0 + w, z1, y1 - w, x, argb, f == 5);
			}
		}
		return q;
	}

	private static int hquad(float[] v, int[] c, int q, float ax, float az, float bx, float bz, float y, int argb, boolean up) {
		if (up) {
			put(v, q, ax, y, az, ax, y, bz, bx, y, bz, bx, y, az);
		} else {
			put(v, q, ax, y, az, bx, y, az, bx, y, bz, ax, y, bz);
		}
		c[q] = argb;
		return q + 1;
	}

	private static int zquad(float[] v, int[] c, int q, float ax, float ay, float bx, float by, float z, int argb, boolean south) {
		if (south) {
			put(v, q, ax, ay, z, bx, ay, z, bx, by, z, ax, by, z);
		} else {
			put(v, q, ax, ay, z, ax, by, z, bx, by, z, bx, ay, z);
		}
		c[q] = argb;
		return q + 1;
	}

	private static int xquad(float[] v, int[] c, int q, float az, float ay, float bz, float by, float x, int argb, boolean east) {
		if (east) {
			put(v, q, x, ay, az, x, by, az, x, by, bz, x, ay, bz);
		} else {
			put(v, q, x, ay, az, x, ay, bz, x, by, bz, x, by, az);
		}
		c[q] = argb;
		return q + 1;
	}

	private static void put(float[] v, int q, float ax, float ay, float az, float bx, float by, float bz, float cx, float cy, float cz, float dx,
		float dy, float dz) {
		int o = q * 12;
		v[o] = ax;
		v[o + 1] = ay;
		v[o + 2] = az;
		v[o + 3] = bx;
		v[o + 4] = by;
		v[o + 5] = bz;
		v[o + 6] = cx;
		v[o + 7] = cy;
		v[o + 8] = cz;
		v[o + 9] = dx;
		v[o + 10] = dy;
		v[o + 11] = dz;
	}

	// ------------------------------------------------------------------ the composite rules

	/**
	 * Which layers of a key draw as outlines because of the cell cap: counted in layer order, a layer whose cells would take
	 * the key past {@code cap} is an outline (and does not count), later smaller layers may still fit.
	 */
	public static boolean[] overCap(int[] cellCounts, int cap) {
		boolean[] out = new boolean[cellCounts.length];
		long used = 0;
		for (int i = 0; i < cellCounts.length; i++) {
			if (used + cellCounts[i] > cap) {
				out[i] = true;
			} else {
				used += cellCounts[i];
			}
		}
		return out;
	}

	/** The distance from a point (the camera) to a box ({@code min..max} corners, blocks); 0 inside. */
	public static double distanceToBox(double px, double py, double pz, double minX, double minY, double minZ, double maxX, double maxY, double maxZ) {
		double dx = Math.max(Math.max(minX - px, 0), px - maxX);
		double dy = Math.max(Math.max(minY - py, 0), py - maxY);
		double dz = Math.max(Math.max(minZ - pz, 0), pz - maxZ);
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	/** Whether a layer at this distance draws only its outline. */
	public static boolean tooFar(double distance) {
		return distance > FULL_DISTANCE;
	}

	/**
	 * Origins along a row for boxes of these widths (x extent, along +x) separated by {@code gap}, starting at {@code x0}
	 * (a set's massings shown side by side). Returns each box's minimum x.
	 */
	public static int[] row(int[] widths, int gap, int x0) {
		int[] out = new int[widths.length];
		int x = x0;
		for (int i = 0; i < widths.length; i++) {
			out[i] = x;
			x += widths[i] + gap;
		}
		return out;
	}
}
