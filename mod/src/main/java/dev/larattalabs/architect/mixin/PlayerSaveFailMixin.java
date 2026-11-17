package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.PlayerSaves;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Optional;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.server.players.NameAndId;
import net.minecraft.util.Util;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.storage.PlayerDataStorage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T0, review P1-1, P1-2) Each player data save acknowledged by its real result ({@link PlayerSaves}). Vanilla's
 * {@code PlayerDataStorage.save} catches its own exception and logs "Failed to save player data for {}", and its {@code Util.safeReplaceFile}
 * drops {@code safeReplaceOrMoveFile}'s false (26.3 bytecode: {@code pop}), so a replace that aborts and keeps the old {@code .dat} looked
 * like success. Here the replace runs as {@code safeReplaceOrMoveFile(.., false)} with its result kept, the snapshot written to the temp file
 * is kept for a retry, and a load first writes a snapshot still owed.
 */
@Mixin(PlayerDataStorage.class)
public abstract class PlayerSaveFailMixin {
	@Inject(method = "save", at = @At("HEAD"), require = 1)
	private void architect$saving(Player player, CallbackInfo ci) {
		PlayerSaves.saving(player.getUUID(), player);
	}

	@Redirect(method = "save", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/nbt/NbtIo;writeCompressed(Lnet/minecraft/nbt/CompoundTag;Ljava/nio/file/Path;)V"), require = 1)
	private void architect$snapshot(CompoundTag tag, Path tmp) throws IOException {
		PlayerSaves.captured(tag);
		NbtIo.writeCompressed(tag, tmp);
	}

	@Redirect(method = "save", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/util/Util;safeReplaceFile(Ljava/nio/file/Path;Ljava/nio/file/Path;Ljava/nio/file/Path;)V"), require = 1)
	private void architect$replace(Path current, Path latest, Path backup) {
		boolean ok;
		if (PlayerSaves.failNext()) { // (TEST) as an aborted replace: the old .dat stays
			ok = false;
			try {
				Files.deleteIfExists(latest);
			} catch (IOException e) {
				// the temp file stays, as vanilla's would
			}
		} else {
			ok = Util.safeReplaceOrMoveFile(current, latest, backup, false);
		}
		PlayerSaves.replaced(ok);
	}

	@Inject(method = "save", at = @At(value = "INVOKE", target = "Lorg/slf4j/Logger;warn(Ljava/lang/String;Ljava/lang/Object;)V"), require = 1)
	private void architect$failed(Player player, CallbackInfo ci) {
		PlayerSaves.failed("the save threw (vanilla logged \"Failed to save player data\")");
	}

	@Inject(method = "save", at = @At("RETURN"), require = 1)
	private void architect$done(Player player, CallbackInfo ci) {
		PlayerSaves.done();
	}

	@Inject(method = "load(Lnet/minecraft/server/players/NameAndId;)Ljava/util/Optional;", at = @At("HEAD"), require = 1)
	private void architect$loading(NameAndId who, CallbackInfoReturnable<Optional<CompoundTag>> cir) {
		PlayerSaves.loading(who.id());
	}
}
