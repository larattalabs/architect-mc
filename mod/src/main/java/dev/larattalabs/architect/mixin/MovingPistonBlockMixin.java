package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.piston.MovingPistonBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 6c PT §2: a moving block entity made inside a piston's move takes its source cell's record. */
@Mixin(MovingPistonBlock.class)
public abstract class MovingPistonBlockMixin {
	@Inject(method = "newMovingBlockEntity", at = @At("RETURN"))
	private static void architect$moving(BlockPos pos, BlockState state, BlockState moved, Direction direction, boolean extending, boolean source,
		CallbackInfoReturnable<BlockEntity> cir) {
		Placed.movingEntity(cir.getReturnValue());
	}
}
