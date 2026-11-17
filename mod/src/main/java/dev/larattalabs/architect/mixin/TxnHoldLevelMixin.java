package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 4) Removal by any path, at the level: {@code destroyBlock} drops the block's loot (a shulker box
 * with its contents, the chest item) before it writes, so it is refused at its head, as {@code setBlock} and {@code removeBlock} are; the
 * chunk's own guard ({@link TxnHoldChunkMixin}) stays the backstop. Withers, the dragon, commands' destroy mode and other mods all come
 * through here. O(1) with no txn open.
 */
@Mixin(value = Level.class, priority = 900)
public abstract class TxnHoldLevelMixin {
	@Inject(method = "setBlock(Lnet/minecraft/core/BlockPos;Lnet/minecraft/world/level/block/state/BlockState;II)Z", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldSet(BlockPos pos, BlockState state, int flags, int recursion, CallbackInfoReturnable<Boolean> cir) {
		if (TxnServer.boxHeld((Level) (Object) this, pos)) {
			cir.setReturnValue(false);
		}
	}

	@Inject(method = "destroyBlock(Lnet/minecraft/core/BlockPos;ZLnet/minecraft/world/entity/Entity;I)Z", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldDestroy(BlockPos pos, boolean drop, @Nullable Entity by, int recursion, CallbackInfoReturnable<Boolean> cir) {
		if (TxnServer.boxHeld((Level) (Object) this, pos)) {
			cir.setReturnValue(false);
		}
	}

	@Inject(method = "removeBlock", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldRemove(BlockPos pos, boolean moving, CallbackInfoReturnable<Boolean> cir) {
		if (TxnServer.boxHeld((Level) (Object) this, pos)) {
			cir.setReturnValue(false);
		}
	}
}
