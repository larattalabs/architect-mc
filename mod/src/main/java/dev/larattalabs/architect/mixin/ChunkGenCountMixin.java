package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.region.GenCounter;
import java.util.concurrent.CompletableFuture;
import net.minecraft.server.level.GenerationChunkHolder;
import net.minecraft.util.StaticCache2D;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.status.ChunkStatusTasks;
import net.minecraft.world.level.chunk.status.ChunkStep;
import net.minecraft.world.level.chunk.status.WorldGenContext;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Phase 6a: counts chunks whose terrain is generated (the noise step, which only the generation pyramid runs; a chunk loaded
 * from disk never reaches it), including proto chunks at the edge of a load that never become FULL. The counter behind
 * "0 chunks generated during realise" ({@link GenCounter}). Worker threads.
 */
@Mixin(ChunkStatusTasks.class)
public abstract class ChunkGenCountMixin {
	@Inject(method = "buildTerrain", at = @At("HEAD"))
	private static void architect$terrain(WorldGenContext context, ChunkStep step, StaticCache2D<GenerationChunkHolder> chunks, ChunkAccess chunk,
		CallbackInfoReturnable<CompletableFuture<ChunkAccess>> cir) {
		GenCounter.terrain(context.level(), chunk.getPos().pack());
	}
}
