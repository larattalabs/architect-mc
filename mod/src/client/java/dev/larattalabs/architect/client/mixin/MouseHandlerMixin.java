package dev.larattalabs.architect.client.mixin;

import dev.larattalabs.architect.client.design.MassingReview;
import dev.larattalabs.architect.client.placement.PlacementFeature;
import net.minecraft.client.MouseHandler;
import net.minecraft.client.input.MouseButtonInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MouseHandler.class)
public abstract class MouseHandlerMixin {
	/**
	 * (PR2) A placing, plot or massing action bound to a mouse button (Controls &gt; "Architect: while placing", e.g. Rotate on Mouse 4)
	 * acts as its key would, by the same rules as {@link KeyboardHandlerMixin}: only while placing, marking or reviewing with no screen
	 * open, and only a button bound to one of those actions is consumed. Releases always pass through.
	 */
	@Inject(method = "onButton", at = @At("HEAD"), cancellable = true)
	private void architect$placingButtons(long window, MouseButtonInfo info, int action, CallbackInfo ci) {
		if (PlacementFeature.onMouse(action, info.button(), info.hasShiftDown()) || MassingReview.onMouse(action, info.button(), info.hasShiftDown())) {
			ci.cancel();
		}
	}
}
