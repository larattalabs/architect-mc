package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.util.ProgressListener;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (SS) Timing only: a level's save split into its saved data, its chunks and its entities, for {@link SaveTiming}. Server thread. */
@Mixin(ServerLevel.class)
public abstract class SaveTimingLevelMixin {
	@Inject(method = "save", at = @At("HEAD"))
	private void architect$data(ProgressListener progress, boolean flush, boolean noSave, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.DATA);
	}

	@Inject(method = "save", at = @At(value = "INVOKE", target = "Lnet/minecraft/world/level/entity/PersistentEntitySectionManager;saveAll()V"))
	private void architect$entities(ProgressListener progress, boolean flush, boolean noSave, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.ENTITIES);
	}

	@Inject(method = "save", at = @At(value = "INVOKE", target = "Lnet/minecraft/world/level/entity/PersistentEntitySectionManager;autoSave()V"))
	private void architect$entitiesAuto(ProgressListener progress, boolean flush, boolean noSave, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.ENTITIES);
	}

	@Inject(method = "save", at = @At("RETURN"))
	private void architect$done(ProgressListener progress, boolean flush, boolean noSave, CallbackInfo ci) {
		SaveTiming.at(SaveTiming.OTHER);
	}
}
