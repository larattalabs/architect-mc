package dev.larattalabs.architect.batch;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.ToDoubleFunction;
import org.jspecify.annotations.Nullable;

/**
 * The pure rules of the placement queue (docs/CONTRACT.md phase 4d): checking a batch and giving every item its stage, the
 * order items are tried in (stage, then {@code after}, then proximity or list order), and what cancelling does.
 */
public final class BatchRules {
	private BatchRules() {
	}

	/** An item as queued: its key, its stage (null = none) and the keys it comes after. */
	public record ItemSpec(String key, @Nullable String stage, List<String> after) {
	}

	/** A stage as declared on the batch. */
	public record StageSpec(String name, List<String> items) {
	}

	/** A checked batch: its stages in order (this batch's, appended to the group's) and each item's stage. */
	public record StagePlan(List<String> stages, Map<String, String> stageOf) {
	}

	/**
	 * Checks a batch and assigns stages. Items in no stage form a stage named {@code batchId}, first. A stage named only in
	 * an item's {@code stage} comes after the declared ones, in order of first mention. Refuses (an
	 * {@link IllegalArgumentException} with the reason) when: there are no items; an item key is blank or repeated; a stage
	 * name is blank, repeated, or already in the group; an item is in two stages; {@code after} names an unknown item,
	 * itself, an item of a later stage, or makes a cycle; the group exists and has another owner.
	 *
	 * @param groupStages the stage names the group already has (empty for a new group)
	 * @param groupExists whether {@code groupOwner} is an existing group's owner (else the batch makes the group)
	 */
	public static StagePlan plan(String batchId, List<ItemSpec> items, List<StageSpec> stages, Collection<String> groupStages, boolean groupExists,
		@Nullable String groupOwner, @Nullable String batchOwner) {
		if (groupExists && !Objects.equals(groupOwner, batchOwner)) {
			throw new IllegalArgumentException("the group is owned by " + who(groupOwner) + ", not " + who(batchOwner)
				+ ": a batch appends only to its owner's group");
		}
		if (items.isEmpty()) {
			throw new IllegalArgumentException("a batch needs at least one item");
		}
		Set<String> keys = new HashSet<>();
		for (ItemSpec i : items) {
			if (i.key() == null || i.key().isBlank()) {
				throw new IllegalArgumentException("an item has no itemKey");
			}
			if (!keys.add(i.key())) {
				throw new IllegalArgumentException("item key " + i.key() + " is used twice");
			}
		}
		Map<String, String> stageOf = new LinkedHashMap<>();
		List<String> order = new ArrayList<>();
		for (StageSpec s : stages) {
			if (s.name() == null || s.name().isBlank()) {
				throw new IllegalArgumentException("a stage has no name");
			}
			if (order.contains(s.name())) {
				throw new IllegalArgumentException("stage " + s.name() + " is declared twice");
			}
			order.add(s.name());
			for (String k : s.items()) {
				if (!keys.contains(k)) {
					throw new IllegalArgumentException("stage " + s.name() + " names an unknown item " + k);
				}
				String was = stageOf.put(k, s.name());
				if (was != null && !was.equals(s.name())) {
					throw new IllegalArgumentException("item " + k + " is in stages " + was + " and " + s.name());
				}
			}
		}
		boolean unstaged = false;
		for (ItemSpec i : items) {
			String listed = stageOf.get(i.key());
			if (i.stage() != null && !i.stage().isBlank()) {
				if (listed != null && !listed.equals(i.stage())) {
					throw new IllegalArgumentException("item " + i.key() + " is in stages " + listed + " and " + i.stage());
				}
				stageOf.put(i.key(), i.stage());
				if (!order.contains(i.stage())) {
					order.add(i.stage());
				}
			} else if (listed == null) {
				unstaged = true;
			}
		}
		if (unstaged) {
			if (order.contains(batchId)) {
				throw new IllegalArgumentException("stage name " + batchId + " is the batch id (it names the stage of the items without one)");
			}
			order.add(0, batchId);
			for (ItemSpec i : items) {
				stageOf.putIfAbsent(i.key(), batchId);
			}
		}
		for (String s : order) {
			if (groupStages.contains(s)) {
				throw new IllegalArgumentException("stage " + s + " already exists in the group (stage names are unique within a group)");
			}
		}
		Map<String, List<String>> deps = new HashMap<>();
		for (ItemSpec i : items) {
			for (String a : i.after()) {
				if (!keys.contains(a)) {
					throw new IllegalArgumentException("item " + i.key() + " comes after an unknown item " + a);
				}
				if (a.equals(i.key())) {
					throw new IllegalArgumentException("item " + i.key() + " comes after itself");
				}
				if (order.indexOf(stageOf.get(a)) > order.indexOf(stageOf.get(i.key()))) {
					throw new IllegalArgumentException("item " + i.key() + " (stage " + stageOf.get(i.key()) + ") comes after " + a + " of the later stage "
						+ stageOf.get(a));
				}
			}
			deps.put(i.key(), i.after());
		}
		String cycle = cycle(deps);
		if (cycle != null) {
			throw new IllegalArgumentException("the after dependencies make a cycle through " + cycle);
		}
		return new StagePlan(List.copyOf(order), Map.copyOf(stageOf));
	}

