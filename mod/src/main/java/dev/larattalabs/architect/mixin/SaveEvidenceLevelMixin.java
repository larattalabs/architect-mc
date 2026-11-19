package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveEvidence;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProgressListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice SOFF) A level's save as the world save visits it: written, or skipped ({@code noSave && !force}). Server thread. */
@Mixin(ServerLevel.class)
public abstract class SaveEvidenceLevelMixin {
	@Inject(method = "save", at = @At("HEAD"))
	private void architect$evidence(ProgressListener progress, boolean flush, boolean skip, CallbackInfo ci) {
		SaveEvidence.level((ServerLevel) (Object) this, skip);
	}
}
