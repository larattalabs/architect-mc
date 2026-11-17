package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.RegionDurability;
import java.nio.file.Path;
import net.minecraft.world.level.chunk.storage.RegionFile;
import net.minecraft.world.level.chunk.storage.RegionFileVersion;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (SS) A flushed save forces (fsyncs; F_FULLFSYNC on macOS) every region file its storages hold open, written or not. This skips the force
 * of a file known clean: no write since a force of this object that returned normally. Every rule (unknown at open, a failed force
 * covers nothing, a close owes until its force returns, the device barrier, the check before the ledger) is in {@link RegionDurability};
 * this class only reports the file's events to it.
 * <ul>
 * <li>Writes: every write of the region file's channel goes through {@code writeHeader} ({@code write} after its sectors, {@code clear});
 * {@code padToFullSector} runs only in {@code close}, which forces. A bytecode test pins this.</li>
 * <li>(slice T0, review P1-4) An oversized chunk's payload ({@code writeToExternalFile}: its own .mcc channel and rename, which vanilla
 * never forces) is forced after the write commits, with its folder ({@link RegionDurability#forceNew}: owed when that fails). The region
 * file's stub and header still go through {@code writeHeader}.</li>
 * </ul>
 */
@Mixin(RegionFile.class)
public abstract class RegionFileFlushMixin {
	@Unique
	private RegionDurability.State architect$state;

	@Inject(method = "<init>(Lnet/minecraft/world/level/chunk/storage/RegionStorageInfo;Ljava/nio/file/Path;Ljava/nio/file/Path;"
		+ "Lnet/minecraft/world/level/chunk/storage/RegionFileVersion;Z)V", at = @At("RETURN"))
	private void architect$open(RegionStorageInfo info, Path path, Path externalFileDir, RegionFileVersion version, boolean sync, CallbackInfo ci) {
		architect$state = RegionDurability.open(path, info.type());
	}

	@org.spongepowered.asm.mixin.Shadow
	@org.spongepowered.asm.mixin.Final
	private Path externalFileDir;

	@org.spongepowered.asm.mixin.Shadow
	private Path getExternalChunkPath(net.minecraft.world.level.ChunkPos pos) {
		throw new AssertionError();
	}

	@Unique
	private boolean architect$external;

	@Inject(method = "write(Lnet/minecraft/world/level/ChunkPos;Ljava/nio/ByteBuffer;)V", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/world/level/chunk/storage/RegionFile;writeToExternalFile(Ljava/nio/file/Path;Ljava/nio/ByteBuffer;)Lnet/minecraft/world/level/chunk/storage/RegionFile$CommitOp;"),
		require = 1)
	private void architect$external(net.minecraft.world.level.ChunkPos pos, java.nio.ByteBuffer buf, CallbackInfo ci) {
		architect$external = true;
	}

	@Inject(method = "write(Lnet/minecraft/world/level/ChunkPos;Ljava/nio/ByteBuffer;)V", at = @At("RETURN"), require = 1)
	private void architect$externalCommitted(net.minecraft.world.level.ChunkPos pos, java.nio.ByteBuffer buf, CallbackInfo ci) {
		if (architect$external) {
			architect$external = false;
			RegionDurability.forceNew(architect$state, getExternalChunkPath(pos)); // the .mcc's data (renamed into place by the commit)
			RegionDurability.forceNew(architect$state, externalFileDir); // and its entry
		}
	}

	@Inject(method = "writeHeader", at = @At("HEAD"))
	private void architect$written(CallbackInfo ci) {
		RegionDurability.written(architect$state);
	}

	@Inject(method = "flush", at = @At("HEAD"), cancellable = true)
	private void architect$flush(CallbackInfo ci) throws java.io.IOException {
		if (RegionDurability.skip(architect$state)) {
			ci.cancel();
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
	private void architect$closeForcing(CallbackInfo ci) throws java.io.IOException {
		RegionDurability.closeForcing(architect$state);
	}

	@Inject(method = "close", at = @At(value = "INVOKE", target = "Ljava/nio/channels/FileChannel;force(Z)V", shift = At.Shift.AFTER))
	private void architect$closeForced(CallbackInfo ci) {
		RegionDurability.closeForced(architect$state);
	}

}
