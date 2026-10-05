package dev.larattalabs.architect.apiimpl;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;
import org.jspecify.annotations.Nullable;

/**
 * Futures waiting for a sidecar job by id (a variant, a design) with a deadline. Pure bookkeeping, no threads of its own: the
 * caller drives {@link #expire} with its clock. Thread-safe.
 *
 * <ul>
 *   <li>{@link #await}: register a future under the id the ack gave; if the outcome already arrived (the job finished before
 *   the ack was processed), it completes at once.</li>
 *   <li>{@link #complete} / {@link #fail}: the job finished; a future not registered yet keeps the outcome for a while
 *   ({@code earlyKeepMs}) so a late {@link #await} still gets it.</li>
 *   <li>{@link #expire}: futures past their deadline fail with a {@link TimeoutException}; early outcomes nobody claimed are
 *   forgotten.</li>
 *   <li>{@link #failAll}: the link dropped.</li>
 * </ul>
 * Futures complete outside the lock, on the caller's thread. Internal.
 */
public final class PendingFutures<V> {
	private record Waiting<V>(CompletableFuture<V> future, long deadline) {
	}

	private record Early<V>(@Nullable V value, @Nullable Throwable error, long until) {
	}

	private final String what;
	private final long earlyKeepMs;
	private final Map<String, Waiting<V>> waiting = new LinkedHashMap<>();
	private final Map<String, Early<V>> early = new LinkedHashMap<>();

	/** {@code what}: names the job kind in timeout messages ("variant"). */
	public PendingFutures(String what, long earlyKeepMs) {
		this.what = what;
		this.earlyKeepMs = earlyKeepMs;
	}

	/** Waits for {@code id} until {@code now + timeoutMs}. Returns {@code f}. */
	public CompletableFuture<V> await(String id, CompletableFuture<V> f, long now, long timeoutMs) {
		Early<V> e;
		synchronized (this) {
			e = early.remove(id);
			if (e == null) {
				waiting.put(id, new Waiting<>(f, now + timeoutMs));
			}
		}
		if (e != null) {
			settle(f, e.value(), e.error());
		}
		return f;
	}

	/** The job finished well: completes its future, or keeps the value for a late {@link #await}. */
	public void complete(String id, V value, long now) {
		finish(id, value, null, now);
	}

	/** The job failed. */
	public void fail(String id, Throwable error, long now) {
		finish(id, null, error, now);
	}

	private void finish(String id, @Nullable V value, @Nullable Throwable error, long now) {
		Waiting<V> w;
		synchronized (this) {
			w = waiting.remove(id);
			if (w == null) {
				early.put(id, new Early<>(value, error, now + earlyKeepMs));
			}
		}
		if (w != null) {
			settle(w.future(), value, error);
		}
	}

	private static <V> void settle(CompletableFuture<V> f, @Nullable V value, @Nullable Throwable error) {
		if (error != null) {
			f.completeExceptionally(error);
		} else {
			f.complete(value);
		}
	}

	/** Fails the futures past their deadline; forgets old unclaimed outcomes. Returns how many timed out. */
	public int expire(long now) {
		List<Map.Entry<String, Waiting<V>>> late = new ArrayList<>();
		synchronized (this) {
			for (Iterator<Map.Entry<String, Waiting<V>>> it = waiting.entrySet().iterator(); it.hasNext();) {
				Map.Entry<String, Waiting<V>> e = it.next();
				if (e.getValue().deadline() <= now || e.getValue().future().isDone()) {
					it.remove();
					if (!e.getValue().future().isDone()) {
						late.add(e);
					}
				}
			}
			early.values().removeIf(e -> e.until() <= now);
		}
		for (Map.Entry<String, Waiting<V>> e : late) {
			e.getValue().future().completeExceptionally(new TimeoutException(what + " " + e.getKey() + " did not finish in time"));
		}
		return late.size();
	}

	/** Fails every waiting future (the link dropped). Returns how many. */
	public int failAll(String reason) {
		List<Waiting<V>> all;
		synchronized (this) {
			all = new ArrayList<>(waiting.values());
			waiting.clear();
		}
		IllegalStateException ex = new IllegalStateException(reason);
		all.forEach(w -> w.future().completeExceptionally(ex));
		return all.size();
	}

	public synchronized int waitingCount() {
		return waiting.size();
	}

	public synchronized int earlyCount() {
		return early.size();
	}
}
