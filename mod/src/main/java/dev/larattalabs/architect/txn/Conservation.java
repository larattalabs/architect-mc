package dev.larattalabs.architect.txn;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * (slice T1, docs/TXN-DESIGN.md §5) The conservation check, <b>report-only</b> (Noah's decision 6: enforced only after T1 runs clean for one
 * batch). A multiset of item ids per part; each open txn's amounts count exactly once, by its probes (§5.2):
 * <ul>
 * <li>a take (into transit) APPLIED and not compensated, its booking (out of transit) not APPLIED: {@code inTransit};</li>
 * <li>taken and booked: at the sink (its store already counts it), transit 0;</li>
 * <li>compensated: at the source, transit 0;</li>
 * <li>booked while the take is compensated (going forward): a negative transit, reported as a violation;</li>
 * <li>an UNKNOWN probe: the point is inconclusive ({@code unread}), never a pass.</li>
 * </ul>
 * The parts the world holds (containers, stock, crates, entities, inventories, owed) are added by the caller; the comparison is exact
 * against a baseline. Nothing here fails anything: the verdict is {@code match}, {@code differs} or {@code inconclusive}.
 */
public final class Conservation {
	public static final String MODE = "report";

	private final Map<String, Map<String, Long>> parts = new TreeMap<>();
	private final List<String> unread = new ArrayList<>();
	private final List<String> violations = new ArrayList<>();

	/** Adds {@code items} to part {@code part}. */
	public Conservation add(String part, Map<String, ? extends Number> items) {
		Map<String, Long> m = parts.computeIfAbsent(part, k -> new TreeMap<>());
		items.forEach((k, v) -> m.merge(k, v.longValue(), Long::sum));
		return this;
	}

	public Conservation unread(String what) {
		unread.add(what);
		return this;
	}

	/** Adds every open txn's in-transit amounts by its probes (§5.2). */
	public Conservation inTransit(TxnCore core) {
		Map<String, Long> tr = new TreeMap<>();
		for (TxnEntry t : core.open()) {
			Map<String, Long> one = new TreeMap<>();
			for (Effect e : t.effects()) {
				if (e.items().isEmpty() || !e.intoTransit() && !e.outOfTransit()) {
					continue;
				}
				Probe p = core.probeFor(t, e);
				if (p == Probe.UNKNOWN) {
					unread.add(t.id + "/" + e.i() + " (" + e.op() + ")");
					continue;
				}
				if (p != Probe.APPLIED) {
					continue; // ABSENT: still at its source; COMPENSATED: back at its source
				}
				long sign = e.intoTransit() ? 1 : -1;
				e.items().forEach((k, v) -> one.merge(k, sign * v, Long::sum));
			}
			one.forEach((k, v) -> {
				if (v < 0) {
					violations.add(t.id + ": " + k + " booked " + -v + " more than taken (a sink booked over a compensated source)");
				}
				tr.merge(k, v, Long::sum);
			});
		}
		parts.put("inTransit", tr);
		return this;
	}

	/** Every part summed, per item. */
	public Map<String, Long> total() {
		Map<String, Long> t = new TreeMap<>();
		parts.values().forEach(m -> m.forEach((k, v) -> t.merge(k, v, Long::sum)));
		t.values().removeIf(v -> v == 0);
		return t;
	}

	/** The report: parts, total, unread, violations, and against {@code baseline} (null for none) the diff and the verdict. */
	public JsonObject report(Map<String, Long> baseline) {
		JsonObject o = new JsonObject();
		o.addProperty("mode", MODE);
		JsonObject ps = new JsonObject();
		parts.forEach((k, m) -> ps.add(k, json(m)));
		o.add("parts", ps);
		Map<String, Long> tot = total();
		o.add("total", json(tot));
		JsonArray u = new JsonArray();
		unread.forEach(u::add);
		o.add("unread", u);
		JsonArray v = new JsonArray();
		violations.forEach(v::add);
		o.add("violations", v);
		if (baseline != null) {
			Map<String, Long> diff = new TreeMap<>();
			tot.forEach((k, n) -> diff.merge(k, n, Long::sum));
			baseline.forEach((k, n) -> diff.merge(k, -n, Long::sum));
			diff.values().removeIf(x -> x == 0);
			o.add("diff", json(diff));
			o.addProperty("verdict", !unread.isEmpty() ? "inconclusive" : diff.isEmpty() && violations.isEmpty() ? "match" : "differs");
		}
		return o;
	}

	public List<String> violations() {
		return List.copyOf(violations);
	}

	public List<String> unreadList() {
		return List.copyOf(unread);
	}

	private static JsonObject json(Map<String, Long> m) {
		JsonObject o = new JsonObject();
		m.forEach(o::addProperty);
		return o;
	}
}
