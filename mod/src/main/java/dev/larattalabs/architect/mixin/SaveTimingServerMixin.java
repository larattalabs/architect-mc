package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** (SS) Timing only: the server's part of a world save (level.dat, the server's saved data), for {@link SaveTiming}. Server thread. */
@Mixin(MinecraftServer.class)
public abstract class SaveTimingServerMixin {
	@Inject(method = "saveAllChunks", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/world/level/storage/LevelStorageSource$LevelStorageAccess;saveDataTag(Lnet/minecraft/world/level/storage/WorldData;Ljava/util/UUID;)V"))
	private void architect$levelDat(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		SaveTiming.at(SaveTiming.LEVEL_DAT);
	}

	@Inject(method = "saveAllChunks", at = @At(value = "INVOKE", target = "Lnet/minecraft/world/level/storage/SavedDataStorage;saveAndJoin()V"))
	private void architect$data(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		SaveTiming.at(SaveTiming.DATA);
	}

	@Inject(method = "saveAllChunks", at = @At("RETURN"))
	private void architect$done(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		SaveTiming.at(SaveTiming.OTHER);
	}
}
