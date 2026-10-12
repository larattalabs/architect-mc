package dev.larattalabs.architect.devserver.mixin;

import net.minecraft.server.network.ServerConnectionListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * A headless gate server takes no network clients (its only player is the bot, on a connection that goes nowhere), so it
 * opens no game port: several servers run side by side on the gate ports alone (docs/GATES.md "Headless gates"). Only with
 * ARCHITECT_HEADLESS=1 (this dev-only mod is loaded on no other server anyway).
 */
@Mixin(ServerConnectionListener.class)
abstract class NoTcpListenerMixin {
	@Inject(method = "startTcpServerListener", at = @At("HEAD"), cancellable = true)
	private void architectDevserver$noListener(java.net.InetAddress address, int port, CallbackInfo ci) {
		if ("1".equals(System.getenv("ARCHITECT_HEADLESS"))) {
			ci.cancel();
		}
	}
}
