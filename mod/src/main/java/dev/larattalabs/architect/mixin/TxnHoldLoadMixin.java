package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.storage.ValueInput;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 3) A held box's block entity is not reloaded from data ({@code /data}, a structure, another
 * mod): its slots would be replaced wholesale. Only a block entity already in a level is fenced: a chunk loading builds its block entities
 * before they have one ({@code BlockEntity.loadStatic}), so a held box loads intact.
 */
@Mixin(BlockEntity.class)
public abstract class TxnHoldLoadMixin {
	@Inject(method = "loadWithComponents", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldLoad(ValueInput in, CallbackInfo ci) {
		BlockEntity be = (BlockEntity) (Object) this;
		if (be.getLevel() != null && TxnServer.boxHeld(be.getLevel(), be.getBlockPos())) {
			TxnServer.backstop("loadWithComponents", be.getBlockPos());
			ci.cancel();
		}
	}
}
