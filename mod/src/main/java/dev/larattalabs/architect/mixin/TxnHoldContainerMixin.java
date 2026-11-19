package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.entity.BaseContainerBlockEntity;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds") A player can't open a container an open txn holds ({@code canOpen}), and a menu already
 * open over it closes on its next validity check ({@code stillValid}, every tick). O(1) with no txn open.
 */
@Mixin(BaseContainerBlockEntity.class)
public abstract class TxnHoldContainerMixin {
	@Inject(method = "canOpen", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldOpen(Player player, CallbackInfoReturnable<Boolean> cir) {
		BlockEntity be = (BlockEntity) (Object) this;
		if (be.getLevel() != null && dev.larattalabs.architect.site.Fills.heldBox(be.getLevel(), be.getBlockPos())) {
			cir.setReturnValue(false);
		}
	}

	@Inject(method = "stillValid", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldValid(Player player, CallbackInfoReturnable<Boolean> cir) {
		BlockEntity be = (BlockEntity) (Object) this;
		if (be.getLevel() != null && dev.larattalabs.architect.site.Fills.heldBox(be.getLevel(), be.getBlockPos())) {
			cir.setReturnValue(false);
		}
	}
}
