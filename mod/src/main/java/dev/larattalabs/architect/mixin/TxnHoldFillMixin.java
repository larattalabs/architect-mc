package dev.larattalabs.architect.mixin;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.function.Predicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.arguments.blocks.BlockInput;
import net.minecraft.server.commands.FillCommand;
import net.minecraft.world.level.block.state.pattern.BlockInWorld;
import net.minecraft.world.level.levelgen.structure.BoundingBox;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** (slice T2a, §6.1 item 3) {@code /fill} over a region holding a held cell is refused whole, with the hold named. */
@Mixin(FillCommand.class)
public abstract class TxnHoldFillMixin {
	@Inject(method = "fillBlocks", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldFill(CommandSourceStack src, BoundingBox box, BlockInput block, @Coerce Object mode, Predicate<BlockInWorld> filter,
		boolean strict, CallbackInfoReturnable<Integer> cir) throws CommandSyntaxException {
		String why = TxnServer.regionHeld(src.getLevel(), box.minX(), box.minY(), box.minZ(), box.maxX(), box.maxY(), box.maxZ());
		if (why != null) {
			throw TxnServer.commandRefused("/fill", why);
		}
	}
}
