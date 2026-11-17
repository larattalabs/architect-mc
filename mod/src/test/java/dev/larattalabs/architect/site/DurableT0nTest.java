package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.survival.SurvivalItems;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (slice T0, "finish the no-drop rule", the GPT check of 2e685bec) A live unkeyed give-back on a full pile (a construction swap's old
 * block, the feed's empty bucket) enters the stock, past capacity if need be, and drops nothing. A drop is saved with the world before the
 * ledger: when the ledger write then fails and the process crashes, the item lies on the ground while the old durable book still holds
 * the paid cell, and the reconcile at the next start credits it into the stock again. Counted on the ground plus in the stock across the
 * live give-back, the failed ledger write, the restart and the reconcile: exactly once.
 *
 * <p>The live paths run as the purse runs them ({@code swapGiveBack}, {@code feedPay}: Purse.giveBackPaid and Purse.pay delegate to them);
 * the reconcile's part through the code reconcile itself calls ({@code refundAtStart}, {@code consumeAtStart}). {@code reconcile} needs a
 * real {@code ServerLevel} (a running server: block states, chunk attachments, the region overwrites), which no unit can stub here (no
 * mocking library on the test classpath).
 */
class DurableT0nTest {
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
		Stockpiles.testCapacity = -1;
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
		Stockpiles.Pile p = Stockpiles.get(OWNER);
		Stockpiles.testCapacity = p.ledger.usedStacks(Stockpiles::maxStack); // full: no room left
		return p;
	}

	/** What the live give-back dropped: the world save keeps it (saved with the chunks, before the ledger). */
	int ground(String item) {
		int n = Stockpiles.LAST_DROP.getOrDefault(item, 0);
		Stockpiles.LAST_DROP.clear();
		return n;
	}

	/** The ledger write after the world save fails, the process crashes; the restart loads the durable ledger (the old book). */
	Stockpiles.Pile failThenRestart() {
		DurableFile.FAIL_BEFORE_RENAME.set(1);
		assertFalse(Stockpiles.save());
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get(OWNER);
	}

	int onDisk(String item) {
		assertTrue(Stockpiles.save());
		Stockpiles.loadFrom(tmp);
		return Stockpiles.get(OWNER).ledger.stock().getOrDefault(item, 0);
	}

	@Test
	void aLiveSwapsOldBlockOnAFullPileIsRefundedExactlyOnceAcrossACrash() throws IOException {
		Stockpiles.Pile p = full("\"" + COBBLE + "\":64");
		p.ledger.pay("site:t1@1", PLANKS, 4); // the paid cell, standing in the durable book
		assertTrue(Stockpiles.writeConfirmed(null).ok());
		Stockpiles.LAST_DROP.clear();
		// the live swap: the cell's old block given back out of the record (Purse.giveBackPaid)
		Stockpiles.swapGiveBack(null, p, "t1", Map.of(PLANKS, 4), -1, BlockPos.ZERO);
		int ground = ground(PLANKS);
		p = failThenRestart();
		// the next start: the old book still holds the cell paid and standing; the reconcile redoes the swap's give-back
		Stockpiles.refundAtStart(p, "t1", Map.of(PLANKS, 4), -1, Stockpiles.capacity(null, p));
		int stock = onDisk(PLANKS);
		assertEquals(0, ground, "nothing dropped");
		assertEquals(4, ground + stock, "the old block refunded exactly once (never a ground item and a stock credit)");
		assertTrue(Stockpiles.get(OWNER).ledger.refundOverflow().isEmpty(), "refundOverflow never grows");
	}

	@Test
	void aLiveFeedsEmptyBucketOnAFullPileIsCountedExactlyOnceAcrossACrash() throws IOException {
		Stockpiles.Pile p = full("\"" + COBBLE + "\":64,\"" + WATER + "\":1");
		assertTrue(Stockpiles.writeConfirmed(null).ok());
		Stockpiles.testCapacity = 1; // the bucket, once poured, has no room
		Stockpiles.LAST_DROP.clear();
		// the live feed places the water (Purse.pay): its empty bucket comes back
		Stockpiles.feedPay(null, p, "site:t1@1", List.of(new SurvivalItems.Cost(WATER, 1)), 1, null, BlockPos.ZERO);
		int ground = ground(BUCKET);
		p = failThenRestart();
		// the next start: the cell stands ahead of the old book; the reconcile charges it
		assertTrue(Stockpiles.consumeAtStart(p, WATER, 1, 1, new TreeMap<>()));
		int stock = onDisk(BUCKET);
		assertEquals(0, ground, "nothing dropped");
		assertEquals(1, ground + stock, "the empty bucket exactly once");
	}

	@Test
	void noProductionCodeDropsOverflow() throws IOException {
		String sp = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/site/Stockpiles.java"));
		assertFalse(sp.contains("dropOverflow("), "no give-back drops: every one enters the stock");
		String l = Files.readString(Path.of("src/main/java/dev/larattalabs/architect/survival/StockLedger.java"));
		assertFalse(l.contains("add(refundOverflow,"), "refundOverflow is a historical counter: read and kept, never incremented");
	}
}
