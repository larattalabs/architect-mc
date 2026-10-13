package dev.larattalabs.architect.api;

import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jspecify.annotations.Nullable;

/**
 * One brush stroke ({@link Regions#brush}, docs/CONTRACT.md "Phase 6c slice B"). A stroke is one region: planned by the bundled
 * {@code brush} program over the brush's box plus 8 (no Claude call), realised at once, undone by {@link Regions#remove} in any order
 * with other strokes and sites.
 *
 * @param owner who owns the stroke ({@code <modid>:<thing>}; {@code architect:player} for commands); required. The owner's protected
 *     areas ({@link Sites#protect}) refuse a stroke that meets them ({@link Reason#PROTECTED}); a stroke layers over the same owner's
 *     earlier strokes and never touches a cell another owner's entry owns.
 * @param dimension the Overworld (another refuses {@link Reason#NOT_ALLOWED})
 * @param kind what the stroke does
 * @param shape null: {@link BrushShape#SPHERE}
 * @param center the brush's centre (for a surface kind, usually a ground block)
 * @param radius {@link Limits#BRUSH_RADIUS_MIN}..{@link Limits#BRUSH_RADIUS_MAX} (else {@link Reason#FIELD_LIMIT})
 * @param strength {@link Limits#BRUSH_STRENGTH_MIN}..{@link Limits#BRUSH_STRENGTH_MAX} (else {@link Reason#FIELD_LIMIT}): blocks of
 *     change (RAISE, LOWER, ERODE, BLEND, OVERLAY), sweeps (SMOOTH), rounds (MELT) or the tunnel's girth (CAVE_CARVE)
 * @param mask null: every cell of the shape; a mask term {@code block} reads the frozen world (the stroke samples it)
 * @param pattern null: the column's own surface and subsurface blocks
 * @param destruction null: {@link Destruction#NATURAL_ONLY}
 * @param actor the player the stroke is for; {@link Destruction#PLAYER_BLOCKS} needs an online player with permission level 2
 * @param seed the stroke's seed (CAVE_CARVE's worm): the same request and seed plan the same IR
 */
public record BrushRequest(String owner, ResourceKey<Level> dimension, BrushKind kind, BrushShape shape, BlockPos center, int radius, int strength,
	@Nullable Mask mask, @Nullable Pattern pattern, Destruction destruction, @Nullable UUID actor, long seed) {
	public BrushRequest {
		shape = shape == null ? BrushShape.SPHERE : shape;
		destruction = destruction == null ? Destruction.NATURAL_ONLY : destruction;
	}
}
