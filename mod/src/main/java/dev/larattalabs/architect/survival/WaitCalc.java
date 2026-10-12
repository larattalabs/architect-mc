package dev.larattalabs.architect.survival;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.ToIntFunction;

/**
 * The pure rules of C25 (docs/CONTRACT.md phase 6c slice Y, "Waiting status"): the {@code nextNeeded} walk and the waiting latch.
 * No Minecraft types, so {@code SiteWaitTest} covers them offline. Server thread only; not thread-safe.
 */
public final class WaitCalc {
	/** Ticks a target must place nothing while a frontier cell is unaffordable before it counts as waiting. */
	public static final int THRESHOLD = 100;
	/** At most one {@code SITE_WAITING} per target per this many ticks. */
	public static final int EVENT_TICKS = 20;
	/** The longest {@code nextNeeded} list. */
	public static final int MAX_NEEDED = 8;

	private WaitCalc() {
	}

	/** One entry of {@code nextNeeded}: an item and its whole shortfall for the target. */
	public record Need(String item, int count) {
	}

	/** The walk's answer: at most {@link #MAX_NEEDED} entries, the units of the omitted ones, and the total shortfall. */
	public record Needs(List<Need> list, int moreUnits, int totalShortfall) {
		public static final Needs NONE = new Needs(List.of(), 0, 0);
	}

	/**
	 * Walks the unbuilt cells in build order, spending {@code available} (per item: stock minus what higher targets reserve) the
	 * way the builder would. An item enters the list at the first cell where its cumulative cost passes what is available; its
	 * {@code count} is its whole shortfall for the target. So {@code sum(counts) + moreUnits} is the target's outstanding bill minus
	 * what is available to it (per item, never below 0).
	 *
	 * @param unbuiltCosts the cost lists of the cells not built yet, in build order
	 */
	public static Needs walk(Iterable<? extends List<SurvivalItems.Cost>> unbuiltCosts, ToIntFunction<String> available) {
		Map<String, Integer> left = new HashMap<>();
		Map<String, Integer> short_ = new LinkedHashMap<>();
		for (List<SurvivalItems.Cost> cell : unbuiltCosts) {
			for (SurvivalItems.Cost c : cell) {
				int have = left.computeIfAbsent(c.item(), k -> Math.max(0, available.applyAsInt(k)));
				int take = Math.min(have, c.count());
				left.put(c.item(), have - take);
				if (c.count() > take) {
					short_.merge(c.item(), c.count() - take, Integer::sum);
				}
			}
		}
		if (short_.isEmpty()) {
			return Needs.NONE;
		}
		List<Need> list = new ArrayList<>();
		int more = 0;
		int total = 0;
		for (var e : short_.entrySet()) {
			total += e.getValue();
			if (list.size() < MAX_NEEDED) {
				list.add(new Need(e.getKey(), e.getValue()));
			} else {
				more += e.getValue();
			}
		}
		return new Needs(List.copyOf(list), more, total);
	}

	/** What a builder tick did for one target. */
	public enum Outcome {
		/** At least one cell was placed. */
		PLACED,
		/** Nothing placed, and a frontier cell (unbuilt, supported, loaded) was unaffordable. */
		STARVED,
		/** Nothing placed and nothing starved: a player in a cell, an unloaded chunk or crate, a missing support. Neither starts nor ends a wait. */
		IDLE,
		/** The target is paused, its crate is gone, or it is built or removed: a wait ends. */
		ENDED
	}

	/** An edge to report: the start or the stop of a wait. */
	public enum Edge {
		NONE, START, STOP
	}

	/**
	 * One target's waiting latch. It starts after {@link #THRESHOLD} starved ticks in a row and, once on, holds until a cell is
	 * placed or the target ends (paused, built, removed, crate gone): a chunk unloading, a player stepping into a cell or the
	 * first ticks after a reload (the crate's chunk not loaded yet) do not end it. {@link #poll} hands out the start and stop edges at
	 * most once per {@link #EVENT_TICKS} ticks, deferring (never dropping) an edge that comes too soon.
	 */
	public static final class Latch {
		private boolean waiting;
		private long since;
		private int streak;
		private boolean reported;
		private long lastEvent = Long.MIN_VALUE / 2;

		public Latch() {
		}

		/** A latch restored from disk: waiting since {@code since}, already reported (no new event after a reload). */
		public static Latch restored(long since) {
			Latch l = new Latch();
			l.waiting = true;
			l.since = since;
			l.reported = true;
			return l;
		}

		public boolean waiting() {
			return waiting;
		}

		/** The game time of the start edge; 0 when not waiting. */
		public long since() {
			return waiting ? since : 0L;
		}

		/** Feeds one builder tick at game time {@code now}; returns whether the waiting state changed. */
		public boolean tick(long now, Outcome o) {
			boolean was = waiting;
			switch (o) {
				case PLACED, ENDED -> {
					streak = 0;
					waiting = false;
				}
				case IDLE -> streak = 0;
				case STARVED -> {
					streak++;
					if (!waiting && streak >= THRESHOLD) {
						waiting = true;
						since = now;
					}
				}
			}
			return was != waiting;
		}

		/** The edge due at {@code now}, if any (call after every tick). Marks it reported. */
		public Edge poll(long now) {
			if (waiting == reported || now - lastEvent < EVENT_TICKS) {
				return Edge.NONE;
			}
			reported = waiting;
			lastEvent = now;
			return waiting ? Edge.START : Edge.STOP;
		}

		/** The target is gone: the stop edge now (nothing is left to defer it to), or none when no start was reported. */
		public Edge finish(long now) {
			waiting = false;
			streak = 0;
			if (!reported) {
				return Edge.NONE;
			}
			reported = false;
			lastEvent = now;
			return Edge.STOP;
		}
	}
}
