package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import java.util.function.BiConsumer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Explosion;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.6 "Holds") An explosion leaves a container an open txn holds standing (nothing dropped, nothing
 * destroyed). O(1) with no txn open.
 */
@Mixin(BlockBehaviour.class)
public abstract class TxnHoldExplosionMixin {
	@Inject(method = "onExplosionHit", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldBlast(BlockState state, ServerLevel level, BlockPos pos, Explosion explosion, BiConsumer<ItemStack, BlockPos> drop,
		CallbackInfo ci) {
		if (dev.larattalabs.architect.site.Fills.heldBox(level, pos) || dev.larattalabs.architect.site.RemovalSeal.refusesBlast(level, pos)) { // (PSVLC3) the removal seal too
			ci.cancel();
		}
	}
}
