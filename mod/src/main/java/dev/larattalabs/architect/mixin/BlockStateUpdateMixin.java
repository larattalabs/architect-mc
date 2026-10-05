package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.journal.UpdateMask;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.ScheduledTickAccess;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.redstone.Orientation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Updates at holes (docs/CONTRACT.md phase 4e): while a restore with holes writes ({@link UpdateMask}), a covered position
 * gets no shape update (its state stays as it is) and no neighbour update. With no mask set this changes nothing.
 */
@Mixin(BlockBehaviour.BlockStateBase.class)
public abstract class BlockStateUpdateMixin {
	@Inject(method = "updateShape", at = @At("HEAD"), cancellable = true)
	private void architect$maskShape(LevelReader level, ScheduledTickAccess ticks, BlockPos pos, Direction direction, BlockPos neighbourPos,
		BlockState neighbourState, RandomSource random, CallbackInfoReturnable<BlockState> cir) {
		if (UpdateMask.masked(pos)) {
			cir.setReturnValue((BlockState) (Object) this);
		}
	}

	@Inject(method = "handleNeighborChanged", at = @At("HEAD"), cancellable = true)
	private void architect$maskNeighbour(Level level, BlockPos pos, Block block, Orientation orientation, boolean movedByPiston, CallbackInfo ci) {
		if (UpdateMask.masked(pos)) {
			ci.cancel();
		}
	}
}
