package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.nio.file.Path;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * (slice T4R, row T4R-health; P1-3, Changes §7) {@code Sites.loadHealthy()} is false when any participant store failed to load: the sites
 * file, the queue, the stockpiles, the txn file. Set through the stores' own flags (reflection: the row runs on the base too).
 */
class T4RHealthTest {
	static void set(Class<?> c, String f, Object v) throws Exception {
		Field x = c.getDeclaredField(f);
		x.setAccessible(true);
		x.set(null, v);
	}

	static final String[] FLAGS = {"loadFailed"};

	@BeforeEach
	void healthy() throws Exception {
		set(Sites.class, "worldDir", Path.of("."));
		set(Sites.class, "loadFailed", false);
		set(Placement.class, "loadFailed", false);
		set(Stockpiles.class, "loadFailed", false);
		txn(false);
	}

	/** The txn file's load failure as Sites sees it (no TxnServer here: it needs the game's attachments). The base has no such flag. */
	static boolean txn(boolean failed) throws Exception {
		try {
			set(Sites.class, "txnLoadFailed", failed);
			return true;
		} catch (NoSuchFieldException e) {
			return false;
		}
	}

	@AfterEach
	void reset() throws Exception {
		set(Sites.class, "worldDir", null);
		set(Sites.class, "loadFailed", false);
		set(Placement.class, "loadFailed", false);
		set(Stockpiles.class, "loadFailed", false);
		txn(false);
	}

	@Test
	void everyStoreCountsForLoadHealthy() throws Exception {
		System.out.println("ROW T4R-health (unit)");
		assertTrue(Sites.loadHealthy(), "T4R-health: every store loaded: healthy");
		for (Class<?> c : new Class<?>[] {Sites.class, Placement.class, Stockpiles.class}) {
			set(c, "loadFailed", true);
			assertFalse(Sites.loadHealthy(), "T4R-health: " + c.getSimpleName() + " failed to load: loadHealthy must be false");
			set(c, "loadFailed", false);
		}
		assertTrue(txn(true), "T4R-health: Sites knows no txn.json load failure (txnLoadFailed)");
		assertFalse(Sites.loadHealthy(), "T4R-health: txn.json failed to load: loadHealthy must be false");
	}
}
