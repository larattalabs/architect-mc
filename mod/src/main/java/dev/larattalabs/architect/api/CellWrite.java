package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/** One cell of a cell site ({@link CellsRequest}): the state to write there and its block entity data, if any. Since 1.5.0. */
public record CellWrite(BlockPos pos, BlockState state, @Nullable CompoundTag nbt) {
	public CellWrite {
		pos = pos.immutable();
	}

	public static CellWrite of(BlockPos pos, BlockState state) {
		return new CellWrite(pos, state, null);
	}
}