	private static String who(@Nullable String owner) {
		return owner == null ? "the player" : owner;
	}

	/** An item on a cycle of {@code deps}, or null. */
	static @Nullable String cycle(Map<String, List<String>> deps) {
		Map<String, Integer> mark = new HashMap<>();
		for (String k : deps.keySet()) {
			String c = visit(k, deps, mark);
			if (c != null) {
				return c;
			}
		}
		return null;
	}

	private static @Nullable String visit(String k, Map<String, List<String>> deps, Map<String, Integer> mark) {
		Integer m = mark.get(k);
		if (m != null) {
			return m == 1 ? k : null;
		}
		mark.put(k, 1);
		for (String d : deps.getOrDefault(k, List.of())) {
			String c = visit(d, deps, mark);
			if (c != null) {
				return c;
			}
		}
		mark.put(k, 2);
		return null;
	}

	/**
	 * The next item of {@code b} to try in its running stage, or null: one item places at a time per batch; only the group's
	 * running stage (the first not finished) places, and only when it is this batch's and approved; an item is ready when it
	 * is queued (or waiting and due for a re-check at {@code tick}) and every item it comes after is placed. Among the ready
	 * ones: the nearest to a player when {@code b.proximityFirst} ({@code distance}), ties and otherwise list order.
	 *
	 * @param runningStage the group's running stage name, or null
	 * @param runningApproved whether it may place (approved or already placing)
	 */
	public static @Nullable QItem next(QBatch b, @Nullable String runningStage, boolean runningApproved, long tick, ToDoubleFunction<QItem> distance) {
		if (!b.running() || b.cancelling || b.blocking() != null || runningStage == null || !runningApproved || !b.stages.contains(runningStage)) {
			return null;
		}
		QItem best = null;
		double bestD = Double.MAX_VALUE;
		for (QItem i : b.items) {
			if (!i.stage.equals(runningStage) || !ready(b, i, tick)) {
				continue;
			}
			if (!b.proximityFirst) {
				return i;
			}
			double d = distance.applyAsDouble(i);
			if (best == null || d < bestD) {
				best = i;
				bestD = d;
			}
		}
		return best;
	}

	static boolean ready(QBatch b, QItem i, long tick) {
		if (!(i.status == QItem.Status.QUEUED || i.status == QItem.Status.WAITING && i.nextCheck <= tick)) {
			return false;
		}
		for (String a : i.after) {
			QItem d = b.item(a);
			if (d == null || d.status != QItem.Status.PLACED) {
				return false;
			}
		}
		return true;
	}

	/** The first item {@code i} comes after that failed (so {@code i} never can be placed), or null. */
	public static @Nullable QItem failedDependency(QBatch b, QItem i) {
		for (String a : i.after) {
			QItem d = b.item(a);
			if (d != null && d.status == QItem.Status.FAILED) {
				return d;
			}
		}
		return null;
	}

	/** {placed, failed, total} of a stage's items. */
	public static int[] counts(QBatch b, String stage) {
		int placed = 0;
		int failed = 0;
		int total = 0;
		for (QItem i : b.items) {
			if (i.stage.equals(stage)) {
				total++;
				if (i.status == QItem.Status.PLACED) {
					placed++;
				} else if (i.status == QItem.Status.FAILED) {
					failed++;
				}
			}
		}
		return new int[] {placed, failed, total};
	}

	/**
	 * Cancels (or stops) a batch, in memory: every item not started (queued or waiting) fails CANCELLED; placed items stay.
	 * Returns the dropped items (each needs its ITEM_FAILED) and leaves the item being placed as it is: the caller rolls it
	 * back, then fails it CANCELLED too. {@code why}: the message.
	 */
	public static List<QItem> cancel(QBatch b, String why) {
		b.cancelling = true;
		List<QItem> dropped = new ArrayList<>();
		for (QItem i : b.items) {
			if (i.status == QItem.Status.QUEUED || i.status == QItem.Status.WAITING) {
				i.fail("CANCELLED", why);
				dropped.add(i);
			}
		}
		return dropped;
	}

	/** Items of a stage that is skipped: every item not started fails CANCELLED. Returns them. */
	public static List<QItem> skip(QBatch b, String stage) {
		List<QItem> out = new ArrayList<>();
		for (QItem i : b.items) {
			if (i.stage.equals(stage) && (i.status == QItem.Status.QUEUED || i.status == QItem.Status.WAITING)) {
				i.fail("CANCELLED", "stage " + stage + " was skipped");
				out.add(i);
			}
		}
		return out;
	}

	/** Whether every item of the batch is placed or failed (the batch is done once nothing is rolling back). */
	public static boolean allDone(QBatch b) {
		return b.items.stream().allMatch(i -> i.status.terminal());
	}
}
