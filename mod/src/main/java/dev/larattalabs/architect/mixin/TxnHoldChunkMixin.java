package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 items 1, 3 and 4) The backstop under every block write: a cell an open txn holds keeps its block
 * state and its block entity. Any state change there is refused ({@code setBlockState} answers "no change"), so nothing replaces or removes
 * the box, a chest placed beside it can't merge it into a double chest, and a command or structure that reaches it writes nothing there
 * (each places its block entity's data only after its block write succeeds). A block entity at the cell is neither replaced nor removed.
 * Ordered first ({@code priority} 900), so {@link LevelChunkMixin}'s tracking never records a refused write. The holder's own adapter writes
 * ({@link TxnServer#asHolder}); a chunk loading registers its block entities with no previous one there. O(1) with no txn open.
 */
@Mixin(value = LevelChunk.class, priority = 900)
public abstract class TxnHoldChunkMixin {
	@Inject(method = "setBlockState", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldState(BlockPos pos, BlockState state, int flags, CallbackInfoReturnable<BlockState> cir) {
		if (TxnServer.boxHeld(((LevelChunk) (Object) this).getLevel(), pos)) {
			cir.setReturnValue(null);
		}
	}

	@Inject(method = "setBlockEntity", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldEntity(BlockEntity be, CallbackInfo ci) {
		LevelChunk self = (LevelChunk) (Object) this;
		if (TxnServer.boxHeld(self.getLevel(), be.getBlockPos())) {
			BlockEntity was = self.getBlockEntities().get(be.getBlockPos());
			if (was != null && was != be) {
				ci.cancel();
			}
		}
	}

	@Inject(method = "removeBlockEntity", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldRemove(BlockPos pos, CallbackInfo ci) {
		if (TxnServer.boxHeld(((LevelChunk) (Object) this).getLevel(), pos)) {
			ci.cancel();
		}
	}
}
