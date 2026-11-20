package dev.larattalabs.architect.txn;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * (T4 final round, the GPT check of 8b742e1d, P1 4) A removal's found receipts are unique per (W effect, chunk): a partial multi-chunk replay
 * appends no second {@code @found=} to a chunk that kept its first, and {@code found()} counts one per chunk. Failing first on the seam commit
 * (8b742e1d's append-and-sum).
 */
class RemovalFoundFinalT4Test {
	static final String PRE = "tx-1/0@found=";

	/** A W apply over its chunks, as RemovalTxn.RESTORER's: each chunk's found (recorded before the first write) receipted, then restored. */
	static void apply(List<List<String>> chunks, List<Map<String, Integer>> foundNow) {
		for (int c = 0; c < chunks.size(); c++) {
			if (RemovalTxn.foundToAdd(chunks.get(c), PRE)) {
				chunks.get(c).add(PRE + RemovalTxn.encode(foundNow.get(c)));
			}
			chunks.get(c).add("tx-1/0@restored");
		}
	}

	/**
	 * The reviewer's case: planned 20, chunk A finds 10, chunk B none; A saved, B's save lost (its receipts gone with it), the txn replays its
	 * W over both. The found is 10, never 20.
	 */
	@Test
	void aPartialReplayCountsEachChunkOnce() {
		List<List<String>> chunks = new ArrayList<>(List.of(new ArrayList<>(), new ArrayList<>()));
		List<Map<String, Integer>> found = List.of(Map.of("minecraft:stone", 10), Map.of());
		apply(chunks, found);
		chunks.set(1, new ArrayList<>()); // the crash: B's chunk save lost
		apply(chunks, found); // recovery: W probes ABSENT (B lacks its receipt) and applies again over every chunk
		assertEquals(1, chunks.get(0).stream().filter(r -> r.startsWith(PRE)).count(), "one found receipt per chunk");
		assertEquals(Map.of("minecraft:stone", 10), RemovalTxn.sumFound(chunks, PRE));
	}

	/** Already duplicated receipts (written before this fix) count once per chunk too. */
	@Test
	void duplicatesWrittenBeforeCountOnce() {
		List<List<String>> chunks = List.of(new ArrayList<>(List.of(PRE + "minecraft:stone*10", "tx-1/0@restored", PRE + "minecraft:stone*10")),
			new ArrayList<>(List.of(PRE + "minecraft:dirt*3")));
		assertEquals(Map.of("minecraft:dirt", 3, "minecraft:stone", 10), RemovalTxn.sumFound(chunks, PRE));
	}
}
