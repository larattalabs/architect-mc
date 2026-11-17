package dev.larattalabs.architect.mixin;

import net.minecraft.core.Direction;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (Slice FL, S-M5-17) No automated insertion into a declared container of a fill site before its unlock ({@code FillHold}). Every vanilla
 * path into a block container goes through {@code canPlaceItemInContainer} ({@code addItem} -> {@code tryMoveInItem}): a hopper's push, a
 * hopper's pull from the container above, a hopper's item-entity pickup, a dropper's push. Refused, the stack stays where it was.
 * (Slice LC3) The same for any holder in a box being removed ({@code RemovalSeal}).
 */
@Mixin(HopperBlockEntity.class)
public abstract class HopperHoldMixin {
	@Inject(method = "canPlaceItemInContainer", at = @At("HEAD"), cancellable = true)
	private static void architect$holdFillContainer(Container container, ItemStack stack, int slot, @Nullable Direction direction,
		CallbackInfoReturnable<Boolean> cir) {
		if (dev.larattalabs.architect.site.FillHold.refusesInsert(container, slot)
			|| dev.larattalabs.architect.site.RemovalSeal.refusesInsert(container, slot)) { // (slice LC3) a removal's box
			cir.setReturnValue(false);
		}
	}
}
