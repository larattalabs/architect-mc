package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.commands.data.BlockDataAccessor;
import net.minecraft.world.level.block.entity.BlockEntity;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, §6.1 item 3) {@code /data merge|modify|remove block} on a held cell is refused with the hold named; nothing is written. */
@Mixin(BlockDataAccessor.class)
public abstract class TxnHoldDataMixin {
	@Shadow
	@Final
	private BlockEntity entity;

	@Shadow
	@Final
	private BlockPos pos;

	@Inject(method = "setData", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldData(CompoundTag tag, CallbackInfo ci) {
		String why = TxnServer.cellWhy(entity.getLevel(), pos);
		if (why != null) {
			throw TxnServer.sneaky(TxnServer.commandRefused("/data", why)); // DataAccessor.setData declares it; this override does not
		}
	}
}
