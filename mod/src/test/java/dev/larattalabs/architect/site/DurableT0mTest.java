package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0 on main v0.77.0, the GPT check of f55b9425) The reconcile at an unclean start credits its unkeyed refunds (a lost cell's cost,
 * a swap's old block, an ahead cell's empty bucket) into the stock, past capacity if need be, as OVF's keyed ones: nothing drops. Its book
 * is saved only after the world, so a failed ledger write plus a crash replays the same refund at the next start; a dropped overflow would
 * then exist twice. Counted on a full pile across reconcile, failed ledger write, restart, reconcile: the refund exactly once, nothing
 * dropped.
 */
class DurableT0mTest {
	@TempDir
	Path tmp;

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	@AfterEach
	void reset() {
		DurableFile.FAIL_BEFORE_RENAME.set(0);
		Stockpiles.loadFrom(tmp.resolve("none"));
		Stockpiles.unsaved = false;
		SaveGuards.clear();
	}

	static final String OWNER = "test:a", COBBLE = "minecraft:cobblestone", PLANKS = "minecraft:oak_planks", WATER = "minecraft:water_bucket",
		BUCKET = "minecraft:bucket";

	Stockpiles.Pile full(String delivered) throws IOException {
		Files.writeString(tmp.resolve(Stockpiles.FILE), "{\"format\":2,\"nextId\":2,\"stockpiles\":[{\"id\":\"sp1\",\"owner\":\"" + OWNER
			+ "\",\"dimension\":\"minecraft:overworld\",\"crates\":[],\"ledger\":{\"delivered\":{" + delivered + "}}}]}", StandardCharsets.UTF_8);
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get(OWNER);
	}

	/** The reconcile's ledger write fails (before its rename), then the process crashes; the restart loads the durable ledger. */
	Stockpiles.Pile failThenRestart() {
		DurableFile.FAIL_BEFORE_RENAME.set(1);
		assertFalse(Stockpiles.save(), "the reconcile's ledger write fails");
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get(OWNER);
	}

	int cap(Stockpiles.Pile p) {
		return p.ledger.usedStacks(Stockpiles::maxStack); // full: no room left
	}

	@Test
	void aLostCellsRefundOnAFullPileIsCountedOnceAndNothingDrops() throws IOException {
		Stockpiles.Pile p = full("\"" + COBBLE + "\":64");
		p.ledger.pay("site:t1@1", PLANKS, 4); // the saved book: the cell stands, paid
		assertTrue(Stockpiles.writeConfirmed(null).ok(), "the durable book before the unclean stop");
		Map<String, Integer> cost = Map.of(PLANKS, 4); // the world lost the cell
		int dropped = 0;
		// first start: the reconcile refunds it (the lost-cell site; the swap give-back goes through the same refund)
		dropped += Stockpiles.refundAtStart(p, "t1", cost, -1, cap(p)).credit().overflow().getOrDefault(PLANKS, 0);
		p = failThenRestart();
		// second start: the old book still holds the paid cell, the world still lacks it: the same refund again
		dropped += Stockpiles.refundAtStart(p, "t1", cost, -1, cap(p)).credit().overflow().getOrDefault(PLANKS, 0);
		assertTrue(Stockpiles.save());
		Stockpiles.loadFrom(tmp);
		int stock = Stockpiles.get(OWNER).ledger.stock().getOrDefault(PLANKS, 0);
		assertEquals(0, dropped, "nothing dropped (an item entity saved with the world before the ledger would survive the crash)");
		assertEquals(4, stock + dropped, "the refund counted exactly once");
		assertTrue(Stockpiles.get(OWNER).ledger.refundOverflow().isEmpty(), "and none of it booked as overflow (OVF's accounting)");
	}

	@Test
	void anAheadCellsEmptyBucketOnAFullPileIsCountedOnceAndNothingDrops() throws IOException {
		Stockpiles.Pile p = full("\"" + COBBLE + "\":64,\"" + WATER + "\":1");
		assertTrue(Stockpiles.writeConfirmed(null).ok());
		int dropped = 0;
		Map<String, Integer> over = new TreeMap<>();
		// first start: an ahead cell (water placed after the save) charged: its empty bucket comes back on a pile with no room
		assertTrue(Stockpiles.consumeAtStart(p, WATER, 1, 1, over));
		dropped += over.getOrDefault(BUCKET, 0);
		p = failThenRestart();
		over.clear();
		assertTrue(Stockpiles.consumeAtStart(p, WATER, 1, 1, over));
		dropped += over.getOrDefault(BUCKET, 0);
		assertTrue(Stockpiles.save());
		Stockpiles.loadFrom(tmp);
		int stock = Stockpiles.get(OWNER).ledger.stock().getOrDefault(BUCKET, 0);
		assertEquals(0, dropped, "nothing dropped");
		assertEquals(1, stock + dropped, "the empty bucket exactly once");
	}

	@Test
	void theThreeSitesDropNothing() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		String r = StockpileSaveHFTest.body(sp, "static boolean reconcile(MinecraftServer srv, ServerLevel level, Pile p, Object t, String key,");
		assertFalse(r.contains("dropOverflow("), "the reconcile drops no overflow at its refund sites");
	}
}
