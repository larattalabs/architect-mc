package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.CrafterBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) The content backstop: a held box's slots refuse every write through the container interface
 * (another mod, a writer no named guard covers) but its own adapter's ({@link TxnServer#asHolder}). The named paths refuse before reaching
 * here; one that gets here is logged once ({@link TxnServer#backstop}). The crafter's setItem override.
 */
@Mixin(CrafterBlockEntity.class)
public abstract class TxnHoldCrafterContentMixin {
	private boolean architect$txnHeld(String what) {
		BlockEntity be = (BlockEntity) (Object) this;
		if (TxnServer.boxHeld(be.getLevel(), be.getBlockPos())) {
			TxnServer.backstop(what, be.getBlockPos());
			return true;
		}
		return false;
	}

	@Inject(method = "setItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldSet(int slot, ItemStack stack, CallbackInfo ci) {
		if (architect$txnHeld("setItem")) {
			ci.cancel();
		}
	}

}
