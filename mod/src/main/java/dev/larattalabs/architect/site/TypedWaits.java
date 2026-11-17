package dev.larattalabs.architect.site;

import dev.larattalabs.architect.batch.QItem;

/**
 * (8a HB, the GPT review's P2-3) A typed wait's payload ({@code architect_mc:waitsFor}) lives only for the wait it was set for. Its writer
 * (RegionTargets' stage wait, MechCharges' bill wait) sets the payload and calls {@link #typed} right before {@link Batches#waitFor}; every
 * wait transition goes through {@link #settle}, which keeps a marked payload and clears any other, so an untyped wait (a fluids gate's
 * player or materials wait, a chunk wait, ...) never carries a stale one (a built terrain target's {@code kind: "terrain"}). Server thread.
 */
final class TypedWaits {
	private static final java.util.Set<QItem> TYPED = java.util.Collections.newSetFromMap(new java.util.IdentityHashMap<>());

	private TypedWaits() {
	}

	/** Marks {@code i}'s payload as the one for the wait put on it next. */
	static void typed(QItem i) {
		TYPED.add(i);
	}

	/** At a wait transition: keeps the payload when it was marked for this wait, else clears it. Returns whether it stays. */
	static boolean settle(QItem i) {
		if (TYPED.remove(i)) {
			return true;
		}
		i.ext.remove(RegionTargets.EXT_WAITS_FOR);
		return false;
	}
}
