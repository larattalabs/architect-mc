package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.CrafterBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) A held crafter crafts nothing: its grid is consumed in {@code dispenseFrom}. */
@Mixin(CrafterBlock.class)
public abstract class TxnHoldCrafterMixin {
	@Inject(method = "dispenseFrom", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldCraft(BlockState state, ServerLevel level, BlockPos pos, CallbackInfo ci) {
		if (dev.larattalabs.architect.site.Fills.heldBox(level, pos)) { // (T4 final round, SOFF2 P1 2) a waiting fill's containers too
			ci.cancel();
		}
	}
}
