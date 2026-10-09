package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;

/**
 * One cell of a cell site ({@link CellsRequest}): the state to write there and its block entity data, if any. Since 1.5.0.
 *
 * @param cond (1.8.0) when the cell may be written, resolved against the world at placement (a cell whose condition fails is
 *             skipped and noted, never forced); null = the request's {@code naturalOnly} meaning, as before
 */
public record CellWrite(BlockPos pos, BlockState state, @Nullable CompoundTag nbt, @Nullable Cond cond) {
	/**
	 * Write conditions (since 1.8.0; CONTRACT phase 6 "Evaluation and conflicts"): {@code IF_NATURAL} natural terrain, plants,
	 * trees, air or water; {@code IF_SOLID_NATURAL} solid natural terrain; {@code IF_AIR_OR_FLUID} air, water or lava (not a
	 * waterlogged block); {@code ALWAYS_OURS} a cell an entry of the same owner owns, or anything IF_NATURAL allows. None ever
	 * writes over a block entity. New values are only ever appended.
	 */
	public enum Cond { IF_NATURAL, IF_SOLID_NATURAL, IF_AIR_OR_FLUID, ALWAYS_OURS }

	public CellWrite {
		pos = pos.immutable();
	}

	/** The 1.5.0 constructor (no condition). */
	public CellWrite(BlockPos pos, BlockState state, @Nullable CompoundTag nbt) {
		this(pos, state, nbt, null);
	}

	public static CellWrite of(BlockPos pos, BlockState state) {
		return new CellWrite(pos, state, null, null);
	}
}
