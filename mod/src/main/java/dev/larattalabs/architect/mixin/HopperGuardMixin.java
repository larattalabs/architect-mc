package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.Container;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.Hopper;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract" 5c) Item transfer: a hopper or hopper minecart pulling from a declared container
 * ({@code tryTakeInItemFromSlot}) skips its provided stacks, and a declared hopper pushing ({@code ejectItems}) skips its own provided
 * slots (it pushes from its first other non-empty slot, as vanilla does past an empty one).
 */
@Mixin(HopperBlockEntity.class)
public abstract class HopperGuardMixin {
	@Inject(method = "tryTakeInItemFromSlot", at = @At("HEAD"), cancellable = true)
	private static void architect$noPullProvided(Hopper hopper, Container container, int slot, Direction direction, CallbackInfoReturnable<Boolean> cir) {
		if (dev.larattalabs.architect.site.FillGuard.guardedSlot(container, slot, container.getItem(slot))) {
			cir.setReturnValue(false);
		}
	}

	@Redirect(method = "ejectItems", at = @At(value = "INVOKE", target =
		"Lnet/minecraft/world/level/block/entity/HopperBlockEntity;getItem(I)Lnet/minecraft/world/item/ItemStack;"))
	private static ItemStack architect$noPushProvided(HopperBlockEntity self, int slot, Level level, BlockPos pos, HopperBlockEntity self2) {
		ItemStack st = self.getItem(slot);
		return dev.larattalabs.architect.site.FillGuard.guarded(level, pos, st) ? ItemStack.EMPTY : st;
	}
}
