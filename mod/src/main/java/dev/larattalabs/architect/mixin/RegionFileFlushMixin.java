package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import net.minecraft.world.level.chunk.storage.RegionFile;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (SS) A flushed save forces (fsyncs; F_FULLFSYNC on macOS) every region file the storage has open, written or not: chunks, entities and
 * POI, in every level. Most of a flushed save's wait was those forces of files nothing had written since their last force. This skips the
 * force of a file with no write since its last one: such a file has nothing to make durable, so every byte the save makes durable before
 * the ledger is written (the PS/J1 order) is still made durable first. Every write of a region file goes through {@code writeHeader}
 * ({@code write} and {@code clear}), so that is where a file is marked. A region file is used from its storage's IO worker (one thread);
 * the flag is volatile anyway, and is cleared before the force, so a write racing the force forces again next time.
 */
@Mixin(RegionFile.class)
public abstract class RegionFileFlushMixin {
	@Unique
	private volatile boolean architect$written;

	@Inject(method = "writeHeader", at = @At("HEAD"))
	private void architect$markWritten(CallbackInfo ci) {
		architect$written = true;
	}

	@Inject(method = "flush", at = @At("HEAD"), cancellable = true)
	private void architect$flush(CallbackInfo ci) {
		if (!architect$written && !SaveTiming.forceAll) {
			SaveTiming.forceSkipped();
			ci.cancel();
			return;
		}
		architect$written = false;
		SaveTiming.forced();
	}
}
