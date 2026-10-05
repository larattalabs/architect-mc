package dev.larattalabs.architect.client.mixin;

import com.mojang.blaze3d.systems.RenderSystem;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.client.ClientEnv;
import org.lwjgl.sdl.SDLHints;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Sets SDL hints before SDL is initialised (26.3 uses SDL3 for windowing/input, not GLFW).
 * By default the window is shown WITHOUT activating it, so a dev launch never steals focus.
 * Set ARCHITECT_FOCUS=1 to get the normal "come to front" behaviour.
 */
@Mixin(RenderSystem.class)
public abstract class RenderSystemMixin {
	@Inject(method = "initBackendSystem", at = @At("HEAD"), remap = false)
	private static void architect$sdlHints(CallbackInfoReturnable<?> cir) {
		if (!ClientEnv.TAKE_FOCUS) {
			SDLHints.SDL_SetHint("SDL_WINDOW_ACTIVATE_WHEN_SHOWN", "0");
			SDLHints.SDL_SetHint("SDL_WINDOW_ACTIVATE_WHEN_RAISED", "0");
			SDLHints.SDL_SetHint("SDL_FORCE_RAISEWINDOW", "0");
			Architect.LOGGER.info("Window will open without taking focus (ARCHITECT_FOCUS=1 to change)");
		}
	}
}
