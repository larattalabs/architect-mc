package dev.larattalabs.architect.apiimpl;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.api.ArchitectRefused;
import dev.larattalabs.architect.api.Reason;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/** (CH) The bounded wait for an adopted design's record: it completes once the record is there, or fails TIMED_OUT; it never hangs. */
@Timeout(value = 10, unit = TimeUnit.SECONDS)
class AdoptWaitTest {
	private final ScheduledExecutorService ex = Executors.newSingleThreadScheduledExecutor();

	@AfterEach
	void stop() {
		ex.shutdownNow();
	}

	private static ArchitectRefused timedOut() {
		return new ArchitectRefused(Reason.TIMED_OUT, "never arrived");
	}

	@Test
	void aRecordAlreadyThereCompletesAtOnce() {
		CompletableFuture<Void> f = AdoptWait.until(() -> true, 1_000, 10, ex, AdoptWaitTest::timedOut);
		assertTrue(f.isDone() && !f.isCompletedExceptionally());
	}

	@Test
	void aRecordArrivingLaterCompletesTheWait() throws Exception {
		AtomicInteger calls = new AtomicInteger();
		CompletableFuture<Void> f = AdoptWait.until(() -> calls.incrementAndGet() >= 4, 5_000, 10, ex, AdoptWaitTest::timedOut);
		f.get(5, TimeUnit.SECONDS);
		assertEquals(4, calls.get());
	}

	@Test
	void aRecordThatNeverArrivesFailsTimedOutWithinTheBound() {
		long t0 = System.nanoTime();
		CompletableFuture<Void> f = AdoptWait.until(() -> false, 200, 10, ex, AdoptWaitTest::timedOut);
		ExecutionException e = assertThrows(ExecutionException.class, () -> f.get(5, TimeUnit.SECONDS));
		long ms = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - t0);
		ArchitectRefused r = assertInstanceOf(ArchitectRefused.class, e.getCause());
		assertSame(Reason.TIMED_OUT, r.reason());
		assertTrue(ms >= 200 && ms < 2_000, "failed after " + ms + " ms");
	}

	@Test
	void aProbeThatThrowsCountsAsNotYet() throws Exception {
		AtomicInteger calls = new AtomicInteger();
		CompletableFuture<Void> f = AdoptWait.until(() -> {
			if (calls.incrementAndGet() < 3) {
				throw new IllegalStateException("the reader is not ready");
			}
			return true;
		}, 5_000, 10, ex, AdoptWaitTest::timedOut);
		f.get(5, TimeUnit.SECONDS);
		assertEquals(3, calls.get());
	}

	@Test
	void aNewDesignIsNotWaitedFor() throws Exception {
		// not adopted: done at once, without reading the API (no world, no helper in a unit test)
		assertEquals("d7", AdoptWait.record("d7", false, AdoptWaitTest::timedOut).get(1, TimeUnit.SECONDS));
	}
}
