package dev.larattalabs.architect.placement;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;

/**
 * Leaves just outside a site, kept from decaying while it stands. Placing a site clears logs inside its box; leaves
 * outside the box that hung on those logs then decay, and Remove (which restores only the box) cannot bring them back.
 * So placement makes those leaves persistent and records them with their original {@code distance}; Remove and Move give
 * them their original state back once the box (and its logs) is restored.
 *
 * <p>Which leaves: non-persistent leaves with {@code distance} below 7 (7 decays anyway) within {@link #RADIUS} of the
 * box whose Manhattan distance to the box is at most their {@code distance}. A leaf's {@code distance} is the length of
 * its shortest face path to a log; a path from a log inside the box is at least as long as the leaf's Manhattan distance
 * to the box, so any leaf further away does not depend on the box. Server thread.
 */
public final class LeafGuard {
	/** Leaves decay at distance 7, so nothing further than 6 from the box can depend on a log inside it. */
	public static final int RADIUS = 6;

	/**
	 * Hold and release never notify neighbours ({@link Block#UPDATE_KNOWN_SHAPE}): a shape update makes neighbouring leaves
	 * recompute their {@code distance}, and world generation leaves many of them stale (overlapping trees), so a recompute
	 * would change cells nobody recorded and Remove would not be exact.
	 */
	private static int quiet(int flags) {
		return flags | Block.UPDATE_KNOWN_SHAPE;
	}

	/** Manhattan distance from a cell to the box (0 inside). */
	public static int distanceTo(Anchors.Bounds box, int x, int y, int z) {
		return gap(x, box.minX(), box.maxX()) + gap(y, box.minY(), box.maxY()) + gap(z, box.minZ(), box.maxZ());
	}

	private static int gap(int v, int min, int max) {
		return v < min ? min - v : v > max ? v - max : 0;
	}

	/** Whether a non-persistent leaf with {@code distance} at Manhattan distance {@code fromBox} (> 0) may hang on the box. */
	public static boolean mayDependOnBox(int distance, int fromBox) {
		return fromBox > 0 && distance < 7 && fromBox <= distance;
	}

	/**
	 * Makes the leaves around {@code box} that may hang on it persistent (no neighbour updates) and returns them as world
	 * x, y, z, original distance quadruples. Call it before the box is changed: a leaf's {@code distance} is read as it was.
	 */
	public static List<Integer> hold(ServerLevel level, Anchors.Bounds box, int flags) {
		List<Integer> out = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int minY = Math.max(level.getMinY(), box.minY() - RADIUS);
		int maxY = Math.min(level.getMaxY(), box.maxY() + RADIUS);
		LeafSections ls = new LeafSections(level, box.minX() - RADIUS, minY, box.minZ() - RADIUS, box.maxX() + RADIUS, maxY, box.maxZ() + RADIUS);
		for (int y = minY; y <= maxY; y++) {
			for (int z = box.minZ() - RADIUS; z <= box.maxZ() + RADIUS; z++) {
				for (int x = box.minX() - RADIUS; x <= box.maxX() + RADIUS; x++) {
					if (!ls.may(x, y, z)) {
						continue;
					}
					int from = distanceTo(box, x, y, z);
					if (from == 0 || from > RADIUS) {
						continue;
					}
					BlockState s = level.getBlockState(p.set(x, y, z));
					if (!(s.getBlock() instanceof LeavesBlock) || s.getValue(LeavesBlock.PERSISTENT)) {
						continue;
					}
					int d = s.getValue(LeavesBlock.DISTANCE);
					if (!mayDependOnBox(d, from)) {
						continue;
					}
					level.setBlock(p, s.setValue(LeavesBlock.PERSISTENT, true), quiet(flags));
					out.add(x);
					out.add(y);
					out.add(z);
					out.add(d);
				}
			}
		}
		return out;
	}

	/**
	 * The leaves {@link #hold} would make persistent around {@code box}, without changing anything (phase 4e: they become a
	 * {@code leaves} journal entry before they are written), as x, y, z, distance quadruples. {@code skip}: cells another
	 * standing entry owns (guard cells never claim another site's cells).
	 */
	/**
	 * Which chunk sections of a box may hold leaves (their palette says so): the leaf scans skip the others (phase 4e: a size-cap
	 * box's ring is 400k cells, nearly all in sections without a leaf). An unloaded chunk counts as "may".
	 */
	static final class LeafSections {
		final int cx0;
		final int sy0;
		final int cz0;
		final int nx;
		final int ny;
		final int nz;
		final boolean[] may;

		LeafSections(ServerLevel level, int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
			cx0 = minX >> 4;
			sy0 = minY >> 4;
			cz0 = minZ >> 4;
			nx = (maxX >> 4) - cx0 + 1;
			ny = (maxY >> 4) - sy0 + 1;
			nz = (maxZ >> 4) - cz0 + 1;
			may = new boolean[nx * ny * nz];
			for (int i = 0; i < nx; i++) {
				for (int k = 0; k < nz; k++) {
					net.minecraft.world.level.chunk.LevelChunk ch = level.getChunkSource().getChunkNow(cx0 + i, cz0 + k);
					for (int j = 0; j < ny; j++) {
						boolean m = true;
						if (ch != null) {
							int idx = ch.getSectionIndexFromSectionY(sy0 + j);
							if (idx < 0 || idx >= ch.getSections().length) {
								m = false;
							} else {
								net.minecraft.world.level.chunk.LevelChunkSection sec = ch.getSection(idx);
								m = !sec.hasOnlyAir() && sec.maybeHas(st -> st.getBlock() instanceof LeavesBlock);
							}
						}
						may[(i * ny + j) * nz + k] = m;
					}
				}
			}
		}

