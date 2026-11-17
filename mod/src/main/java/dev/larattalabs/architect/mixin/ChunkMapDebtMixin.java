package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import dev.larattalabs.architect.Architect;
import dev.larattalabs.architect.site.ChunkDebt;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ChunkHolder;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.storage.SerializableChunkData;
import org.jspecify.annotations.Nullable;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T0, TXN review 3 item 5, T0 review 2 finding 7) {@code ChunkMap.save} marks a chunk saved ({@code tryMarkSaved}) before it serializes
 * it, so a failed serialization leaves it clean and no later save rewrites it. Here:
 * <ul>
 * <li>a failure (the synchronous copy, or the write future's) is owed with a re-mark ({@link ChunkDebt#remark}) that runs at the next
 * barrier, not at once (a flushed save would loop on a chunk that keeps failing): the loaded chunk is marked unsaved, or, once it unloaded,
 * the chunk object kept from the synchronous failure is serialized again and written;</li>
 * <li>a reload of an owed chunk whose kept object exists is served that object's state (T0 review 3 finding 8: never the older file);</li>
 * <li>the unload of an owed chunk marks it unsaved first, so the unload's own save rewrites it instead of dropping it clean (in 26.3 the
 * holder has left the maps by then, so the chunk can't be kept loaded; this is the save that pinning would have waited for).</li>
 * </ul>
 */
@Mixin(ChunkMap.class)
public abstract class ChunkMapDebtMixin {
	@Shadow
	@Final
	ServerLevel level;

	@Shadow
	protected abstract ChunkHolder getVisibleChunkIfPresent(long pos);

	@Unique
	private void architect$owe(ChunkPos pos, @Nullable ChunkAccess kept, String why, boolean newAttempt) {
		ChunkMap self = (ChunkMap) (Object) this;
		String key = ChunkDebt.key(self.storageInfo(), pos);
		ChunkDebt.remark(key, () -> {
			ChunkHolder h = getVisibleChunkIfPresent(pos.pack());
			ChunkAccess c = h == null ? null : h.getLatestChunk();
			if (c != null) {
				c.markUnsaved();
			} else if (kept != null) {
				try {
					CompoundTag tag = SerializableChunkData.copyOf(level, kept).write();
					self.write(pos, () -> tag);
				} catch (RuntimeException e) {
					Architect.LOGGER.error("Chunk durability: {} (unloaded) could not be serialized again", key, e);
				}
			}
		}, kept == null ? null : () -> SerializableChunkData.copyOf(level, kept).write(), why, newAttempt);
	}

	@Inject(method = "save(Lnet/minecraft/world/level/chunk/ChunkAccess;)Z", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/server/MinecraftServer;reportChunkSaveFailure(Ljava/lang/Throwable;Lnet/minecraft/world/level/chunk/storage/RegionStorageInfo;Lnet/minecraft/world/level/ChunkPos;)V"),
		require = 1)
	private void architect$serializeFailed(ChunkAccess chunk, CallbackInfoReturnable<Boolean> cir) {
		architect$owe(chunk.getPos(), chunk, "its serialization failed", true);
	}

	@Inject(method = "lambda$save$0", at = @At("HEAD"), require = 1)
	private void architect$writeFailed(ChunkPos pos, Void v, Throwable t, CallbackInfoReturnable<Object> cir) {
		if (t != null) {
			architect$owe(pos, null, "its save failed: " + t, false);
		}
	}

	@WrapOperation(method = "lambda$scheduleUnload$0", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/server/level/ChunkMap;save(Lnet/minecraft/world/level/chunk/ChunkAccess;)Z"), require = 1)
	private boolean architect$unloadSave(ChunkMap map, ChunkAccess chunk, Operation<Boolean> original) {
		if (ChunkDebt.owes(ChunkDebt.key(map.storageInfo(), chunk.getPos()))) {
			chunk.markUnsaved(); // an owed chunk is rewritten by its unload save, never dropped clean
		}
		return original.call(map, chunk);
	}
}
