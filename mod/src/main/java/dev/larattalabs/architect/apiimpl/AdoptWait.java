package dev.larattalabs.architect.apiimpl;

import dev.larattalabs.architect.api.ArchitectApi;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * (CH) A keyed request the helper answered with {@code adopted: true} names a design that may have ended long ago: in another world (the
 * helper's designs span the worlds) or before the last 20 a snapshot carries. The helper sends that design's record again before the ack
 * ({@code DesignBook.announce}), but the record reaches the API's reader on the client thread, after the ack. So the request's future
 * completes only once {@code Designs.get(id)} finds the design, or fails {@code TIMED_OUT} after {@link #BOUND_MS}: a caller waiting on the
 * design never waits for a record that is not coming. A new (not adopted) design completes at once. Internal.
 */
public final class AdoptWait {
	/** How long an adopted design's record may take to reach the reader. */
	public static final long BOUND_MS = Long.getLong("architect.api.adoptWaitMs", 30_000L);
	static final long STEP_MS = 100;
	private static volatile ScheduledExecutorService ex;

	private AdoptWait() {
	}

	/**
	 * {@code designId} once the API's reader has it (at once when it is not {@code adopted}, or the reader has it already); after {@link
	 * #BOUND_MS} without it, failed with {@code timeout}'s exception.
	 */
	public static CompletableFuture<String> record(String designId, boolean adopted, Supplier<? extends Throwable> timeout) {
		if (!adopted) {
			return CompletableFuture.completedFuture(designId);
		}
		return until(() -> ArchitectApi.get().designs().get(designId).isPresent(), BOUND_MS, STEP_MS, executor(), timeout).thenApply(x -> designId);
	}

	/**
	 * Completes (null) once {@code probe} is true, checked now and every {@code stepMs}; fails with {@code timeout}'s exception when it is
	 * still false after {@code boundMs}. A probe that throws counts as false. Never left pending.
	 */
	static CompletableFuture<Void> until(BooleanSupplier probe, long boundMs, long stepMs, ScheduledExecutorService ex, Supplier<? extends Throwable> timeout) {
		CompletableFuture<Void> out = new CompletableFuture<>();
		if (test(probe)) {
			out.complete(null);
			return out;
		}
		long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(boundMs);
		ScheduledFuture<?>[] task = new ScheduledFuture<?>[1];
		task[0] = ex.scheduleWithFixedDelay(() -> {
			if (out.isDone()) {
				return;
			}
			if (test(probe)) {
				out.complete(null);
			} else if (System.nanoTime() - deadline >= 0) {
				out.completeExceptionally(timeout.get());
			}
		}, stepMs, stepMs, TimeUnit.MILLISECONDS);
		out.whenComplete((v, e) -> task[0].cancel(false));
		return out;
	}

	private static boolean test(BooleanSupplier probe) {
		try {
			return probe.getAsBoolean();
		} catch (RuntimeException e) {
			return false;
		}
	}

	private static ScheduledExecutorService executor() {
		ScheduledExecutorService e = ex;
		if (e == null) {
			synchronized (AdoptWait.class) {
				if (ex == null) {
					ex = Executors.newSingleThreadScheduledExecutor(r -> {
						Thread t = new Thread(r, "architect adopted-design wait");
						t.setDaemon(true);
						return t;
					});
				}
				e = ex;
			}
		}
		return e;
	}
}
