package dev.larattalabs.architect.delta;

import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.BlueprintTransform;

/**
 * (6d FS-b) A standing lot's box in the template-local frame of the version its site stands at, so the helper (which knows a re-made
 * follower's size and origin but no world) can test "does the follower still fit this lot" by plain containment. The geometry is
 * {@link SitePlanner#alignedMin}'s: a follower is placed so that every design coordinate lands on the world cell it has in the version the
 * site stands at, so its box is the unrotated box {@code [oa - ob, oa - ob + size)} in the standing version's template-local blocks
 * ({@code oa}, {@code ob}: the two frame origins {@link TemplateDelta#origins} gives), and containment there equals containment of its
 * placed (rotated) box in the lot's world box. Pure; the helper does no rotation or alignment arithmetic.
 */
public final class LotFrame {
	private LotFrame() {
	}

	/**
	 * {@code world} (a lot's box) as template-local block bounds of the version placed with its rotated minimum corner at {@code aMin}
	 * and {@code turns} clockwise quarter turns: {@code {minX, minY, minZ, maxX, maxY, maxZ}}, inclusive, unrotated. {@code asx},
	 * {@code asz}: that version's template size.
	 */
	public static int[] localBox(Anchors.Bounds world, int[] aMin, int asx, int asz, int turns) {
		int[] p = BlueprintTransform.unrotateBlock(world.minX() - aMin[0], world.minZ() - aMin[2], asx, asz, turns);
		int[] q = BlueprintTransform.unrotateBlock(world.maxX() - aMin[0], world.maxZ() - aMin[2], asx, asz, turns);
		return new int[] {Math.min(p[0], q[0]), world.minY() - aMin[1], Math.min(p[1], q[1]), Math.max(p[0], q[0]), world.maxY() - aMin[1],
			Math.max(p[1], q[1])};
	}
}
