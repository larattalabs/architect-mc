package dev.larattalabs.architect.txn;

import com.google.gson.JsonObject;
import java.util.List;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1) What the core needs from the world: the store, the global barrier (§3.1: players, chunks, then the ledger; the awaits it
 * proved), await checks, kill points (§3.9), the event sink and the clock. The game's ({@code TxnServer}) and the model's
 * ({@code TxnCrashModel}) differ only here.
 */
public interface TxnEnv {
	TxnStore store();

	/** A barrier's answer: OK with the awaits it proved, or why not. */
	record Barrier(boolean ok, List<Await> awaits, @Nullable String reason) {
		public static Barrier ok(List<Await> awaits) {
			return new Barrier(true, List.copyOf(awaits), null);
		}

		public static Barrier refused(String why) {
			return new Barrier(false, List.of(), why);
		}
	}

	Barrier barrier();

	/** Whether a persisted await is met now (the same store id, its generation confirmed on disk). */
	boolean satisfied(Await a);

	/** A named step was reached: the armed kill point halts here (the model throws its crash). */
	void kill(String point);

	/**
	 * (slice T3b, TEST {@code dev.txn.pauseAt}) Whether a drive that reaches {@code point} stops there, its txn held open (its resources
	 * held) until the pause is cleared. Never in production; the model never pauses.
	 */
	default boolean pauseAt(String point) {
		return false;
	}

	/**
	 * Fires one event at least once (§3.12.9); {@code replayed} for one fired again by recovery. True once it is delivered (called again for
	 * the same event after a false, it answers whether that delivery happened, never firing twice in one session); false while it waits
	 * for a later tick.
	 */
	boolean emit(TxnEntry t, String event, JsonObject payload, boolean replayed);

	long tick();

	long wall();
}
