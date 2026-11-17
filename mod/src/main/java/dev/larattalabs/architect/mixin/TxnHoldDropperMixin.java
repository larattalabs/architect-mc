package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.DropperBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) A held dropper drops nothing (its own {@code dispenseFrom}). */
@Mixin(DropperBlock.class)
public abstract class TxnHoldDropperMixin {
	@Inject(method = "dispenseFrom", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldDrop(ServerLevel level, BlockState state, BlockPos pos, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}
}
