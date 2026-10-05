package dev.larattalabs.architect.apiimpl;

import com.google.gson.JsonObject;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The answers to mod-provided tool calls, by {@code callId} (docs/CONTRACT.md "Phase 4a sidecar as built": the same callId can
 * arrive again after a reconnect or a sidecar restart, and gets the same answer without running the handler again).
 *
 * <p>A call is {@link #begin begun} once (its handler runs), {@link #answer answered} once, and from then on every arrival
 * of the same callId re-sends the cached answer. The cache keeps the newest {@code capacity} answers. Thread-safe.
 * Internal.
 */
public final class ToolAnswerCache {
	/** What to do with an arriving call. */
	public enum Action {
		/** First arrival: run the handler. */
		RUN,
		/** The handler is still running: its answer goes out when it is done. */
		RUNNING,
		/** Answered before: re-send {@link #get}. */
		RESEND
	}

	private final int capacity;
	private final Set<String> running = new HashSet<>();
	private final Map<String, JsonObject> answers;

	public ToolAnswerCache(int capacity) {
		this.capacity = capacity;
		this.answers = new LinkedHashMap<>(16, 0.75f, true) {
			@Override
			protected boolean removeEldestEntry(Map.Entry<String, JsonObject> eldest) {
				return size() > ToolAnswerCache.this.capacity;
			}
		};
	}

	/** A call arrived: what to do. {@link Action#RUN} marks it running. */
	public synchronized Action begin(String callId) {
		if (answers.containsKey(callId)) {
			return Action.RESEND;
		}
		if (!running.add(callId)) {
			return Action.RUNNING;
		}
		return Action.RUN;
	}

	/**
	 * Records the answer (the {@code job.tool.result} payload without envelope fields); the call is no longer running. Call
	 * this BEFORE sending, so a send that fails (the link is down) is re-sent on the next arrival.
	 */
	public synchronized void answer(String callId, JsonObject payload) {
		running.remove(callId);
		answers.put(callId, payload.deepCopy());
	}

	/** The cached answer (a copy), or null. */
	public synchronized @Nullable JsonObject get(String callId) {
		JsonObject a = answers.get(callId);
		return a == null ? null : a.deepCopy();
	}

	public synchronized boolean isRunning(String callId) {
		return running.contains(callId);
	}

	public synchronized int size() {
		return answers.size();
	}
}
