package dev.larattalabs.architect.site;

import java.util.Collection;
import java.util.Set;
import java.util.function.Predicate;

/**
 * (LCAP, RG2a) The batch and group ids saved region records name, reserved at load: a record saved before its batch was queued (a crash at
 * kill point RG2a) names ids no batch or group holds, and {@link Batches} and {@link Sites} must never hand them to a later build. Pure.
 */
public final class RegionIds {
	private RegionIds() {
	}

	private static final Set<String> BATCHES = java.util.concurrent.ConcurrentHashMap.newKeySet();
	private static final Set<String> GROUPS = java.util.concurrent.ConcurrentHashMap.newKeySet();

	/** Reserves the ids these records name (null skipped). */
	public static void reserve(Collection<String> batchIds, Collection<String> groupIds) {
		BATCHES.addAll(batchIds);
		GROUPS.addAll(groupIds);
	}

	/** Whether batch id {@code id} is reserved. */
	public static boolean batchReserved(String id) {
		return BATCHES.contains(id);
	}

	/** Whether group id {@code id} is reserved. */
	public static boolean groupReserved(String id) {
		return GROUPS.contains(id);
	}

	/** The first {@code prefix + n} from {@code n} on that {@code taken} does not hold. */
	public static int firstFree(String prefix, int n, Predicate<String> taken) {
		while (taken.test(prefix + n)) {
			n++;
		}
		return n;
	}

	/** The world stopped. */
	public static void clear() {
		BATCHES.clear();
		GROUPS.clear();
	}
}
