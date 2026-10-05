package dev.larattalabs.architect.placement;

import com.google.gson.JsonObject;

/** Box and anchor JSON helpers shared by blueprints and sites. Pure. */
public final class Anchors {
	/** An inclusive block box. */
	public record Bounds(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
		public boolean contains(int x, int y, int z) {
			return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
		}

		/** This box grown by {@code n} blocks on every side. */
		public Bounds grow(int n) {
			return new Bounds(minX - n, minY - n, minZ - n, maxX + n, maxY + n, maxZ + n);
		}

		public long volume() {
			return (long) (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
		}
	}

	private Anchors() {
	}

	public static JsonObject anchorJson(Anchor a) {
		JsonObject o = new JsonObject();
		o.addProperty("x", round(a.x()));
		o.addProperty("y", round(a.y()));
		o.addProperty("z", round(a.z()));
		o.addProperty("yaw", round(a.yaw()));
		o.addProperty("pitch", round(a.pitch()));
		return o;
	}

	public static JsonObject boundsJson(Bounds b) {
		JsonObject o = new JsonObject();
		o.addProperty("minX", b.minX());
		o.addProperty("minY", b.minY());
		o.addProperty("minZ", b.minZ());
		o.addProperty("maxX", b.maxX());
		o.addProperty("maxY", b.maxY());
		o.addProperty("maxZ", b.maxZ());
		return o;
	}

	public static Bounds boundsFromJson(JsonObject b) {
		return new Bounds(b.get("minX").getAsInt(), b.get("minY").getAsInt(), b.get("minZ").getAsInt(), b.get("maxX").getAsInt(),
			b.get("maxY").getAsInt(), b.get("maxZ").getAsInt());
	}

	/** True when two inclusive boxes share at least one block. */
	public static boolean intersects(Bounds a, Bounds b) {
		return a.minX() <= b.maxX() && a.maxX() >= b.minX() && a.minY() <= b.maxY() && a.maxY() >= b.minY() && a.minZ() <= b.maxZ()
			&& a.maxZ() >= b.minZ();
	}

	public static String str(Bounds b) {
		return b.minX() + "," + b.minY() + "," + b.minZ() + " .. " + b.maxX() + "," + b.maxY() + "," + b.maxZ();
	}

	private static double round(double v) {
		return Math.round(v * 1000.0) / 1000.0;
	}
}
