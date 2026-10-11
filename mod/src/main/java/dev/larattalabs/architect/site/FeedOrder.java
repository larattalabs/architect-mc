package dev.larattalabs.architect.site;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.function.ToIntFunction;
import org.jspecify.annotations.Nullable;

/**
 * A stockpile's feed order (docs/CONTRACT.md phase 6c slice Y, C24 §3, with Steward's S-Y-1): the order its targets are fed in,
 * and the reservations that order makes. Pure.
 *
 * <p><b>Default order:</b> a batch's items in batch item order (not the order they happen to be placed in), then later targets
 * in placement order. {@link #setFront} moves listed ids to the front in that order; the others keep their relative order.
 *
 * <p><b>Reservation by item:</b> the target at position k may consume a unit of X only from {@code stock(X) - reserved_k(X)},
 * where {@code reserved_k(X)} is the unbuilt cost of X over the targets before it that reserve: building, not paused, and not
 * waiting only on unloaded chunks (a target whose whole remaining frontier is in unloaded chunks does not reserve). A target
 * held by a transient blocker (a player in a cell, a support not built yet) still reserves.
 */
public final class FeedOrder {
	private FeedOrder() {
	}

	/** Where a target came from: its batch and its index among the batch's items (null batch: not a batch item). */
	public record Origin(@Nullable String batchId, int itemIndex) {
		public static final Origin NONE = new Origin(null, 0);
	}

	/**
	 * Inserts a target that joins the order: among the targets of its batch by item index; else (or with none of its batch
	 * listed) at the end.
	 */
	public static void insert(List<String> order, String id, Origin o, Function<String, Origin> originOf) {
		if (order.contains(id)) {
			return;
		}
		if (o.batchId() != null) {
			int lastSame = -1;
			for (int i = 0; i < order.size(); i++) {
				Origin x = originOf.apply(order.get(i));
				if (x != null && o.batchId().equals(x.batchId())) {
					if (x.itemIndex() > o.itemIndex()) {
						order.add(i, id);
						return;
					}
					lastSame = i;
				}
			}
			if (lastSame >= 0) {
				order.add(lastSame + 1, id);
				return;
			}
		}
		order.add(id);
	}

	/**
	 * {@code setFeedOrder}: {@code ids} move to the front in that order; the others keep their relative order. Throws
	 * IllegalArgumentException naming the ids that are not targets of the order (unknown or finished), or listed twice.
	 */
	public static List<String> setFront(List<String> order, List<String> ids) {
		List<String> bad = new ArrayList<>();
		Set<String> seen = new LinkedHashSet<>();
		for (String id : ids) {
			if (id == null || !order.contains(id) || !seen.add(id)) {
				bad.add(String.valueOf(id));
			}
		}
		if (!bad.isEmpty()) {
			throw new IllegalArgumentException("not a building target of this stockpile (unknown, finished or listed twice): " + String.join(", ", bad));
		}
		List<String> out = new ArrayList<>(seen);
		for (String id : order) {
			if (!seen.contains(id)) {
				out.add(id);
			}
		}
		return out;
	}

	/** The running reservation of a feed pass: the unbuilt cost of the reserving targets visited so far. */
	public static final class Reserve {
		private final Map<String, Integer> reserved = new TreeMap<>();

		/** What target k may use of {@code item}: {@code stock - reserved} (never below 0). */
		public int available(String item, ToIntFunction<String> stock) {
			return Math.max(0, stock.applyAsInt(item) - reserved.getOrDefault(item, 0));
		}

		public int reserved(String item) {
			return reserved.getOrDefault(item, 0);
		}

		/** After a target's turn: it reserves its unbuilt cost for the targets after it, when it reserves. */
		public void add(Map<String, Integer> unbuilt, boolean reserves) {
			if (!reserves) {
				return;
			}
			unbuilt.forEach((k, v) -> {
				if (v > 0) {
					reserved.merge(k, v, Integer::sum);
				}
			});
		}

		public Map<String, Integer> reserved() {
			return Map.copyOf(reserved);
		}
	}

	/**
	 * Whether a target reserves (S-Y-1): building, not paused, and some of its remaining frontier is in a loaded chunk (a target
	 * whose whole remaining frontier is unloaded does not; nor one with nothing left).
	 */
	public static boolean reserves(boolean building, boolean paused, boolean anyUnbuilt, boolean frontierLoaded) {
		return building && !paused && anyUnbuilt && frontierLoaded;
	}
}
