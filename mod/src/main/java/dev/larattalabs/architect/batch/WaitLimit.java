package dev.larattalabs.architect.batch;

/**
 * A batch item's wait limit (Batches.waitFor and queueRegion), kept free of the server so it is unit-tested (RegionWaitLimitTest;
 * docs/GATES.md "Fast checks P1").
 */
public final class WaitLimit {
	private WaitLimit() {
	}

	/** (S8) A region batch's limit in ticks: none (Long.MAX_VALUE) unless the caller set {@code maxWaitSeconds} > 0. */
	public static long regionTicks(int maxWaitSeconds) {
		return maxWaitSeconds > 0 ? maxWaitSeconds * 20L : Long.MAX_VALUE;
	}

	/**
	 * One re-check of a waiting item: a repeated wait that counts ({@code uncounted}: a region's staged waits without a cap) adds
	 * {@code recheck} ticks; true when the item has waited its batch's limit (it fails TIMED_OUT).
	 */
	public static boolean count(QBatch b, QItem i, boolean first, boolean uncounted, int recheck) {
		if (!first && !uncounted) {
			i.waited += recheck;
		}
		return i.waited >= b.maxWaitTicks;
	}
}
