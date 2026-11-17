package dev.larattalabs.architect.mixin;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.larattalabs.architect.txn.TxnServer;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.server.commands.item.BlockItemAccessor;
import net.minecraft.world.item.slot.SlotSource;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, §6.1 item 3) {@code /item replace|modify block} writing a held cell is refused with the hold named (reading one is not). */
@Mixin(BlockItemAccessor.class)
public abstract class TxnHoldItemMixin {
	@Shadow
	@Final
	private BlockPos pos;

	@Inject(method = "setItems", at = @At("HEAD"), cancellable = true)
	private void architect$txnHeldItems(CommandSourceStack src, SlotSource slots, @Coerce Object setter, CallbackInfo ci) throws CommandSyntaxException {
		String why = TxnServer.cellWhy(src.getLevel(), pos);
		if (why != null) {
			throw TxnServer.commandRefused("/item", why);
		}
	}
}
