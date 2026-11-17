package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.entity.HopperBlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 2) A held hopper is a writer of its own slots: it neither pushes, pulls ({@code pushItemsTick})
 * nor takes in item entities that land on it ({@code entityInside}). Its {@code setItem}/{@code removeItem} overrides are fenced as every
 * container's ({@link TxnHoldContentMixin}). T1's {@link TxnHoldHopperMixin} keeps other hoppers off a held box.
 */
@Mixin(HopperBlockEntity.class)
public abstract class TxnHoldHopperTickMixin {
	@Inject(method = "pushItemsTick", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldTick(Level level, BlockPos pos, BlockState state, HopperBlockEntity be, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}

	@Inject(method = "entityInside", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldInside(Level level, BlockPos pos, BlockState state, Entity entity, HopperBlockEntity be, CallbackInfo ci) {
		if (TxnServer.boxHeld(level, pos)) {
			ci.cancel();
		}
	}

	@Inject(method = "setItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldSet(int slot, ItemStack stack, CallbackInfo ci) {
		HopperBlockEntity be = (HopperBlockEntity) (Object) this;
		if (TxnServer.boxHeld(be.getLevel(), be.getBlockPos())) {
			TxnServer.backstop("setItem", be.getBlockPos());
			ci.cancel();
		}
	}

	@Inject(method = "removeItem", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldRemove(int slot, int n, CallbackInfoReturnable<ItemStack> cir) {
		HopperBlockEntity be = (HopperBlockEntity) (Object) this;
		if (TxnServer.boxHeld(be.getLevel(), be.getBlockPos())) {
			TxnServer.backstop("removeItem", be.getBlockPos());
			cir.setReturnValue(ItemStack.EMPTY);
		}
	}
}
