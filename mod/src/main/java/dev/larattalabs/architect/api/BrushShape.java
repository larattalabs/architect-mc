package dev.larattalabs.architect.api;

/**
 * A brush stroke's shape ({@link BrushRequest#shape}): a {@code SPHERE} of the radius around the centre, or a {@code CYLINDER} of
 * the radius, {@code 2 * radius + 1} high, centred on it. A surface kind moves the columns whose ground lies inside it. Since 1.21.0.
 */
public enum BrushShape {
	SPHERE, CYLINDER
}
