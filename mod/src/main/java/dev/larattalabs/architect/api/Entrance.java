package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/** A build's entrance (§4): a door's lower half, a fence gate or a ground trapdoor; the apron is the 3 cells outside it. Since PT. */
public record Entrance(BlockPos pos, Direction facing, String blockId) {
}
