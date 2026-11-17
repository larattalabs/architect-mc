package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** (slice T2a) {@code CloneCommands.DimensionAndPosition} (package-private): its level and position, for {@link TxnHoldCloneMixin}. */
@Mixin(targets = "net.minecraft.server.commands.CloneCommands$DimensionAndPosition")
public interface TxnHoldCloneEndAccessor {
	@Invoker("dimension")
	ServerLevel architect$level();

	@Invoker("position")
	BlockPos architect$pos();
}
