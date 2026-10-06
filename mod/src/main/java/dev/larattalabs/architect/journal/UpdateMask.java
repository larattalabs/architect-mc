package dev.larattalabs.architect.journal;

import java.util.function.LongPredicate;
import net.minecraft.core.BlockPos;
import org.jspecify.annotations.Nullable;

/**
 * Updates at holes (docs/CONTRACT.md "Phase 4e contract", "Remove", "Updates at holes"): while a restore with holes writes,
 * no shape update and no neighbour update is delivered into a covered position (a cell of a site that stays on top), and the
 * block and fluid ticks scheduled there are dropped. The writer sets the mask around its own writes on the server thread;
 * the mixins ({@code BlockStateUpdateMixin}, {@code LevelTicksMixin}) consult it. With no mask set they are exact no-ops,
 * so a restore without holes is unchanged from 4d.
 */
public final class UpdateMask {
	private static @Nullable LongPredicate active;
	private static @Nullable Thread owner;

	private UpdateMask() {
	}

	/** Masks {@code covered} (packed positions) until {@link #end}; always paired in a finally. Server thread. */
	public static void begin(LongPredicate covered) {
		active = covered;
		owner = Thread.currentThread();
	}

	public static void end() {
		active = null;
		owner = null;
	}

	/** Whether an update into {@code pos} must not be delivered now. */
	public static boolean masked(BlockPos pos) {
		LongPredicate m = active;
		return m != null && Thread.currentThread() == owner && m.test(pos.asLong());
	}

	public static boolean masked(long pos) {
		LongPredicate m = active;
		return m != null && Thread.currentThread() == owner && m.test(pos);
	}
}
