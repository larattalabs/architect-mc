package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.RegionDurability;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** (SS) A world save's start: RegionDurability's barrier counts per world save (the players were saved just before it). Server thread. */
@Mixin(MinecraftServer.class)
public abstract class SaveEpochMixin {
	@Inject(method = "saveAllChunks", at = @At("HEAD"))
	private void architect$epoch(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		RegionDurability.saveStarted();
	}
}
