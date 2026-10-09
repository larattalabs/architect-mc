package dev.larattalabs.architect.api;

/**
 * The class of one cell of a {@link Volume} (docs/CONTRACT.md phase 6b §5, kit/REGIONS.md "ARVX"). The ordinal is the byte in
 * the ARVX file and equals the kit's {@code voxel_classes.json} {@code classes} order (a test asserts it). Per cell:
 * {@link #MISSING} for a column that was not read; {@link #OWNED} for a cell a journal entry owns (the volume's side table
 * names the entry); {@link #BLOCK_ENTITY} for a block entity; else the block's class from {@code voxel_classes.json} (natural
 * blocks only; a block not listed is {@link #PLAYER}: non-natural and owned by no entry). New values are only ever appended.
 * Since 1.9.0.
 */
public enum VoxelClass {
	AIR, ROCK, SOIL, LOOSE, ICE, SNOW, WATER, LAVA, LOG, LEAVES, PLANT, OWNED, PLAYER, BLOCK_ENTITY, MISSING
}
