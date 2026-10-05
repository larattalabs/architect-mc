package dev.larattalabs.architect.client.mixin;

import net.minecraft.client.Camera;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** dev.record: the camera's smoothed eye height, so a recorded pose lands on the exact eye position. */
@Mixin(Camera.class)
public interface CameraAccessor {
	@Accessor("eyeHeight")
	float architect$eyeHeight();

	@Accessor("eyeHeightOld")
	float architect$eyeHeightOld();
}
