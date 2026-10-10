package dev.larattalabs.architect.api;

import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;

/**
 * A protected area ({@link Sites#protect}, docs/CONTRACT.md phase 6c slice 0c §8): the columns {@code x0..x1 × z0..z1} at every
 * height. An op of the same {@code owner} started after the mark that would write into it is refused {@link Reason#PROTECTED}
 * ({@code force} doesn't override it; lift the area instead). Remove, undo, {@code undoStage} and {@code removeGroup} are never
 * refused. Kept per world in {@code <world>/architect/protected.json}. Since 1.12.0.
 *
 * @param owner required, {@code <modid>:<thing>} (the player can't mark areas in 1.12.0)
 * @param id the area's id within its owner; the same (owner, id) replaces
 * @param x0 and {@code z0, x1, z1}: the corners, inclusive (either order; stored as min..max); at most 4,096 × 4,096 columns
 * @param label shown in refusals
 */
public record ProtectedArea(String owner, String id, ResourceKey<Level> dimension, int x0, int z0, int x1, int z1, String label) {
	/** At most this many areas per owner. */
	public static final int MAX_PER_OWNER = 1024;
	/** At most this many columns along either axis. */
	public static final int MAX_SPAN = 4096;

	public ProtectedArea {
		int ax = Math.min(x0, x1);
		int bx = Math.max(x0, x1);
		int az = Math.min(z0, z1);
		int bz = Math.max(z0, z1);
		x0 = ax;
		x1 = bx;
		z0 = az;
		z1 = bz;
		label = label == null ? "" : label;
	}

	/** Whether the column (x, z) is inside. */
	public boolean contains(int x, int z) {
		return x >= x0 && x <= x1 && z >= z0 && z <= z1;
	}

	/** Whether the column box {@code minX..maxX × minZ..maxZ} touches it. */
	public boolean intersects(int minX, int minZ, int maxX, int maxZ) {
		return minX <= x1 && maxX >= x0 && minZ <= z1 && maxZ >= z0;
	}
}
