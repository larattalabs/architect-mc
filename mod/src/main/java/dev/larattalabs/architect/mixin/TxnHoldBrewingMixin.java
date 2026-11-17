package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.entity.BrewingStandBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) A held brewing stand doesn't tick: it neither takes blaze powder as fuel nor brews. */
@Mixin(BrewingStandBlockEntity.class)
public abstract class TxnHoldBrewingMixin {
	@Inject(method = "serverTick", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTick(ServerLevel level, BlockPos pos, BlockState state, BrewingStandBlockEntity be, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}
}
