package dev.larattalabs.architect.site;

import it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

/**
 * A restore's flowing fluid wakes up once the restore is complete (the relief falling-water fix, 2026-10-20). The undo writes a CELL
 * entry's cells with every side effect skipped ({@code Sites.CELL_FLAGS}), so flowing or falling water (or lava) it puts back holds
 * its journal state but has no fluid tick. When the region had filled a stream's feeder, vanilla drained the cells downstream that
 * the region never wrote (they are not in the journal); the restored feeder then never flows again and the stream stays broken
 * (relief_demo on S3: the falling column under a restored level-1 cell stayed air). Here every non-source fluid cell a restore
 * wrote gets one fluid tick, scheduled only when no removal and no restore job is still writing, so the whole undone geometry is
 * back first (a feeder ticking beside a cell the region still holds would spread sideways). Sources and waterlogged blocks are never
 * woken: worldgen leaves them unticked and they don't drain. Not saved: a stop between the restore and the tick loses the wake-up
 * (the stream stays as the restore wrote it, which is the journal's state).
 */
public final class FluidRearm {
	private static final Map<ResourceKey<Level>, LongLinkedOpenHashSet> PENDING = new LinkedHashMap<>();

	private FluidRearm() {
	}

	/** A restore wrote {@code state} at {@code pos}: a non-source fluid there is woken once the restores are done. Server thread. */
	static void wrote(ServerLevel level, long pos, BlockState state) {
		FluidState f = state.getFluidState();
		if (!f.isEmpty() && !f.isSource()) {
			PENDING.computeIfAbsent(level.dimension(), k -> new LongLinkedOpenHashSet()).add(pos);
		}
	}

	/** Cells waiting for their tick (DevBridge and tests). */
	public static int pending() {
		int n = 0;
		for (LongLinkedOpenHashSet s : PENDING.values()) {
			n += s.size();
		}
		return n;
	}

	/**
	 * Once per placement tick: with nothing restoring ({@code restoring} false), every pending cell that still holds a non-source fluid
	 * gets one fluid tick at its fluid's delay.
	 */
	static void tick(MinecraftServer server, boolean restoring) {
		if (PENDING.isEmpty() || restoring) {
			return;
		}
		BlockPos.MutableBlockPos m = new BlockPos.MutableBlockPos();
		for (var e : PENDING.entrySet()) {
			ServerLevel level = server.getLevel(e.getKey());
			if (level == null) {
				continue;
			}
			var it = e.getValue().iterator();
			while (it.hasNext()) {
				long p = it.nextLong();
				m.set(p);
				if (!level.isLoaded(m)) {
					continue;
				}
				FluidState f = level.getFluidState(m);
				if (!f.isEmpty() && !f.isSource()) {
					level.scheduleTick(m.immutable(), f.getType(), f.getType().getTickDelay(level));
				}
			}
		}
		PENDING.clear();
	}

	/** World stop: nothing carries over. */
	static void clear() {
		PENDING.clear();
	}
}
