package dev.larattalabs.architect.site;

import dev.larattalabs.architect.api.VoxelClass;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.region.volume.VoxelTable;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * {@code Reason.PLAYER_BLOCKS} (docs/CONTRACT.md phase 6b §7.3 case (a), API 1.9.0), scoped narrowly: only a LAYER placement
 * whose overlap hits include a region tile entry ({@code architect:terrain} / {@code architect:path}), i.e. a lot on a region's
 * pad, and only without {@code force}. Such a placement refuses when a cell of its snapshot box holds the player's own block:
 * non-natural ({@link VoxelClass#PLAYER} per the kit's {@code voxel_classes.json}), no block entity (those refuse
 * BLOCK_ENTITIES already), owned by no journal entry. 0.11.0 overwrote such a block (and gave it back on remove); now the lot is
 * not placed, the block stays and the region ends PARTIAL. Every other LAYER caller is unchanged. Server thread.
 */
public final class PlayerBlocks {
	/** At most this many positions are named in the message. */
	static final int NAMED = 4;

	private PlayerBlocks() {
	}

	/** Whether the check applies: LAYER, no force, and a region tile entry among the hits. Pure. */
	public static boolean scoped(boolean layer, boolean force, List<String> hitKinds) {
		return layer && !force && hitKinds.stream().anyMatch(RegionKinds::tile);
	}

	/** Whether one cell is the player's block. Pure. */
	public static boolean playerBlock(VoxelClass cls, boolean blockEntity, boolean owned) {
		return cls == VoxelClass.PLAYER && !blockEntity && !owned;
	}

	/** The refusal message, or null for no cells. Pure. */
	public static String message(List<BlockPos> found, int total) {
		List<String> named = new ArrayList<>();
		for (int i = 0; i < Math.min(NAMED, found.size()); i++) {
			named.add(found.get(i).toShortString());
		}
		return "The player's own blocks inside a lot: " + total + " block" + (total == 1 ? "" : "s") + " (" + String.join("; ", named) + (total > NAMED
			? "; ..." : "") + "); the lot is not placed and they stay (force overwrites them; they come back on remove)";
	}

	/** The player's blocks in {@code box} (all of them counted, the first {@link #NAMED} kept), ownership checked only for candidates. */
	static Found scan(ServerLevel level, Anchors.Bounds box) {
		VoxelTable table = VoxelTable.get();
		String dim = Sites.dimensionId(level);
		IdentityHashMap<BlockState, Boolean> memo = new IdentityHashMap<>();
		BlockPos.MutableBlockPos mp = new BlockPos.MutableBlockPos();
		List<BlockPos> first = new ArrayList<>();
		int total = 0;
		for (int cx = box.minX() >> 4; cx <= box.maxX() >> 4; cx++) {
			for (int cz = box.minZ() >> 4; cz <= box.maxZ() >> 4; cz++) {
				LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
				if (c == null) {
					continue; // checkSite refuses NOT_LOADED for an unloaded box already
				}
				int x0 = Math.max(box.minX(), cx << 4);
				int x1 = Math.min(box.maxX(), (cx << 4) + 15);
				int z0 = Math.max(box.minZ(), cz << 4);
				int z1 = Math.min(box.maxZ(), (cz << 4) + 15);
				int y0 = Math.max(box.minY(), level.getMinY());
				int y1 = Math.min(box.maxY(), level.getMaxY());
				for (int x = x0; x <= x1; x++) {
					for (int z = z0; z <= z1; z++) {
						for (int y = y0; y <= y1; y++) {
							BlockState s = c.getBlockState(mp.set(x, y, z));
							Boolean cand = memo.get(s);
							if (cand == null) {
								cand = !s.isAir() && playerBlock(table.of(s.getBlock()), s.hasBlockEntity(), false);
								memo.put(s, cand);
							}
							if (cand && !SiteJournal.owned(dim, BlockPos.asLong(x, y, z))) {
								total++;
								if (first.size() < NAMED) {
									first.add(new BlockPos(x, y, z));
								}
							}
						}
					}
				}
			}
		}
		return new Found(first, total);
	}

	record Found(List<BlockPos> first, int total) {
	}
}
