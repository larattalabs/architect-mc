package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.piston.PistonBaseBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 3) A held cell is never pushed, pulled or broken by a piston. Vanilla never pushes a block
 * entity; this holds for mods that make them pushable. O(1) with no txn open.
 */
@Mixin(PistonBaseBlock.class)
public abstract class TxnHoldPistonMixin {
	@Inject(method = "isPushable", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldPush(BlockState state, Level level, BlockPos pos, Direction direction, boolean allowDestroy, Direction pushDirection,
		CallbackInfoReturnable<Boolean> cir) {
		if (TxnServer.boxHeld(level, pos)) {
			cir.setReturnValue(false);
		}
	}
}
