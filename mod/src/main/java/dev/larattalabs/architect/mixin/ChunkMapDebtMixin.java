package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.ChunkDebt;
import net.minecraft.server.level.ChunkHolder;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.ChunkAccess;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T0, TXN review 3 item 5) {@code ChunkMap.save} marks a chunk saved ({@code tryMarkSaved}) before it serializes it, so a failed
 * serialization leaves it clean and no later save rewrites it. Here such a failure (the synchronous copy, or the write future's failure)
 * leaves the chunk to be marked unsaved again at the next barrier ({@link ChunkDebt#remark}: not at once, so a flushed save never loops on a
 * chunk that keeps failing).
 */
@Mixin(ChunkMap.class)
public abstract class ChunkMapDebtMixin {
	@Shadow
	@Final
	ServerLevel level;

	@Shadow
	protected abstract ChunkHolder getVisibleChunkIfPresent(long pos);

	@Unique
	private void architect$owe(ChunkPos pos, String why) {
		ChunkMap self = (ChunkMap) (Object) this;
		ChunkDebt.remark(ChunkDebt.key(self.storageInfo(), pos), () -> {
			ChunkHolder h = getVisibleChunkIfPresent(pos.pack());
			ChunkAccess c = h == null ? null : h.getLatestChunk();
			if (c != null) {
				c.markUnsaved();
			}
		}, why);
	}

	@Inject(method = "save(Lnet/minecraft/world/level/chunk/ChunkAccess;)Z", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/server/MinecraftServer;reportChunkSaveFailure(Ljava/lang/Throwable;Lnet/minecraft/world/level/chunk/storage/RegionStorageInfo;Lnet/minecraft/world/level/ChunkPos;)V"),
		require = 1)
	private void architect$serializeFailed(ChunkAccess chunk, CallbackInfoReturnable<Boolean> cir) {
		architect$owe(chunk.getPos(), "its serialization failed");
	}

	@Inject(method = "lambda$save$0", at = @At("HEAD"), require = 1)
	private void architect$writeFailed(ChunkPos pos, Void v, Throwable t, CallbackInfoReturnable<Object> cir) {
		if (t != null) {
			architect$owe(pos, "its save failed: " + t);
		}
	}
}
