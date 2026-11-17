package dev.larattalabs.architect.mixin;

import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.storage.PlayerDataStorage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (slice T0) A player's data save that failed: vanilla's {@code PlayerDataStorage.save} catches the exception and logs "Failed to save
 * player data for {}"; the log call is counted, so {@code DurableBarrier} refuses instead of reading the save as done.
 */
@Mixin(PlayerDataStorage.class)
public abstract class PlayerSaveFailMixin {
	@Inject(method = "save", at = @At(value = "INVOKE", target = "Lorg/slf4j/Logger;warn(Ljava/lang/String;Ljava/lang/Object;)V"))
	private void architect$failed(Player player, CallbackInfo ci) {
		dev.larattalabs.architect.site.DurableBarrier.playerSaveFailed();
	}
}
