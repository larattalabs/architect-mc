package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.RegionDurability;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import net.minecraft.world.level.chunk.storage.RegionFile;
import net.minecraft.world.level.chunk.storage.RegionFileVersion;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (SS) A flushed save forces (fsyncs; F_FULLFSYNC on macOS) every region file its storages hold open, written or not. This skips the force
 * of a file known clean: no write since a force of this object that returned normally. Every rule (unknown at open, a failed force
 * covers nothing, a close owes until its force returns, the device barrier, the check before the ledger) is in {@link RegionDurability};
 * this class only reports the file's events to it.
 * <ul>
 * <li>Writes: every write of the region file's channel goes through {@code writeHeader} ({@code write} after its sectors, {@code clear});
 * {@code padToFullSector} runs only in {@code close}, which forces. A bytecode test pins this.</li>
 * <li>An oversized chunk's payload ({@code writeToExternalFile}, its own .mcc channel, which vanilla never forces) is forced here before
 * its channel closes, and the directory holding the renamed .mcc is synced at the file's next forcing flush, before the ledger.</li>
 * </ul>
 */
@Mixin(RegionFile.class)
public abstract class RegionFileFlushMixin {
	@Shadow
	@Final
	private Path path;
	@Shadow
	@Final
	private Path externalFileDir;
	@Shadow
	@Final
	private RegionStorageInfo info;

	@Unique
	private RegionDurability.State architect$state;

	@Inject(method = "<init>(Lnet/minecraft/world/level/chunk/storage/RegionStorageInfo;Ljava/nio/file/Path;Ljava/nio/file/Path;"
		+ "Lnet/minecraft/world/level/chunk/storage/RegionFileVersion;Z)V", at = @At("RETURN"))
	private void architect$open(RegionStorageInfo info, Path path, Path externalFileDir, RegionFileVersion version, boolean sync, CallbackInfo ci) {
		architect$state = RegionDurability.open(path, info.type());
	}

	@Inject(method = "writeHeader", at = @At("HEAD"))
	private void architect$written(CallbackInfo ci) {
		RegionDurability.written(architect$state);
	}

	@Redirect(method = "writeToExternalFile", at = @At(value = "INVOKE", target = "Ljava/nio/channels/FileChannel;write(Ljava/nio/ByteBuffer;)I"))
	private int architect$external(FileChannel ext, ByteBuffer data) throws IOException {
		int n = ext.write(data);
		ext.force(true); // the payload durable before the rename publishes it
		RegionDurability.externalWritten(architect$state);
		return n;
	}

	@Inject(method = "flush", at = @At("HEAD"), cancellable = true)
	private void architect$flush(CallbackInfo ci) throws IOException {
		if (RegionDurability.skip(architect$state)) {
			ci.cancel();
			return;
		}
		if (RegionDurability.needsDirSync(architect$state)) {
			architect$syncDir(externalFileDir);
		}
	}

	@Inject(method = "flush", at = @At("RETURN"))
	private void architect$forced(CallbackInfo ci) {
		RegionDurability.forced(architect$state);
	}

	@Inject(method = "close", at = @At("HEAD"))
	private void architect$closing(CallbackInfo ci) {
		RegionDurability.closing(architect$state);
	}

	@Inject(method = "close", at = @At(value = "INVOKE", target = "Ljava/nio/channels/FileChannel;force(Z)V"))
	private void architect$closeForcing(CallbackInfo ci) throws IOException {
		RegionDurability.closeForcing(architect$state);
	}

	@Inject(method = "close", at = @At(value = "INVOKE", target = "Ljava/nio/channels/FileChannel;force(Z)V", shift = At.Shift.AFTER))
	private void architect$closeForced(CallbackInfo ci) {
		RegionDurability.closeForced(architect$state);
	}

	/** The rename of a .mcc into {@code dir} made durable (a directory fsync). Windows can't open a directory: NTFS journals the rename. */
	@Unique
	private static void architect$syncDir(Path dir) throws IOException {
		try (FileChannel d = FileChannel.open(dir, StandardOpenOption.READ)) {
			d.force(true);
		} catch (IOException e) {
			if (!System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).startsWith("windows")) {
				throw e;
			}
		}
		RegionDurability.dirSynced();
	}
}
