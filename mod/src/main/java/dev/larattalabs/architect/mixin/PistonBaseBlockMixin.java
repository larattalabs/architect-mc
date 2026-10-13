package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.piston.PistonBaseBlock;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** 6c PT §2: a piston's move; each moved block's record rides on its moving block entity ({@link MovingPistonBlockMixin}). */
@Mixin(PistonBaseBlock.class)
public abstract class PistonBaseBlockMixin {
	@Inject(method = "moveBlocks", at = @At("HEAD"))
	private void architect$moveBegin(Level level, BlockPos pos, Direction direction, boolean extending, CallbackInfoReturnable<Boolean> cir) {
		Placed.beginPiston(level);
	}

	@Inject(method = "moveBlocks", at = @At("RETURN"))
	private void architect$moveEnd(Level level, BlockPos pos, Direction direction, boolean extending, CallbackInfoReturnable<Boolean> cir) {
		Placed.endPiston();
	}
}
