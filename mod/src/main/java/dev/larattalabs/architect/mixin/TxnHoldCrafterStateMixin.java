package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.CrafterBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a fix round, GPT P1-2 and P2-6) A held crafter's data stays as it was: its own {@code stillValid} (which does not call the
 * guarded base) answers false, so its menu closes; its trigger, its crafting countdown ({@code serverTick}) and its disabled slots do not
 * change.
 */
@Mixin(CrafterBlockEntity.class)
public abstract class TxnHoldCrafterStateMixin {
	private boolean architect$held() {
		BlockEntity be = (BlockEntity) (Object) this;
		return TxnServer.boxHeld(be.getLevel(), be.getBlockPos());
	}

	@Inject(method = "stillValid", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldValid(Player player, CallbackInfoReturnable<Boolean> cir) {
		if (architect$held()) {
			cir.setReturnValue(false);
		}
	}

	@Inject(method = "setTriggered", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldTrigger(boolean on, CallbackInfo ci) {
		if (architect$held()) {
			ci.cancel();
		}
	}

	@Inject(method = "setSlotState", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldSlotState(int slot, boolean enabled, CallbackInfo ci) {
		if (architect$held()) {
			ci.cancel();
		}
	}

	@Inject(method = "serverTick", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTick(Level level, BlockPos pos, BlockState state, CrafterBlockEntity be, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}
}
