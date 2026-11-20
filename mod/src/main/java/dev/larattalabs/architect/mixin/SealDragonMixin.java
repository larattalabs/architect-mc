package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * (slice T4c, PL-gpt2 5) The ender dragon's wall breaking ({@code checkWalls}' {@code removeBlock}) leaves a sealed removal box's holder, a
 * held box and a waiting fill's container standing (removeBlock's setBlock passes no explosion or break hook the seal reads).
 */
@Mixin(EnderDragon.class)
public abstract class SealDragonMixin {
	@WrapOperation(method = "checkWalls", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/level/ServerLevel;removeBlock(Lnet/minecraft/core/BlockPos;Z)Z"))
	private boolean architect$sealedDragon(ServerLevel level, BlockPos pos, boolean moved, Operation<Boolean> original) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesBlast(level, pos) || dev.larattalabs.architect.site.Fills.heldBox(level, pos)) {
			return false;
		}
		return original.call(level, pos, moved);
	}
}
