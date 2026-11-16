package dev.larattalabs.architect.mixin;

import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.entity.BaseContainerBlockEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (Slice LC3) A block container's menu opened before its box's removal began: no longer valid while the box is sealed
 * ({@code RemovalSeal}). The server refuses its clicks ({@code handleContainerClick} asks {@code stillValid} first) and closes it next tick.
 */
@Mixin(BaseContainerBlockEntity.class)
public abstract class ContainerStillValidMixin {
	@Inject(method = "stillValid", at = @At("HEAD"), cancellable = true)
	private void architect$sealedMenu(Player player, CallbackInfoReturnable<Boolean> cir) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesMenu((BaseContainerBlockEntity) (Object) this, player)) {
			cir.setReturnValue(false);
		}
	}
}
