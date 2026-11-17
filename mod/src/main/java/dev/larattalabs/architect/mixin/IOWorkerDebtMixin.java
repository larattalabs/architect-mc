package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.ChunkDebt;
import java.io.IOException;
import java.util.Optional;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.storage.IOWorker;
import net.minecraft.world.level.chunk.storage.RegionFileStorage;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T0, review P1-3; TXN review 3 item 5) A region write's outcome ({@link ChunkDebt}). {@code IOWorker} polls a pending write out of its
 * map before {@code runStore} runs it, so a failed write leaves nothing pending: here it is owed with its snapshot and a resubmission
 * ({@code store} again, at the next barrier), a later successful write of the chunk pays it, and a load of an owed chunk is served the
 * snapshot instead of the older file. Every storage (chunks, entities, POI) has its own worker. IO thread.
 */
@Mixin(IOWorker.class)
public abstract class IOWorkerDebtMixin {
	@Redirect(method = "runStore", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/world/level/chunk/storage/RegionFileStorage;write(Lnet/minecraft/world/level/ChunkPos;Lnet/minecraft/nbt/CompoundTag;)V"),
		require = 1)
	private void architect$write(RegionFileStorage storage, ChunkPos pos, CompoundTag tag) throws IOException {
		IOWorker self = (IOWorker) (Object) this;
		String key = ChunkDebt.key(self.storageInfo(), pos);
		try {
			if (ChunkDebt.failNext()) {
				throw new IOException("(slice T0 TEST) a chunk write refused: " + key);
			}
			storage.write(pos, tag);
		} catch (IOException | RuntimeException e) {
			CompoundTag keep = tag == null ? null : tag.copy();
			ChunkDebt.writeFailed(key, keep, () -> self.store(pos, keep == null ? null : keep.copy()), e.toString());
			throw e;
		}
		ChunkDebt.written(key);
	}

	@Inject(method = "lambda$loadAsync$0", at = @At("HEAD"), cancellable = true, require = 1)
	private void architect$load(ChunkPos pos, CallbackInfoReturnable<Optional<CompoundTag>> cir) {
		Object kept = ChunkDebt.snapshot(ChunkDebt.key(((IOWorker) (Object) this).storageInfo(), pos));
		if (kept instanceof CompoundTag t) {
			cir.setReturnValue(Optional.of(t.copy()));
		}
	}
}
