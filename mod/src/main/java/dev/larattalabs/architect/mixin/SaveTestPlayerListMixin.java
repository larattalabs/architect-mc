package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTestHooks;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.players.PlayerList;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** (slice SOFF2, TEST) PlayerList.saveAll's head: the rawSaveIn playerSave hook (another mod's chunk save before the players are written). */
@Mixin(PlayerList.class)
public abstract class SaveTestPlayerListMixin {
	@Shadow
	@Final
	private MinecraftServer server;

	@Inject(method = "saveAll", at = @At("HEAD"))
	private void architect$testPlayersSaving(CallbackInfo ci) {
		SaveTestHooks.playersSaving(server);
	}
}
