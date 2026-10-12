package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.RandomSource;
import net.minecraft.world.level.LevelReader;
import net.minecraft.world.level.ScheduledTickAccess;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** TEMPORARY (slice Y2 investigation): logs a door whose updateShape answers air. */
@Mixin(BlockBehaviour.BlockStateBase.class)
public abstract class TraceDoorMixin {
	@Inject(method = "updateShape", at = @At("RETURN"))
	private void architect$traceDoor(LevelReader level, ScheduledTickAccess ticks, BlockPos pos, Direction direction, BlockPos neighbourPos,
		BlockState neighbourState, RandomSource random, CallbackInfoReturnable<BlockState> cir) {
		BlockState self = (BlockState) (Object) this;
		if (System.getenv("ARCHITECT_TRACE_DOORS") != null && self.getBlock() instanceof DoorBlock && cir.getReturnValue().isAir()) {
			dev.larattalabs.architect.Architect.LOGGER.info("TRACE door AIR at {} {} dir {} neighbour {} {} level {}", pos.toShortString(), self, direction,
				neighbourPos.toShortString(), neighbourState, level.getClass().getSimpleName(), new Throwable("stack"));
		}
	}
}
