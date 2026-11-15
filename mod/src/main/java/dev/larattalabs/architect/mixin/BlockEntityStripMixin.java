package dev.larattalabs.architect.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.Container;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (FK-b, docs/CONTRACT.md "### FK-b contract" 5a) Every container's contents drop through {@code preRemoveSideEffects} (no container
 * overrides it): at its head a declared container of a filled site loses its provided stacks before vanilla drops the rest. A player's
 * break, explosions, the wither and dragon, commands. Architect's own writes skip block-entity side effects, so never on a removal or undo.
 */
@Mixin(BlockEntity.class)
public abstract class BlockEntityStripMixin {
	@Inject(method = "preRemoveSideEffects", at = @At("HEAD"))
	private void architect$stripProvided(BlockPos pos, BlockState state, CallbackInfo ci) {
		BlockEntity self = (BlockEntity) (Object) this;
		if (self instanceof Container c && self.getLevel() instanceof ServerLevel level) {
			dev.larattalabs.architect.site.FillGuard.strip(level, pos, c);
		}
	}
}
