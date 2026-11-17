package dev.larattalabs.architect.mixin;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.server.commands.LootCommand;
import net.minecraft.world.item.ItemStack;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice T2a, §6.1 item 3) {@code /loot insert} and {@code /loot replace block} into a held cell are refused with the hold named. */
@Mixin(LootCommand.class)
public abstract class TxnHoldLootMixin {
	@Inject(method = "blockDistribute", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldInsert(CommandSourceStack src, BlockPos pos, List<ItemStack> drops, @Coerce Object tracker, CallbackInfo ci)
		throws CommandSyntaxException {
		String why = TxnServer.cellWhy(src.getLevel(), pos);
		if (why != null) {
			throw TxnServer.commandRefused("/loot", why);
		}
	}

	@Inject(method = "blockReplace", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldReplace(CommandSourceStack src, BlockPos pos, int from, int n, List<ItemStack> drops, @Coerce Object tracker,
		CallbackInfo ci) throws CommandSyntaxException {
		String why = TxnServer.cellWhy(src.getLevel(), pos);
		if (why != null) {
			throw TxnServer.commandRefused("/loot", why);
		}
	}
}
