package dev.larattalabs.architect.devserver.mixin;

import dev.larattalabs.architect.devserver.DevServer;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.util.Util;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Redirect;

/**
 * A headless gate server switches worlds in one process, as a client does with its integrated server (DevServer.openWorld):
 * a server stopped for a switch leaves the shared executors running for the next one. A final stop shuts them down as usual.
 */
@Mixin(DedicatedServer.class)
abstract class KeepExecutorsMixin {
	@Redirect(method = "stopServer", at = @At(value = "INVOKE", target = "Lnet/minecraft/util/Util;shutdownExecutors()V"))
	private void architectDevserver$keepExecutors() {
		if (!DevServer.keepJvm()) {
			Util.shutdownExecutors();
		}
	}
}
