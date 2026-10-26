package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** SAFETY: the undo key's "newest site this player placed this session that is still theirs". */
class LastPlacedTest {
	private static final String ME = "me";
	private static final String YOU = "you";
	/** The world's sites: id -> placedAt (absent = removed); owners: id -> owner. */
	private final Map<String, Long> sites = new HashMap<>();
	private final Map<String, String> owners = new HashMap<>();
	private final LastPlaced last = new LastPlaced();

	private void place(String who, String id, long at) {
		sites.put(id, at);
		last.record(who, id, at);
	}

	private String latest(String who) {
		LastPlaced.Entry e = last.latest(who, x -> sites.containsKey(x.site()) && sites.get(x.site()) == x.placedAt() && !owners.containsKey(x.site()));
		return e == null ? null : e.site();
	}

	@Test
	void newestFirstPerPlayer() {
		place(ME, "cabin_1", 1);
		place(YOU, "tower_1", 2);
		place(ME, "cabin_2", 3);
		assertEquals("cabin_2", latest(ME));
		assertEquals("tower_1", latest(YOU), "only your own");
		assertNull(latest("nobody"));
	}

	@Test
	void removedSitesAreSkippedAndDropped() {
		place(ME, "cabin_1", 1);
		place(ME, "cabin_2", 2);
		sites.remove("cabin_2"); // undone
		assertEquals("cabin_1", latest(ME));
		sites.remove("cabin_1");
		assertNull(latest(ME));
	}

	@Test
	void aReusedIdIsNotYours() {
		place(ME, "cabin_1", 1);
		sites.put("cabin_1", 99L); // removed, and someone placed another cabin_1
		assertNull(latest(ME));
	}

	@Test
	void ownedSitesAreNeverTheKeys() {
		place(ME, "cabin_1", 1);
		place(ME, "cabin_2", 2);
		owners.put("cabin_2", "steward_mc:lot"); // adopted by another mod since
		assertEquals("cabin_1", latest(ME));
	}

	@Test
	void depthAndClear() {
		for (int i = 0; i < LastPlaced.DEPTH + 10; i++) {
			place(ME, "s" + i, i);
		}
		for (int i = 0; i < LastPlaced.DEPTH + 10; i++) {
			sites.remove("s" + (LastPlaced.DEPTH + 9 - i));
			String l = latest(ME);
			if (i < LastPlaced.DEPTH - 1) {
				assertEquals("s" + (LastPlaced.DEPTH + 8 - i), l);
			} else {
				assertNull(l, "only the newest " + LastPlaced.DEPTH + " are remembered");
			}
		}
		place(ME, "a", 1);
		last.clear();
		assertNull(latest(ME), "a new session starts empty");
	}
}
