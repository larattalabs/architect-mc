package dev.larattalabs.architect.devserver.mixin;

import dev.larattalabs.architect.devserver.ServerSidecar;
import java.util.function.BooleanSupplier;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * A paused singleplayer game, headless (dev.screen {open: "pause"}): the server skips its ticks as a paused integrated server
 * does, and its task loop keeps running (hooks and commands are answered). Only on a headless gate server.
 */
@Mixin(MinecraftServer.class)
abstract class PauseMixin {
	@Inject(method = "tickServer", at = @At("HEAD"), cancellable = true)
	private void architectDevserver$paused(BooleanSupplier haveTime, CallbackInfo ci) {
		if (ServerSidecar.paused()) {
			ci.cancel();
		}
	}
}
