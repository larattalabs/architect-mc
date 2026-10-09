package dev.larattalabs.architect.region;

import java.util.Collection;
import java.util.function.LongFunction;
import org.jspecify.annotations.Nullable;

/** The pure rules behind GENERATED_ONLY and the queue-time CHUNK_BOUND (phase 6a), testable without a world. */
public final class TicketGate {
	/** Every chunk generated: ticket them. */
	public static final long OK = Long.MIN_VALUE;
	/** A status is still being read: try again next tick. */
	public static final long UNKNOWN = Long.MAX_VALUE;

	private TicketGate() {
	}

	/** {@link #OK}, {@link #UNKNOWN}, or the first chunk that was never generated (the item waits NOT_GENERATED). */
	public static long check(Collection<Long> want, LongFunction<ChunkGen.State> state) {
		boolean unknown = false;
		for (long c : want) {
			ChunkGen.State st = state.apply(c);
			if (st == ChunkGen.State.NOT_GENERATED) {
				return c;
			}
			unknown |= st == ChunkGen.State.UNKNOWN;
		}
		return unknown ? UNKNOWN : OK;
	}

	/** Under a ticket-holding bound, an item needing more chunks than the bound can never get them: the CHUNK_BOUND message. */
	public static @Nullable String chunkBound(int need, int bound) {
		return bound > 0 && need > bound ? "needs " + need + " chunks, the bound is " + bound : null;
	}
}
