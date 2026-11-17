package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T2a fix round, GPT P1-5) The legacy chest upgrade ({@code ChestBlockEntity.swapContents}, through {@code setItems}) swaps two
 * chests' inventories; it is refused when either chest is held, so a neighbour chunk's upgrade never moves a held box's contents.
 */
@Mixin(ChestBlockEntity.class)
public abstract class TxnHoldChestSwapMixin {
	@Inject(method = "swapContents", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldSwap(ChestBlockEntity a, ChestBlockEntity b, CallbackInfo ci) {
		if (TxnServer.containerHeld(a) || TxnServer.containerHeld(b)) {
			TxnServer.backstop("swapContents", a.getBlockPos());
			ci.cancel();
		}
	}
}
