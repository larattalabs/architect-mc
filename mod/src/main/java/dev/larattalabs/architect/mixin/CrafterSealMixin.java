package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.CrafterBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (Slice LC3 fix, review 4) A crafter that stands in, or outputs into, a box being removed ({@code RemovalSeal}) does not craft: refused at
 * the head of {@code dispenseFrom}, before it assembles the result, consumes its inputs or ejects any leftover.
 */
@Mixin(CrafterBlock.class)
public abstract class CrafterSealMixin {
	@Inject(method = "dispenseFrom", at = @At("HEAD"), cancellable = true)
	private void architect$sealedCraft(BlockState state, ServerLevel level, BlockPos pos, CallbackInfo ci) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesCraft(level, pos, state.getValue(BlockStateProperties.ORIENTATION).front())) {
			ci.cancel();
		}
	}
}