		boolean may(int x, int y, int z) {
			return may[(((x >> 4) - cx0) * ny + ((y >> 4) - sy0)) * nz + ((z >> 4) - cz0)];
		}
	}

	public static List<Integer> holdable(ServerLevel level, Anchors.Bounds box, java.util.function.Predicate<BlockPos> skip) {
		List<Integer> out = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int minY = Math.max(level.getMinY(), box.minY() - RADIUS);
		int maxY = Math.min(level.getMaxY(), box.maxY() + RADIUS);
		for (int y = minY; y <= maxY; y++) {
			for (int z = box.minZ() - RADIUS; z <= box.maxZ() + RADIUS; z++) {
				for (int x = box.minX() - RADIUS; x <= box.maxX() + RADIUS; x++) {
					int from = distanceTo(box, x, y, z);
					if (from == 0 || from > RADIUS) {
						continue;
					}
					BlockState s = level.getBlockState(p.set(x, y, z));
					if (!(s.getBlock() instanceof LeavesBlock) || s.getValue(LeavesBlock.PERSISTENT)) {
						continue;
					}
					int d = s.getValue(LeavesBlock.DISTANCE);
					if (!mayDependOnBox(d, from) || skip.test(p)) {
						continue;
					}
					out.add(x);
					out.add(y);
					out.add(z);
					out.add(d);
				}
			}
		}
		return out;
	}

	/** Makes the {@link #holdable} cells persistent (no neighbour updates), where they still are natural leaves. */
	public static void holdCells(ServerLevel level, List<Integer> held, int flags) {
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int i = 0; i + 3 < held.size(); i += 4) {
			BlockState s = level.getBlockState(p.set(held.get(i), held.get(i + 1), held.get(i + 2)));
			if (s.getBlock() instanceof LeavesBlock && !s.getValue(LeavesBlock.PERSISTENT)) {
				level.setBlock(p, s.setValue(LeavesBlock.PERSISTENT, true), quiet(flags));
			}
		}
	}

	/**
	 * Gives held leaves back their original state: still leaves and still persistent (the player may have broken them or
	 * placed something else there, which stays as it is) -> not persistent, with the recorded distance. Returns how many.
	 */
	public static int release(ServerLevel level, List<Integer> held, int flags) {
		int n = 0;
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int i = 0; i + 3 < held.size(); i += 4) {
			BlockState s = level.getBlockState(p.set(held.get(i), held.get(i + 1), held.get(i + 2)));
			if (!(s.getBlock() instanceof LeavesBlock) || !s.getValue(LeavesBlock.PERSISTENT)) {
				continue;
			}
			level.setBlock(p, s.setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, held.get(i + 3)), quiet(flags));
			n++;
		}
		return n;
	}

	/** How far around a snapshot box the leaf ring reaches ({@link #ring}): past the box + 7 the gate hashes. */
	public static final int RING = RADIUS + 2;

	/**
	 * The leaf ring of a box (phase 4d): every leaf within {@link #RING} of {@code box} but outside it, as world x, y, z,
	 * distance quadruples, read before the box changes. Worldgen leaves often carry a distance larger than their nearest
	 * log gives (trees generated over each other); any shape update next to them lets the whole canopy relax to the true
	 * distances, which is not "the terrain as it was". Remove puts the recorded distances back ({@link #restoreRing}).
	 */
	public static int[] ring(ServerLevel level, Anchors.Bounds box) {
		List<Integer> out = new ArrayList<>();
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		int minY = Math.max(level.getMinY(), box.minY() - RING);
		int maxY = Math.min(level.getMaxY(), box.maxY() + RING);
		LeafSections ls = new LeafSections(level, box.minX() - RING, minY, box.minZ() - RING, box.maxX() + RING, maxY, box.maxZ() + RING);
		for (int y = minY; y <= maxY; y++) {
			for (int z = box.minZ() - RING; z <= box.maxZ() + RING; z++) {
				for (int x = box.minX() - RING; x <= box.maxX() + RING; x++) {
					if (!ls.may(x, y, z) || box.contains(x, y, z)) {
						continue;
					}
					BlockState s = level.getBlockState(p.set(x, y, z));
					if (s.getBlock() instanceof LeavesBlock) {
						out.add(x);
						out.add(y);
						out.add(z);
						out.add(s.getValue(LeavesBlock.DISTANCE));
					}
				}
			}
		}
		return out.stream().mapToInt(Integer::intValue).toArray();
	}

	/**
	 * Gives the ring's leaves their recorded distance back (no neighbour updates), where the cell still holds leaves and lies
	 * in none of {@code skip} (other standing sites' boxes). Returns how many changed.
	 */
	public static int restoreRing(ServerLevel level, int[] ring, java.util.function.Predicate<BlockPos> skip, int flags) {
		int n = 0;
		BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
		for (int i = 0; i + 3 < ring.length; i += 4) {
			BlockState s = level.getBlockState(p.set(ring[i], ring[i + 1], ring[i + 2]));
			if (!(s.getBlock() instanceof LeavesBlock) || s.getValue(LeavesBlock.DISTANCE) == ring[i + 3] || skip.test(p)) {
				continue;
			}
			level.setBlock(p, s.setValue(LeavesBlock.DISTANCE, ring[i + 3]), quiet(flags));
			n++;
		}
		return n;
	}

	private LeafGuard() {
	}
}
