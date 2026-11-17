package dev.larattalabs.architect.mixin;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.larattalabs.architect.txn.TxnServer;
import java.util.function.Predicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.BlockPos;
import net.minecraft.server.commands.CloneCommands;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.pattern.BlockInWorld;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Coerce;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T2a, §6.1 item 3) {@code /clone} touching a held cell is refused whole, with the hold named: in its destination (each cell
 * would be refused by the freeze, so a partial clone), and in its source (a move copies first and then clears the source: a copy of the
 * held box would stand while the box itself stays). A plain copy out of a held box is refused too, for one simple rule.
 */
@Mixin(CloneCommands.class)
public abstract class TxnHoldCloneMixin {
	@Inject(method = "clone", at = @At("HEAD"), cancellable = true)
	private static void architect$txnHeldClone(CommandSourceStack src, @Coerce Object begin, @Coerce Object end, @Coerce Object dest,
		Predicate<BlockInWorld> filter, @Coerce Object mode, boolean strict, CallbackInfoReturnable<Integer> cir) throws CommandSyntaxException {
		TxnHoldCloneEndAccessor a = (TxnHoldCloneEndAccessor) begin, b = (TxnHoldCloneEndAccessor) end, d = (TxnHoldCloneEndAccessor) dest;
		BlockPos lo = new BlockPos(Math.min(a.architect$pos().getX(), b.architect$pos().getX()), Math.min(a.architect$pos().getY(), b.architect$pos().getY()),
			Math.min(a.architect$pos().getZ(), b.architect$pos().getZ()));
		BlockPos hi = new BlockPos(Math.max(a.architect$pos().getX(), b.architect$pos().getX()), Math.max(a.architect$pos().getY(), b.architect$pos().getY()),
			Math.max(a.architect$pos().getZ(), b.architect$pos().getZ()));
		String why = TxnServer.regionHeld(a.architect$level(), lo.getX(), lo.getY(), lo.getZ(), hi.getX(), hi.getY(), hi.getZ());
		if (why == null) {
			BlockPos o = d.architect$pos();
			why = TxnServer.regionHeld(d.architect$level(), o.getX(), o.getY(), o.getZ(), o.getX() + hi.getX() - lo.getX(), o.getY() + hi.getY() - lo.getY(),
				o.getZ() + hi.getZ() - lo.getZ());
		}
		if (why != null) {
			throw TxnServer.commandRefused("/clone", why);
		}
	}

}
