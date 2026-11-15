package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.SaveTiming;
import java.util.function.BooleanSupplier;
import net.minecraft.server.level.ChunkHolder;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.util.thread.BlockableEventLoop;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.ImposterProtoChunk;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (SS) A flushed save (saveAllChunks(true)) waits, per chunk accessible since the last save, until the chunk's pending futures are done
 * (its load, its generation, its promotion to FULL), running server tasks meanwhile. Saves made while chunks were loading spent most of
 * their time there (jr-crash: 580 ms in the chunks part with 70 chunks saved). The wait is kept for a chunk with unsaved changes (a
 * LevelChunk, or the LevelChunk an ImposterProtoChunk wraps, unsaved): every change Architect or a player made to the world is in such a
 * chunk, and that chunk is still waited for and saved exactly as before, before the ledger. Skipped only for a chunk with nothing unsaved
 * (its save is a no-op) or one still loading or generating (a ProtoChunk: what it will hold came from the disk or the generator, never a
 * change the ledger describes). Server thread.
 */
@Mixin(ChunkMap.class)
public abstract class ChunkSaveWaitMixin {
	@Unique
	private static ChunkHolder architect$holder;

	@Inject(method = "lambda$saveAllChunks$0", at = @At("HEAD"))
	private void architect$holder(ChunkHolder holder, CallbackInfoReturnable<ChunkAccess> cir) {
		architect$holder = holder;
	}

	@Redirect(method = "lambda$saveAllChunks$0",
		at = @At(value = "INVOKE", target = "Lnet/minecraft/util/thread/BlockableEventLoop;managedBlock(Ljava/util/function/BooleanSupplier;)V"))
	private void architect$wait(BlockableEventLoop<?> loop, BooleanSupplier ready) {
		ChunkHolder h = architect$holder;
		architect$holder = null;
		if (!SaveTiming.waitAll && !ready.getAsBoolean() && h != null && !architect$hasChanges(h.getLatestChunk())) {
			SaveTiming.waitSkipped();
			return;
		}
		SaveTiming.at(SaveTiming.WAIT);
		loop.managedBlock(ready);
		SaveTiming.at(SaveTiming.CHUNKS);
	}

	/** A chunk whose save would write a change made in the world: a LevelChunk (or the one an imposter wraps) marked unsaved. */
	@Unique
	private static boolean architect$hasChanges(ChunkAccess c) {
		if (c instanceof LevelChunk lc) {
			return lc.isUnsaved();
		}
		if (c instanceof ImposterProtoChunk ip) {
			return ip.getWrapped().isUnsaved();
		}
		return false;
	}
}
