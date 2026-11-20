package dev.larattalabs.architect.mixin;

import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import dev.larattalabs.architect.site.ChunkDebt;
import java.io.IOException;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.function.Supplier;
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
 * (slice T0, review P1-3; TXN review 3 item 5; T0 review 2 finding 3) A region write's outcome, in submission order ({@link ChunkDebt}).
 * {@code IOWorker} polls a pending write out of its map before {@code runStore} runs it, so a failed write leaves nothing pending: here every
 * submission is numbered ({@code store}: the supplier wrapped in {@link ChunkDebt.Seqd}), the pending data carries its number
 * ({@code lambda$store$1}: later submissions replace the data), a failed write is owed with its snapshot and number, a write pays only a debt
 * no newer than its data, and a load of an owed chunk is served the snapshot when nothing newer was submitted. Every storage (chunks,
 * entities, POI) has its own worker.
 */
@Mixin(IOWorker.class)
public abstract class IOWorkerDebtMixin {
	@WrapMethod(method = "store(Lnet/minecraft/world/level/ChunkPos;Ljava/util/function/Supplier;)Ljava/util/concurrent/CompletableFuture;")
	private CompletableFuture<Void> architect$number(ChunkPos pos, Supplier<CompoundTag> data, Operation<CompletableFuture<Void>> original) {
		String key = ChunkDebt.key(((IOWorker) (Object) this).storageInfo(), pos);
		long seq = ChunkDebt.submitted(key, data instanceof ChunkDebt.Seqd<?> s ? s.seq : 0);
		return original.call(pos, data instanceof ChunkDebt.Seqd<?> ? data : new ChunkDebt.Seqd<>(key, seq, data));
	}

	@Inject(method = "lambda$store$1", at = @At("RETURN"), require = 1)
	private void architect$pending(Supplier<CompoundTag> data, ChunkPos pos, CallbackInfoReturnable<CompletableFuture<Void>> cir) {
		if (data instanceof ChunkDebt.Seqd<?> s) {
			ChunkDebt.pendingData(s.key, s.seq);
		}
	}

	@Redirect(method = "runStore", at = @At(value = "INVOKE",
		target = "Lnet/minecraft/world/level/chunk/storage/RegionFileStorage;write(Lnet/minecraft/world/level/ChunkPos;Lnet/minecraft/nbt/CompoundTag;)V"),
		require = 1)
	private void architect$write(RegionFileStorage storage, ChunkPos pos, CompoundTag tag) throws IOException {
		IOWorker self = (IOWorker) (Object) this;
		String key = ChunkDebt.key(self.storageInfo(), pos);
		long seq = ChunkDebt.writing(key);
		if (ChunkDebt.testDropped(key)) {
			dev.larattalabs.architect.Architect.LOGGER.warn("(slice T5Fa TEST) dev.chunk.drop: the write of {} skipped (its snapshot lost)", key);
			ChunkDebt.written(key, seq); // acknowledged as written (a barrier waiting on it goes on), the region file untouched
			return; // TEST only (ChunkDebt.TEST_DROP is empty unless a dev hook armed it)
		}
		try {
			if (ChunkDebt.failNext()) {
				throw new IOException("(slice T0 TEST) a chunk write refused: " + key);
			}
			storage.write(pos, tag);
		} catch (IOException | RuntimeException e) {
			CompoundTag keep = tag == null ? null : tag.copy();
			ChunkDebt.writeFailed(key, keep, seq,
				() -> self.store(pos, new ChunkDebt.Seqd<>(key, seq, () -> keep == null ? null : keep.copy())), e.toString());
			throw e;
		}
		ChunkDebt.written(key, seq);
	}

	@Inject(method = "lambda$loadAsync$0", at = @At("HEAD"), cancellable = true, require = 1)
	private void architect$load(ChunkPos pos, CallbackInfoReturnable<Optional<CompoundTag>> cir) {
		Object kept = ChunkDebt.snapshot(ChunkDebt.key(((IOWorker) (Object) this).storageInfo(), pos));
		if (kept instanceof CompoundTag t) {
			cir.setReturnValue(Optional.of(t.copy()));
		}
	}
}
