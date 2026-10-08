package dev.larattalabs.architect.journal;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;

/**
 * A test hook (DevBridge {@code dev.writes.count}, phase 5b minimality): the positions whose block state changed since the last
 * read, per dimension. Off until the first read; one set, cleared by each read. Server thread.
 */
public final class WriteCounter {
	private static volatile boolean on;
	private static final LongOpenHashSet CHANGED = new LongOpenHashSet();
	private static String dim = "";

	private WriteCounter() {
	}

	/** Called by the chunk mixin for every changed block. */
	public static void changed(Level level, BlockPos pos) {
		if (!on || level.isClientSide()) {
			return;
		}
		synchronized (CHANGED) {
			String d = level.dimension().identifier().toString();
			if (!d.equals(dim)) {
				return;
			}
			CHANGED.add(pos.asLong());
		}
	}

	/** The positions changed in {@code box} (inclusive {minX..maxZ}) since the last call; starts counting in {@code dimension}. */
	public static long[] drain(String dimension, int[] box) {
		synchronized (CHANGED) {
			long[] out = CHANGED.longStream().filter(p -> {
				int x = BlockPos.getX(p);
				int y = BlockPos.getY(p);
				int z = BlockPos.getZ(p);
				return x >= box[0] && y >= box[1] && z >= box[2] && x <= box[3] && y <= box[4] && z <= box[5];
			}).toArray();
			CHANGED.clear();
			dim = dimension;
			on = true;
			return out;
		}
	}
}
