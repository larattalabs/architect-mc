package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.ChestBlock;
import net.minecraft.world.level.block.DoubleBlockCombiner;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.ChestType;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 1) The double chest: when either half is held, a chest is its own half alone, so no combined
 * container (a hopper's, a menu's, the Transfer API's, a copper golem's) reaches a held half through the other. A txn on a double chest
 * holds both halves ({@code TestMoveCells.partner}); this covers a chest whose state names a held neighbour (one placed beside a held box,
 * which itself keeps its state: {@link TxnHoldChunkMixin}). O(1) with no txn open.
 */
@Mixin(ChestBlock.class)
public abstract class TxnHoldChestMixin {
	@Inject(method = "combine", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldHalf(BlockState state, Level level, BlockPos pos, boolean ignoreBlocked,
		CallbackInfoReturnable<DoubleBlockCombiner.NeighborCombineResult<? extends ChestBlockEntity>> cir) {
		if (TxnServer.cellHolder(level, pos) == null && (state.getValue(ChestBlock.TYPE) == ChestType.SINGLE
			|| TxnServer.cellHolder(level, ChestBlock.getConnectedBlockPos(pos, state)) == null)) {
			return;
		}
		BlockEntity be = level.getBlockEntity(pos);
		if (be instanceof ChestBlockEntity c) {
			cir.setReturnValue(new DoubleBlockCombiner.NeighborCombineResult.Single<>(c));
		}
	}
}
