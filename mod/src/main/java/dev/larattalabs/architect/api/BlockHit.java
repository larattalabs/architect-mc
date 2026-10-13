package dev.larattalabs.architect.api;

import net.minecraft.core.BlockPos;

/** One blocking cell of a build: its position and block id. Since PT. */
public record BlockHit(BlockPos pos, String blockId) {
}
