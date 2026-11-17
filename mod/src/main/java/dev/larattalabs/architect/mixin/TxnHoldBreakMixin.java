package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds") A container an open txn holds is not broken by a player ({@code destroyBlock}); see
 * {@link TxnHoldExplosionMixin} for explosions. O(1) with no txn open.
 */
@Mixin(ServerPlayerGameMode.class)
public abstract class TxnHoldBreakMixin {
	@Shadow
	protected ServerLevel level;

	@Inject(method = "destroyBlock", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldBreak(BlockPos pos, CallbackInfoReturnable<Boolean> cir) {
		if (TxnServer.boxHeld(level, pos)) {
			cir.setReturnValue(false);
		}
	}
}
