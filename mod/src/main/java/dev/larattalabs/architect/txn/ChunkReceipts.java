package dev.larattalabs.architect.txn;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.world.level.chunk.LevelChunk;

/**
 * (slice T2) The chunk attachment {@code architect_mc:txn_receipts} ({@link TestMove#RECEIPTS}) for callers outside the txn package: a
 * receipt saved in the same chunk snapshot as the block-entity change it records (§3.4 B), so a restart reads what reached the world.
 */
public final class ChunkReceipts {
	private ChunkReceipts() {
	}

	public static List<String> of(LevelChunk ch) {
		return TestMove.receipts(ch);
	}

	/** Adds {@code receipt} and marks the chunk unsaved (the same tick as the change it records). */
	public static void add(LevelChunk ch, String receipt) {
		TestMove.addReceipt(ch, receipt);
	}

	/** Drops every receipt {@code drop} accepts (stale once the store that needed it is durable); marks the chunk unsaved if any went. */
	public static void remove(LevelChunk ch, Predicate<String> drop) {
		List<String> r = new ArrayList<>(of(ch));
		if (r.removeIf(drop)) {
			ch.setAttached(TestMove.RECEIPTS, List.copyOf(r));
			ch.markUnsaved();
		}
	}
}
