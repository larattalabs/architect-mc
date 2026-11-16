package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;

/** (DR) One cell of a finding: its position, the owner's committed value, what the world holds (block state strings). Since 1.65.0. */
public record CellDiff(BlockPos pos, String expected, String found) {
}
