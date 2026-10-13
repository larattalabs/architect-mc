package dev.larattalabs.architect.mixin;

import dev.larattalabs.architect.journal.ChangeTracker;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Change tracking for captures not written in one tick ({@link ChangeTracker}): every block change in a reserved section. */
@Mixin(LevelChunk.class)
public abstract class LevelChunkMixin {
	@Inject(method = "setBlockState", at = @At("RETURN"))
	private void architect$track(BlockPos pos, BlockState state, int flags, CallbackInfoReturnable<BlockState> cir) {
		if (cir.getReturnValue() != null) {
			ChangeTracker.changed(((LevelChunk) (Object) this).getLevel(), pos);
			dev.larattalabs.architect.journal.WriteCounter.changed(((LevelChunk) (Object) this).getLevel(), pos);
			// 6c PT: player-placed tracking records and clears here (one attachment lookup when the chunk has none)
			dev.larattalabs.architect.placed.Placed.changed((LevelChunk) (Object) this, pos, cir.getReturnValue(), state);
		}
	}
}
