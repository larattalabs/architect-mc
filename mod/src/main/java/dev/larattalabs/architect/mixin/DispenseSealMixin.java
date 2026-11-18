package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.DispenserBlock;
import net.minecraft.world.level.block.DropperBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (Slice LC3 fix) A dispenser or dropper in a box being removed ({@code RemovalSeal}) fires nothing: its contents are the restore's, and a
 * restart writes them again. The dropper overrides {@code dispenseFrom}, so both are targets.
 */
@Mixin({DispenserBlock.class, DropperBlock.class})
public abstract class DispenseSealMixin {
	@Inject(method = "dispenseFrom", at = @At("HEAD"), cancellable = true)
	private void architect$sealedDispense(ServerLevel level, BlockState state, BlockPos pos, CallbackInfo ci) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesDispense(level, pos)) {
			ci.cancel();
		}
	}
}
