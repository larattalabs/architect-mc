package dev.larattalabs.architect.mixin;

import net.minecraft.world.Container;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.behavior.TransportItemsBetweenContainers;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (Slice LC3) A copper golem puts its item into a container with its own loop ({@code addItemsToContainer}: {@code Container.setItem}, not
 * the hopper path): refused for a holder in a box being removed ({@code RemovalSeal}); the golem keeps the item (the call answers what it
 * still holds).
 */
@Mixin(TransportItemsBetweenContainers.class)
public abstract class CopperGolemSealMixin {
	@Inject(method = "addItemsToContainer", at = @At("HEAD"), cancellable = true)
	private static void architect$sealedPutDown(PathfinderMob mob, Container container, CallbackInfoReturnable<ItemStack> cir) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesGolem(container)) {
			cir.setReturnValue(mob.getMainHandItem());
		}
	}
}
