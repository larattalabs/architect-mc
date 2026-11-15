package dev.larattalabs.architect.compatmixin;

import net.fabricmc.fabric.api.transfer.v1.item.ItemVariant;
import net.fabricmc.fabric.api.transfer.v1.transaction.TransactionContext;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract" 5d) Other mods' pipes: every item extraction through the Fabric Transfer API from a vanilla
 * container goes through Fabric's {@code ContainerSlotWrapper.extract} (the sided wrapper delegates to it). A provided variant in a slot
 * of a declared fill container extracts 0. The target is a Fabric impl class, so this lives in the optional mixin config
 * ({@code architect_mc.compat.mixins.json}, {@code required: false}): a Fabric API that renames it never fails the mod's load; its plugin
 * records whether it applied, and the start logs a WARN when it did not ({@code FillGuard.checkTransferGuard}).
 */
@Pseudo
@Mixin(targets = "net.fabricmc.fabric.impl.transfer.item.ContainerSlotWrapper", remap = false)
public abstract class ContainerSlotWrapperMixin {
	@Inject(method = "extract(Lnet/fabricmc/fabric/api/transfer/v1/item/ItemVariant;JLnet/fabricmc/fabric/api/transfer/v1/transaction/TransactionContext;)J",
		at = @At("HEAD"), cancellable = true, require = 1)
	private void architect$noExtractProvided(ItemVariant resource, long maxAmount, TransactionContext tx, CallbackInfoReturnable<Long> cir) {
		if (dev.larattalabs.architect.site.FillGuard.refusesExtract(this, resource.getItem())) {
			cir.setReturnValue(0L);
		}
	}
}
