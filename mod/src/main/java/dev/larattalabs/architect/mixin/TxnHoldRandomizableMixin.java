package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.RandomizableContainerBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) The content backstop: a held box's slots refuse every write through the container interface
 * (another mod, a writer no named guard covers) but its own adapter's ({@link TxnServer#asHolder}). The named paths refuse before reaching
 * here; one that gets here is logged once ({@link TxnServer#backstop}). The overrides of chests, barrels, shulker boxes, dispensers and droppers.
 */
@Mixin(RandomizableContainerBlockEntity.class)
public abstract class TxnHoldRandomizableMixin {
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

	@Inject(method = "removeItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldRemove(int slot, int n, CallbackInfoReturnable<ItemStack> cir) {
		if (architect$txnHeld("removeItem")) {
			cir.setReturnValue(ItemStack.EMPTY);
		}
	}

	@Inject(method = "removeItemNoUpdate", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldTake(int slot, CallbackInfoReturnable<ItemStack> cir) {
		if (architect$txnHeld("removeItemNoUpdate")) {
			cir.setReturnValue(ItemStack.EMPTY);
		}
	}

}
