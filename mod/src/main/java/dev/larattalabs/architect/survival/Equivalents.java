package dev.larattalabs.architect.survival;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.jspecify.annotations.Nullable;

/**
 * The curated equivalence table ({@code data/architect_mc/equivalents.json}, docs/CONTRACT.md phase 3 "Equivalents"):
 * <b>one way only</b>, raw to processed, at vanilla crafting / stonecutter yields ("1 spruce log = 4 spruce planks",
 * "1 spruce planks = 2 spruce slabs"). Nothing converts back and nothing skips smelting. Chains follow the edges
 * (log -> planks -> slabs: 1 log = 8 slabs, the yield of crafting the planks first) up to {@link #MAX_DEPTH} steps.
 * Pure.
 */
public final class Equivalents {
	public static final String RESOURCE = "/data/architect_mc/equivalents.json";
	public static final int MAX_DEPTH = 2;

	/** {@code 1 from = yield to}. */
	public record Rule(String from, String to, int yield) {
		public Rule {
			if (yield < 1) {
				throw new IllegalArgumentException("yield must be >= 1: " + from + " -> " + to);
			}
			if (from.equals(to)) {
				throw new IllegalArgumentException("a rule must change the item: " + from);
			}
		}
	}

	/** One unit of an input converts to {@code count} of {@code item} ({@code depth} edges). */
	public record Path(String item, int count, int depth) {
	}

	private final Map<String, List<Rule>> byFrom;

	public Equivalents(List<Rule> rules) {
		Map<String, List<Rule>> m = new LinkedHashMap<>();
		for (Rule r : rules) {
			m.computeIfAbsent(r.from(), k -> new ArrayList<>()).add(r);
		}
		m.replaceAll((k, v) -> List.copyOf(v));
		this.byFrom = Map.copyOf(m);
		// one way only: a rule whose output reaches back to its input would let items cycle (and multiply)
		for (Rule r : rules) {
			for (Path p : paths(r.to(), 8)) {
				if (p.item().equals(r.from())) {
					throw new IllegalArgumentException("equivalents must be one way: " + r.from() + " -> " + r.to() + " -> ... -> " + r.from());
				}
			}
		}
	}

	/** {@code {"rules": [{"from": id, "to": id, "yield": n}, ...]}}. */
	public static Equivalents parse(JsonObject o) {
		List<Rule> rules = new ArrayList<>();
		if (o.has("rules")) {
			o.getAsJsonArray("rules").forEach(e -> {
				JsonObject r = e.getAsJsonObject();
				rules.add(new Rule(r.get("from").getAsString(), r.get("to").getAsString(), r.has("yield") ? r.get("yield").getAsInt() : 1));
			});
		}
		return new Equivalents(rules);
	}

	private static volatile @Nullable Equivalents bundled;

	public static Equivalents bundled() {
		Equivalents b = bundled;
		if (b == null) {
			try (InputStream in = Equivalents.class.getResourceAsStream(RESOURCE)) {
				b = in == null ? new Equivalents(List.of())
					: parse(JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject());
			} catch (IOException | RuntimeException e) {
				b = new Equivalents(List.of());
			}
			bundled = b;
		}
		return b;
	}

	/** Every item one unit of {@code from} converts to, nearest first (depth, then table order). Excludes {@code from}. */
	public List<Path> paths(String from) {
		return paths(from, MAX_DEPTH);
	}

	private List<Path> paths(String from, int maxDepth) {
		List<Path> out = new ArrayList<>();
		Set<String> seen = new HashSet<>();
		seen.add(from);
		List<Path> frontier = List.of(new Path(from, 1, 0));
		for (int d = 1; d <= maxDepth && !frontier.isEmpty(); d++) {
			List<Path> next = new ArrayList<>();
			for (Path p : frontier) {
				for (Rule r : byFrom.getOrDefault(p.item(), List.of())) {
					if (seen.add(r.to())) {
						Path q = new Path(r.to(), Math.multiplyExact(p.count(), r.yield()), d);
						out.add(q);
						next.add(q);
					}
				}
			}
			frontier = next;
		}
		return out;
	}

	/** Whether {@code item} converts to anything at all. */
	public boolean converts(String item) {
		return byFrom.containsKey(item);
	}

	public int size() {
		return byFrom.values().stream().mapToInt(List::size).sum();
	}
}
