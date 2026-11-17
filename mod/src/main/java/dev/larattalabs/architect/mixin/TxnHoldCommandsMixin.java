package dev.larattalabs.architect.mixin;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.function.Predicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.blocks.BlockInput;
import net.minecraft.core.BlockPos;
import net.minecraft.server.commands.SetBlockCommand;
import net.minecraft.world.level.block.state.pattern.BlockInWorld;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, docs/TXN-DESIGN.md §6.1 item 3) {@code /setblock} on a held cell is refused with the hold named (the cell freeze would refuse
 * it anyway, as "could not set the block"). {@link TxnHoldFillMixin}, {@link TxnHoldCloneMixin}, {@link TxnHoldDataMixin},
 * {@link TxnHoldItemMixin} and {@link TxnHoldLootMixin} do the same for theirs. Operators keep {@code /architect txn resolve} for a hold
 * they must clear.
 */
@Mixin(SetBlockCommand.class)
public abstract class TxnHoldCommandsMixin {
	@Inject(method = "setBlock", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldSetblock(CommandSourceStack src, BlockPos pos, BlockInput block, @Coerce Object mode, Predicate<BlockInWorld> filter,
		boolean strict, CallbackInfoReturnable<Integer> cir) throws CommandSyntaxException {
		String why = TxnServer.cellWhy(src.getLevel(), pos);
		if (why != null) {
			throw TxnServer.commandRefused("/setblock", why);
		}
	}
}
