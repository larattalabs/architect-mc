package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.world.level.chunk.ChunkAccess;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (SS) Timing only: splits a flushed chunk save into its parts (the chunks' copies, POI, the pending unloads, the wait for the chunk IO),
 * for {@link SaveTiming}. Does nothing unless a stockpile save is being timed. Server thread.
 */
@Mixin(ChunkMap.class)
public abstract class SaveTimingMixin {
	@Inject(method = "saveAllChunks", at = @At("HEAD"))
	private void architect$chunks(boolean flush, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.CHUNKS);
	}

	@Inject(method = "saveAllChunks", at = @At(value = "INVOKE", target = "Lnet/minecraft/world/entity/ai/village/poi/PoiManager;flushAll()V"))
	private void architect$poi(boolean flush, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.POI);
	}

	@Inject(method = "saveAllChunks", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/level/ChunkMap;processUnloads(Ljava/util/function/BooleanSupplier;)V"))
	private void architect$unloads(boolean flush, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.UNLOADS);
	}

	@Inject(method = "saveAllChunks", at = @At(value = "INVOKE", target = "Lnet/minecraft/server/level/ChunkMap;synchronize(Z)Ljava/util/concurrent/CompletableFuture;"))
	private void architect$io(boolean flush, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.IO);
	}

	@Inject(method = "saveAllChunks", at = @At("RETURN"))
	private void architect$chunksDone(boolean flush, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.OTHER);
	}

	@Inject(method = "save(Lnet/minecraft/world/level/chunk/ChunkAccess;)Z", at = @At("RETURN"))
	private void architect$saved(ChunkAccess chunk, CallbackInfoReturnable<Boolean> cir) {
		if (cir.getReturnValueZ()) {
			SaveTiming.chunkSaved();
		}
	}
}
