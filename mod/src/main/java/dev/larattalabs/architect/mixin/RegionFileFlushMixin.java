package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.world.level.chunk.storage.RegionFile;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (SS) A flushed save forces (fsyncs; F_FULLFSYNC on macOS) every region file the storage has open, written or not: chunks, entities and
 * POI, in every level. Most of a flushed save's wait was those forces of files nothing had written since their last force. This skips the
 * force of a file with no write since its last successful force: such a file has nothing to make durable, so every byte a save makes
 * durable before the ledger is written (the PS/J1 order) is still made durable first.
 * <ul>
 * <li>Every write of a region file's channel goes through {@code writeHeader} ({@code write}, after its sectors, and {@code clear}); a
 * bytecode test checks it. Each one counts a write.</li>
 * <li>A force records the count it saw at its start, and only when it returns normally: a write counted after that start, or a force that
 * threw, leaves the file to be forced at the next flush.</li>
 * <li>{@code close} (eviction from the storage's cache, the storage's close) still forces unconditionally; a file reopened is a new object
 * that starts with nothing to force.</li>
 * </ul>
 * A region file is written and flushed from its storage's IO worker (a consecutive executor: one task at a time); the counters are atomic
 * anyway.
 */
@Mixin(RegionFile.class)
public abstract class RegionFileFlushMixin {
	/** Writes of this file's channel (via writeHeader), this object's life. */
	@Unique
	private final AtomicLong architect$writes = new AtomicLong();
	/** The write count that the last successful force covered. */
	@Unique
	private volatile long architect$forcedAt;
	/** The write count at the start of the force in progress. */
	@Unique
	private volatile long architect$forcing;

	@Inject(method = "writeHeader", at = @At("HEAD"))
	private void architect$markWritten(CallbackInfo ci) {
		architect$writes.incrementAndGet();
	}

	@Inject(method = "flush", at = @At("HEAD"), cancellable = true)
	private void architect$flush(CallbackInfo ci) {
		long w = architect$writes.get();
		if (w == architect$forcedAt && !SaveTiming.forceAll) {
			SaveTiming.forceSkipped();
			ci.cancel();
			return;
		}
		architect$forcing = w;
		SaveTiming.forced();
	}

	@Inject(method = "flush", at = @At("RETURN"))
	private void architect$forced(CallbackInfo ci) {
		architect$forcedAt = architect$forcing; // only a force that returned: one that threw is retried at the next flush
	}
}
