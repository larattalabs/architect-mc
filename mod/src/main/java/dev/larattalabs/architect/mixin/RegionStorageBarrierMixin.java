package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.RegionDurability;
import it.unimi.dsi.fastutil.longs.Long2ObjectLinkedOpenHashMap;
import java.io.IOException;
import java.util.Optional;
import net.minecraft.world.level.chunk.storage.RegionFile;
import net.minecraft.world.level.chunk.storage.RegionFileStorage;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * (SS) The device barrier: when a storage's flush ends and no force has returned in this world save yet (every file was known clean), one
 * of its open files is forced anyway. On macOS that force is F_FULLFSYNC, which flushes the drive's cache too, as vanilla's flushed save
 * did for the player files written just before it. One force per world save instead of one per open file. IO worker thread.
 */
@Mixin(RegionFileStorage.class)
public abstract class RegionStorageBarrierMixin {
	@Shadow
	@Final
	private Long2ObjectLinkedOpenHashMap<Optional<RegionFile>> regionCache;

	@Inject(method = "flush", at = @At("RETURN"))
	private void architect$barrier(CallbackInfo ci) throws IOException {
		if (!RegionDurability.barrierNeeded()) {
			return;
		}
		for (Optional<RegionFile> f : regionCache.values()) {
			if (f.isPresent()) {
				RegionFile rf = f.get();
				RegionDurability.barrier(rf::flush);
				return;
			}
		}
	}
}
