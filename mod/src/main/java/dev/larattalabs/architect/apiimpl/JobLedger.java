package dev.larattalabs.architect.apiimpl;

import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Which job events to fire (R7: {@code JOB_UPDATED}, {@code JOB_DONE}), deduplicated: a job's update fires when its status,
 * step, cost or updatedAt changed since the last one fired; DONE fires once per job ever (the set is persisted by the caller,
 * so a reconnect's snapshot, a sidecar restart or a game restart does not fire it again). A job is keyed by
 * {@code id@createdAt}, because a sidecar whose state was wiped numbers its jobs from 1 again. Not thread-safe (the server
 * thread owns it). Internal.
 */
public final class JobLedger {
	/** How many finished jobs to remember. */
	public static final int KEEP = 500;

	/** What changes a job's update: anything the sidecar may change. */
	public record Mark(String status, String step, long updatedAt, double usd) {
	}

	private final Map<String, Mark> lastFired = new HashMap<>();
	private final Set<String> done = new LinkedHashSet<>();

	public static String key(String id, long createdAt) {
		return id + "@" + createdAt;
	}

	/** Seeds the DONE set (from disk). */
	public void restoreDone(Collection<String> keys) {
		done.addAll(keys);
		trim();
	}

	/** The DONE set, oldest first (to save). */
	public List<String> doneKeys() {
		return List.copyOf(done);
	}

	/** Whether JOB_UPDATED fires for this state (and remembers it). */
	public boolean updated(String key, Mark m) {
		return !Objects.equals(lastFired.put(key, m), m);
	}

	/** Whether JOB_DONE fires for this finished job (and remembers it); false for an unfinished one. */
	public boolean done(String key, boolean finished) {
		if (!finished || !done.add(key)) {
			return false;
		}
		trim();
		return true;
	}

	public boolean isDone(String key) {
		return done.contains(key);
	}

	private void trim() {
		while (done.size() > KEEP) {
			done.remove(done.iterator().next());
		}
	}
}
