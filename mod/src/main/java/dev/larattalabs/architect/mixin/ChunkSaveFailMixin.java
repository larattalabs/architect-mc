package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.ChunkDebt;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T0, review P1-3) Every chunk, entity and POI save failure vanilla reports ({@code ChunkMap.save}'s serialization and its write
 * future, {@code EntityStorage}, {@code SectionStorage}) is owed in {@link ChunkDebt} until a later write of that chunk succeeds.
 */
@Mixin(MinecraftServer.class)
public abstract class ChunkSaveFailMixin {
	@Inject(method = "reportChunkSaveFailure", at = @At("HEAD"), require = 1)
	private void architect$failed(Throwable t, RegionStorageInfo info, ChunkPos pos, CallbackInfo ci) {
		ChunkDebt.saveFailed(ChunkDebt.key(info, pos), String.valueOf(t));
	}
}
