package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

/** A cell of a delta set the player changed: where, what is there, what the new version would write there. Since 1.7.0. */
public record KeptCell(BlockPos pos, BlockState found, BlockState planned) {
}
