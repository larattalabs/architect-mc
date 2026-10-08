package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** The 4e timeout cause (artifacts/gate6a/timeouts.md): two holders of one chunk must not drop each other's ticket. */
class ChunkTicketsTest {
	/** Vanilla's rule: one ticket per (type, level) and chunk; adding again is a no-op, one removal drops it. */
	static final class VanillaLike implements ChunkTickets.Source {
		final Map<Long, Boolean> ticket = new HashMap<>();
		final List<String> log = new ArrayList<>();

		@Override
		public void add(long chunk) {
			ticket.put(chunk, true);
			log.add("+" + chunk);
		}

		@Override
		public void remove(long chunk) {
			ticket.remove(chunk);
			log.add("-" + chunk);
		}
	}

	@BeforeEach
	void reset() {
		ChunkTickets.reset();
	}

	@Test
	void aSharedChunkKeepsItsTicketUntilTheLastHolderLetsGo() {
		VanillaLike w = new VanillaLike();
		ChunkTickets.acquire("o", List.of(1L, 2L), w); // item A
		ChunkTickets.acquire("o", List.of(2L, 3L), w); // item B shares chunk 2
		ChunkTickets.release("o", List.of(1L, 2L), w); // A finishes
		assertTrue(w.ticket.containsKey(2L), "B's chunk 2 lost its ticket when A finished (the 4e bug)");
		assertTrue(w.ticket.containsKey(3L));
		assertEquals(1, ChunkTickets.count("o", 2L));
		ChunkTickets.release("o", List.of(2L, 3L), w);
		assertTrue(w.ticket.isEmpty());
		assertEquals(List.of("+1", "+2", "+3", "-1", "-2", "-3"), w.log, "one vanilla add and one removal per chunk");
	}

	@Test
	void dimensionsAreSeparateAndExtraReleasesAreIgnored() {
		VanillaLike w = new VanillaLike();
		ChunkTickets.acquire("o", List.of(5L), w);
		ChunkTickets.acquire("n", List.of(5L), w);
		ChunkTickets.release("n", List.of(5L), w);
		ChunkTickets.release("n", List.of(5L), w);
		assertEquals(1, ChunkTickets.count("o", 5L));
		assertEquals(0, ChunkTickets.count("n", 5L));
		assertEquals(1, ChunkTickets.held());
	}
}
