package dev.larattalabs.architect.mixin;

import net.minecraft.world.Container;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.inventory.Slot;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract" 5b) Every menu take path checks {@code Slot.mayPickup} (click pickup, shift-click, number-key
 * and offhand swap, Q and ctrl-Q, double-click collect, a bundle's take): a non-creative player can't pick up a provided stack from a
 * declared container of a filled site. Billed items, inserting, and every other slot are untouched.
 */
@Mixin(Slot.class)
public abstract class SlotMayPickupMixin {
	@Shadow
	@Final
	public Container container;

	@Shadow
	public abstract int getContainerSlot();

	@Shadow
	public abstract net.minecraft.world.item.ItemStack getItem();

	@Inject(method = "mayPickup", at = @At("HEAD"), cancellable = true)
	private void architect$guardProvided(Player player, CallbackInfoReturnable<Boolean> cir) {
		if (dev.larattalabs.architect.site.FillGuard.refusesPickup(container, getContainerSlot(), getItem(), player)) {
			cir.setReturnValue(false);
		}
	}
}
