package dev.larattalabs.architect.mixin;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.decoration.ItemFrame;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (Slice LC3) An item put into an empty item frame inside a box being removed is refused ({@code RemovalSeal}): the frame would pop off
 * with its support and the removal's drop clear take the item. Turning a framed item stays as vanilla.
 */
@Mixin(ItemFrame.class)
public abstract class ItemFrameSealMixin {
	@Inject(method = "interact", at = @At("HEAD"), cancellable = true)
	private void architect$sealedFrame(Player player, InteractionHand hand, Vec3 at, CallbackInfoReturnable<InteractionResult> cir) {
		ItemFrame self = (ItemFrame) (Object) this;
		if (dev.larattalabs.architect.site.RemovalSeal.refusesFrame(player, player.getItemInHand(hand), self.getItem(), self.level(), self.getPos())) {
			cir.setReturnValue(InteractionResult.FAIL);
		}
	}
}
