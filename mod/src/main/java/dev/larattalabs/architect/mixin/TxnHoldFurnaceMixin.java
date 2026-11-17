package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) A held furnace, blast furnace or smoker doesn't tick: it neither burns fuel nor smelts (its
 * own slots, written outside {@code setItem}). Its {@code setItem} override is fenced like every container's ({@link TxnHoldContentMixin}).
 */
@Mixin(AbstractFurnaceBlockEntity.class)
public abstract class TxnHoldFurnaceMixin {
	@Inject(method = "serverTick", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTick(ServerLevel level, BlockPos pos, BlockState state, AbstractFurnaceBlockEntity be, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}

	@Inject(method = "setItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldSet(int slot, ItemStack stack, CallbackInfo ci) {
		AbstractFurnaceBlockEntity be = (AbstractFurnaceBlockEntity) (Object) this;
		if (TxnServer.boxHeld(be.getLevel(), be.getBlockPos())) {
			TxnServer.backstop("setItem", be.getBlockPos());
			ci.cancel();
		}
	}
}
