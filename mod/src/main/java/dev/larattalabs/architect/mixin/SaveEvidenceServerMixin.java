package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveEvidence;
import dev.larattalabs.architect.site.SaveHold;
import net.minecraft.server.MinecraftServer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice SOFF) saveEverything (players first, then the chunks: an autosave, /save-all) bracketed, so the world save's callback knows its
 * players were saved with it; and /save-off ({@code setAutoSave(false)}) runs Architect's confirmed save of the pending ledger first.
 */
@Mixin(MinecraftServer.class)
public abstract class SaveEvidenceServerMixin {
	@Inject(method = "saveEverything", at = @At("HEAD"))
	private void architect$everythingIn(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		SaveEvidence.everything(true);
	}

	@Inject(method = "saveEverything", at = @At("RETURN"))
	private void architect$everythingOut(boolean silent, boolean flush, boolean force, CallbackInfoReturnable<Boolean> cir) {
		SaveEvidence.everything(false);
	}

	@Inject(method = "setAutoSave", at = @At("HEAD"))
	private void architect$beforeSavingOff(boolean on, CallbackInfoReturnable<Boolean> cir) {
		if (!on) {
			SaveHold.beforeSavingOff((MinecraftServer) (Object) this);
		}
	}
}
