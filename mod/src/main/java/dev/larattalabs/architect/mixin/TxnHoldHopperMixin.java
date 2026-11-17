package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.Container;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds") Item transfer honours txn holds: a container an open txn holds is no container to a hopper,
 * a hopper minecart or a dropper ({@code getContainerAt}: they neither push into it nor pull from it). O(1) with no txn open.
 */
@Mixin(HopperBlockEntity.class)
public abstract class TxnHoldHopperMixin {
	@Inject(method = "getContainerAt(Lnet/minecraft/world/level/Level;Lnet/minecraft/core/BlockPos;)Lnet/minecraft/world/Container;", at = @At("HEAD"),
		cancellable = true)
	private static void architect$txnHeldAt(Level level, BlockPos pos, CallbackInfoReturnable<Container> cir) {
		if (TxnServer.boxHeld(level, pos)) {
			cir.setReturnValue(null);
		}
	}

	@Inject(method = "getContainerAt(Lnet/minecraft/world/level/Level;Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;DDD)Lnet/minecraft/world/Container;",
		at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldAtXyz(Level level, BlockPos pos, BlockState state, double x, double y, double z, CallbackInfoReturnable<Container> cir) {
		if (TxnServer.boxHeld(level, pos)) {
			cir.setReturnValue(null);
		}
	}
}
