package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.site.RegionDurability;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.storage.RegionFile;
import net.minecraft.world.level.chunk.storage.RegionFileStorage;
import net.minecraft.world.level.chunk.storage.RegionStorageInfo;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * (slice T0, review P1-4) A new region file's entry forced: {@code RegionFileStorage.getRegionFile} creates the folder and the {@code .mca}
 * and never forces either entry, so a power loss could drop a whole new region the ledger counts. Here, after the file is made, its folder
 * is forced (and each folder just created, in its parent); a force that fails is owed ({@link RegionDurability#forceNew}). IO thread (one
 * per storage).
 */
@Mixin(RegionFileStorage.class)
public abstract class RegionCreateMixin {
	@Shadow
	@Final
	private Path folder;
	@Shadow
	@Final
	private RegionStorageInfo info;

	@Shadow
	private Path regionPath(ChunkPos pos) {
		throw new AssertionError();
	}

	@Unique
	private boolean architect$fileNew;
	@Unique
	private List<Path> architect$dirsNew = List.of();

	@Inject(method = "getRegionFile", at = @At(value = "INVOKE", target = "Lnet/minecraft/util/FileUtil;createDirectoriesSafe(Ljava/nio/file/Path;)V"),
		require = 1)
	private void architect$before(ChunkPos pos, boolean create, CallbackInfoReturnable<RegionFile> cir) {
		List<Path> dirs = new ArrayList<>();
		for (Path p = folder; p != null && !Files.isDirectory(p); p = p.getParent()) {
			dirs.add(p);
		}
		architect$dirsNew = dirs;
		architect$fileNew = !Files.exists(regionPath(pos));
	}

	@Inject(method = "getRegionFile", at = @At(value = "INVOKE", target = "Ljava/util/Optional;of(Ljava/lang/Object;)Ljava/util/Optional;"), require = 1)
	private void architect$made(ChunkPos pos, boolean create, CallbackInfoReturnable<RegionFile> cir) {
		if (architect$fileNew) {
			RegionDurability.forceNew(folder, info.type());
		}
		for (Path d : architect$dirsNew) {
			if (d.getParent() != null) {
				RegionDurability.forceNew(d.getParent(), info.type());
			}
		}
		architect$fileNew = false;
		architect$dirsNew = List.of();
	}
}
