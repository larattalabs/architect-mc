package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.wither.WitherBoss;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/**
 * (slice T4c, PL-gpt2 5) A wither's block breaking ({@code customServerAiStep}'s {@code destroyBlock}) leaves a sealed removal box's holder,
 * a held box and a waiting fill's container standing, as an explosion's and a player's breaks do (the seal's other hooks never saw it).
 */
@Mixin(WitherBoss.class)
public abstract class SealWitherMixin {
	@WrapOperation(method = "customServerAiStep", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/level/ServerLevel;destroyBlock(Lnet/minecraft/core/BlockPos;ZLnet/minecraft/world/entity/Entity;)Z"))
	private boolean architect$sealedWither(ServerLevel level, BlockPos pos, boolean drop, Entity by, Operation<Boolean> original) {
		if (dev.larattalabs.architect.site.RemovalSeal.refusesBlast(level, pos) || dev.larattalabs.architect.site.Fills.heldBox(level, pos)) {
			return false;
		}
		return original.call(level, pos, drop, by);
	}
}
