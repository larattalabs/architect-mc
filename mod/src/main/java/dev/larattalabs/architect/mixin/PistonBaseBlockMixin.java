package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.placed.Placed;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.piston.PistonBaseBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * 6c PT §2: a piston's move; each moved block's record rides on its moving block entity ({@link MovingPistonBlockMixin}). (J1, RS-c) A
 * survival region's free write is never pushed, and a piston's break of one (a plant in the way) drops nothing.
 */
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

	@Inject(method = "isPushable", at = @At("HEAD"), cancellable = true)
	private static void architect$freeHolds(BlockState state, Level level, BlockPos pos, Direction direction, boolean allowDestroy, Direction pushDirection,
		CallbackInfoReturnable<Boolean> cir) {
		if (!state.isAir() && dev.larattalabs.architect.site.RegionFreeDrops.pistonHolds(level, pos)) {
			cir.setReturnValue(false);
		}
	}

	@Redirect(method = "moveBlocks", at = @At(value = "INVOKE", target =
		"Lnet/minecraft/world/level/block/piston/PistonBaseBlock;dropResources(Lnet/minecraft/world/level/block/state/BlockState;Lnet/minecraft/world/level/LevelAccessor;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/entity/BlockEntity;)V"))
	private void architect$freeBreak(BlockState state, LevelAccessor level, BlockPos pos, @Nullable BlockEntity be) {
		if (level instanceof Level l && dev.larattalabs.architect.site.RegionFreeDrops.takenWithoutDrop(l, pos, false)) {
			return;
		}
		Block.dropResources(state, level, pos, be);
	}
}
