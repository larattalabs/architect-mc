package dev.larattalabs.architect.mixin;

import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.context.BlockPlaceContext;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (Slice LC3) A block item carrying contents (a filled shulker box) placed into a box being removed ({@code RemovalSeal}), by a player, a
 * dispenser or any other caller of {@code BlockItem.place}, at the real placement cell: refused; the item stays where it was.
 */
@Mixin(BlockItem.class)
public abstract class BlockItemSealMixin {
	@Inject(method = "place(Lnet/minecraft/world/item/context/BlockPlaceContext;)Lnet/minecraft/world/InteractionResult;", at = @At("HEAD"), cancellable = true)
	private void architect$sealedPlace(BlockPlaceContext ctx, CallbackInfoReturnable<InteractionResult> cir) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesPlace(ctx.getItemInHand(), ctx.getLevel(), ctx.getClickedPos(), ctx.getPlayer())) {
			cir.setReturnValue(InteractionResult.FAIL);
		}
	}
}
