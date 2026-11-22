package dev.larattalabs.architect.txn;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import org.jspecify.annotations.Nullable;

/**
 * (slice T1, docs/TXN-DESIGN.md §3.9) The kill-point registry: every point a txn step reaches is {@code TX:<kind>:<step>} (recovery's
 * {@code TX:recover:<kind>:<step>}), recorded per kind as it is first reached so {@code dev.txn.points} lists them and the harness
 * enumerates them; {@code dev.txn.trace} records the ordered points of one run. Any thread.
 */
public final class KillPoints {
	private KillPoints() {
	}

	private static final Map<String, Set<String>> SEEN = new TreeMap<>();
	private static @Nullable List<String> trace;

	/** (slice T4b) The kind whose point names {@code kind}'s points answer too: a removal's settle answers {@code crate.settle}'s. Null: none. */
	public static @Nullable String alias(String kind) {
		return kind.equals("removal.site") || kind.equals("removal.road") ? "crate.settle" : null;
	}

	/** The point's full name. */
	public static String name(String kind, boolean recovering, String step) {
		return "TX:" + (recovering ? "recover:" : "") + kind + ":" + step;
	}

	static synchronized void reached(String kind, String point) {
		SEEN.computeIfAbsent(kind, k -> new LinkedHashSet<>()).add(point);
		if (trace != null) {
			trace.add(point);
		}
	}

	/** (8cTb) A kind's own named step (an adapter's): registered, then the armed kill point halts here ({@code TX:<kind>:<step>}). */
	public static void step(String kind, boolean recovering, String step) {
		String point = name(kind, recovering, step);
		reached(kind, point);
		dev.larattalabs.architect.journal.WorldJournal.kill(point);
	}

	/** Every point of {@code kind} reached this session, in first-reached order. */
	public static synchronized List<String> points(String kind) {
		return List.copyOf(SEEN.getOrDefault(kind, Set.of()));
	}

	public static synchronized Map<String, List<String>> all() {
		Map<String, List<String>> m = new TreeMap<>();
		SEEN.forEach((k, v) -> m.put(k, List.copyOf(v)));
		return m;
	}

	/** Starts ({@code on}) or stops a trace; stopping answers the points reached since it started, in order. */
	public static synchronized List<String> trace(boolean on) {
		List<String> t = trace == null ? List.of() : List.copyOf(trace);
		trace = on ? new ArrayList<>() : null;
		return t;
	}
}
