package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.site.ChunkTickets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;

/**
 * Gate item 1 (mod, world seam): GENERATED_ONLY never tickets a chunk that was not generated (a fake chunk source that records
 * every ticket), and the queue-time CHUNK_BOUND.
 */
class TicketGateTest {
	@Test
	void generatedOnlyNeverTicketsAnUngeneratedChunk() {
		Random r = new Random(6);
		for (int round = 0; round < 500; round++) {
			ChunkTickets.reset();
			Map<Long, ChunkGen.State> world = new HashMap<>();
			for (long c = 0; c < 64; c++) {
				int k = r.nextInt(10);
				world.put(c, k == 0 ? ChunkGen.State.NOT_GENERATED : k == 1 ? ChunkGen.State.UNKNOWN : ChunkGen.State.GENERATED);
			}
			List<Long> ticketed = new ArrayList<>();
			ChunkTickets.Source src = new ChunkTickets.Source() {
				@Override
				public void add(long chunk) {
					ticketed.add(chunk);
				}

				@Override
				public void remove(long chunk) {
				}
			};
			// items asking for random 6x6-ish chunk sets, as Batches asks before ticketing
			for (int item = 0; item < 20; item++) {
				List<Long> want = new ArrayList<>();
				int start = r.nextInt(50);
				for (int i = 0; i < 1 + r.nextInt(14); i++) {
					want.add((long) start + i);
				}
				long g = TicketGate.check(want, world::get);
				if (g == TicketGate.OK) {
					ChunkTickets.acquire("o", want, src);
				} else if (g != TicketGate.UNKNOWN) {
					assertEquals(ChunkGen.State.NOT_GENERATED, world.get(g), "the refusal names a chunk that was never generated");
				}
			}
			for (long c : ticketed) {
				assertEquals(ChunkGen.State.GENERATED, world.get(c), "round " + round + ": chunk " + c + " ticketed while " + world.get(c));
			}
		}
	}

	@Test
	void anUnknownStatusWaitsAndNeverTickets() {
		assertEquals(TicketGate.UNKNOWN, TicketGate.check(List.of(1L, 2L), c -> c == 2 ? ChunkGen.State.UNKNOWN : ChunkGen.State.GENERATED));
		assertEquals(2L, TicketGate.check(List.of(1L, 2L, 3L), c -> c == 2 ? ChunkGen.State.NOT_GENERATED : ChunkGen.State.UNKNOWN));
		assertEquals(TicketGate.OK, TicketGate.check(List.of(), c -> ChunkGen.State.NOT_GENERATED));
	}

	@Test
	void chunkBoundRefusesOnlyWhatCanNeverFit() {
		assertNull(TicketGate.chunkBound(36, 64), "a tile (6x6) fits the region bound");
		assertNull(TicketGate.chunkBound(64, 64));
		String why = TicketGate.chunkBound(81, 64);
		assertNotNull(why);
		assertTrue(why.contains("81") && why.contains("64"));
		assertNull(TicketGate.chunkBound(500, 0), "LOADED_ONLY holds no tickets and is not checked");
		assertFalse(TicketGate.chunkBound(65, 64) == null);
	}
}
