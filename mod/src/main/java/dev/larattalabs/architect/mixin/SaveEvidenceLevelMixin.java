package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveEvidence;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProgressListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice SOFF; SOFF2) A level's save as the world save visits it: skipped ({@code noSave && !force}) at its head, written only when it returns
 * (a level save that throws is never recorded as written). Into the running save's own frame. Server thread.
 */
@Mixin(ServerLevel.class)
public abstract class SaveEvidenceLevelMixin {
	@Inject(method = "save", at = @At("HEAD"))
	private void architect$skipped(ProgressListener progress, boolean flush, boolean skip, CallbackInfo ci) {
		if (skip) {
			SaveEvidence.level((ServerLevel) (Object) this, true, false);
		}
	}

	@Inject(method = "save", at = @At("RETURN"))
	private void architect$written(ProgressListener progress, boolean flush, boolean skip, CallbackInfo ci) {
		if (!skip) {
			SaveEvidence.level((ServerLevel) (Object) this, false, true);
		}
	}
}
