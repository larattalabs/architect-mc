package dev.larattalabs.architect.region;

import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.List;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

/**
 * UMT's door into the region fluids' removal drain (test code; docs/UMT.md): one fluid body built from its cells and their before
 * states, drained by the production {@link RegionFluids#drain} through its {@code DrainTarget} seam.
 */
public final class UmtDrain {
	private UmtDrain() {
	}

	/** Where the drain reads and writes (the UMT world). */
	public interface Cells {
		BlockState get(BlockPos p);

		void set(BlockPos p, BlockState s, int flags);
	}

	/** The before states a body's write captured ({@code RegionFluids.stateString}, as the stage saves them). */
	public static String stateString(BlockState s) {
		return RegionFluids.stateString(s);
	}

	/**
	 * Drains a water body: {@code cells} its sources with their {@code before} states (as the stage captured them before writing),
	 * {@code watch} its watched cells with theirs, {@code predicted} its predicted flow. As {@code removalGate} does (strays on).
	 * Returns the cells written. Nothing held (no journal holders asked).
	 */
	public static int drain(Cells w, long[] cells, String[] before, long[] watch, String[] watchBefore, long[] predicted) {
		return drain(w, cells, before, watch, watchBefore, predicted, null, null);
	}

	/**
	 * {@link #drain(Cells, long[], String[], long[], String[], long[])} as the region's removal drains: with {@code group}, the cells
	 * another journal entry holds on top are left to their holder (the production {@code RegionFluids.Holders} over the installed
	 * journal, fix/drain-holders); without it, nothing is held.
	 */
	public static int drain(Cells w, long[] cells, String[] before, long[] watch, String[] watchBefore, long[] predicted, String dim, String group) {
		RegionFluids.Body b = new RegionFluids.Body();
		b.id = "umt";
		b.cells = cells;
		b.watch = watch;
		for (long p : predicted) {
			b.predicted.put(p, 1);
		}
		RegionFluids.Regional st = new RegionFluids.Regional(List.of(b));
		RegionFluids.BodyState bs = st.states.get(b.id);
		bs.state = "settled";
		for (int i = 0; i < cells.length; i++) {
			bs.before.put(cells[i], before[i]);
		}
		for (int i = 0; i < watch.length; i++) {
			bs.before.put(watch[i], watchBefore[i]);
		}
		java.util.function.LongPredicate held = group == null ? RegionFluids.NOT_HELD : new RegionFluids.Holders(dim, group, st);
		Function<BlockPos, BlockState> get = w::get;
		return RegionFluids.drain(new RegionFluids.DrainTarget() {
			@Override
			public BlockState get(BlockPos p) {
				return get.apply(p);
			}

			@Override
			public void set(BlockPos p, BlockState s, int flags) {
				w.set(p, s, flags);
			}
		}, null, st, b, bs, true, new LongOpenHashSet(), held, group != null); // (6c F3-c) as the removal when it holds
	}
}
