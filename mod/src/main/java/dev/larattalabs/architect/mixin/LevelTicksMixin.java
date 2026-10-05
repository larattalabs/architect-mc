package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.TickDeferral;
import net.minecraft.world.ticks.LevelTicks;
import net.minecraft.world.ticks.ScheduledTick;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Block and fluid ticks scheduled while a ticked placement writes its cells are held back until the placement is complete
 * ({@link TickDeferral}): the atomic placement writes everything in one tick, so the ticks it schedules always run on the
 * finished building. Only active inside Architect's own write slices.
 */
@Mixin(LevelTicks.class)
public abstract class LevelTicksMixin<T> {
	@Inject(method = "schedule", at = @At("HEAD"), cancellable = true)
	private void architect$defer(ScheduledTick<T> tick, CallbackInfo ci) {
		if (TickDeferral.capture(tick)) {
			ci.cancel();
		}
	}
}
