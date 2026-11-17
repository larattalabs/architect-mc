package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.ai.behavior.TransportItemsBetweenContainers;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) The copper golem's item transport (it takes from copper chests and puts into chests through
 * the container's stacks): a held box is no new target. A golem that chose its target before the hold keeps it (vanilla re-checks only the
 * block entity's identity): its take and put are refused by {@link TxnHoldGolemTransportMixin}. O(1) with no txn open.
 */
@Mixin(TransportItemsBetweenContainers.TransportItemTarget.class)
public abstract class TxnHoldGolemMixin {
	@Inject(method = "tryCreatePossibleTarget(Lnet/minecraft/world/level/block/entity/BlockEntity;Lnet/minecraft/world/level/Level;)Lnet/minecraft/world/entity/ai/behavior/TransportItemsBetweenContainers$TransportItemTarget;",
		at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTarget(BlockEntity be, Level level, CallbackInfoReturnable<TransportItemsBetweenContainers.TransportItemTarget> cir) {
		if (TxnServer.boxHeld(level, be.getBlockPos())) {
			cir.setReturnValue(null);
		}
	}

	@Inject(method = "tryCreatePossibleTarget(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/Level;)Lnet/minecraft/world/entity/ai/behavior/TransportItemsBetweenContainers$TransportItemTarget;",
		at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTargetAt(BlockPos pos, Level level, CallbackInfoReturnable<TransportItemsBetweenContainers.TransportItemTarget> cir) {
		if (TxnServer.boxHeld(level, pos)) {
			cir.setReturnValue(null);
		}
	}
}
