package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.StockLedger;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.ToIntFunction;
import net.minecraft.SharedConstants;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (M5 FK, S-M5-3) Filled containers: the entry's fill (given-program only, the mod's own checks over the kit's: an item's max stack, a
 * bound), a lock only on a kept property (Steward's review A), the sub-multiset rule for "ours", and the ledger's commit marker and
 * custody: the custody refunds with the blocks once, capped by the paid record (F12: min(actual, declared) by construction, the cap,
 * the fill billed under the target's key), saved with the ledger.
 */
class FillsFKTest {
	static final ToIntFunction<String> MAX = id -> 64;
	static final int CAP = 4 * StockLedger.STACKS_PER_CRATE;
	static final String KEY = "site:hall@100";
	static final String COBBLE = "minecraft:cobblestone";
	static final String STICK = "minecraft:stick";
	static final String HOPPER = "minecraft:hopper";

	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	static JsonObject entry(String fill, boolean given) {
		JsonObject o = JsonParser.parseString("{\"id\": \"fk_hall\", \"fill\": " + fill + "}").getAsJsonObject();
		if (given) {
			o.add("givenProgram", JsonParser.parseString("{\"sha\": \"x\", \"opKey\": \"k\"}"));
		}
		return o;
	}

	static final String ONE = "{\"containers\": [{\"at\": [1, 2, 1], \"items\": [{\"slot\": 0, \"id\": \"minecraft:cobblestone\", \"count\": 18}, "
		+ "{\"slot\": 1, \"id\": \"minecraft:stick\", \"count\": 1}]}], \"locks\": [{\"at\": [0, 3, 1], \"locked\": {\"powered\": \"true\"}}]}";

	@Test
	void theSpecParsesAndSumsItsBill() {
		Fills.Spec s = Fills.parse(entry(ONE, true));
		assertEquals(1, s.containers().size());
		assertEquals(Map.of(COBBLE, 18, STICK, 1), s.items());
		assertEquals(Map.of("powered", "true"), s.locks().get(0).props());
		assertNull(Fills.parse(JsonParser.parseString("{\"id\": \"plain\"}").getAsJsonObject()), "no fill: none");
		assertNull(Fills.refusal(entry(ONE, true)));
	}

	@Test
	void refusedOffGivenProgramsAndOverTheModsOwnChecks() {
		assertTrue(Fills.refusal(entry(ONE, false)).contains("given-program"));
		assertTrue(Fills.refusal(entry("{\"containers\": [{\"at\": [0,0,0], \"items\": [{\"slot\": 0, \"id\": \"minecraft:no_such_item\", \"count\": 1}]}]}",
			true)).contains("not an item"));
		assertTrue(Fills.refusal(entry("{\"containers\": [{\"at\": [0,0,0], \"items\": [{\"slot\": 0, \"id\": \"minecraft:dirt\", \"count\": 65}]}]}",
			true)).contains("1..64"), "over the item's max stack (the unit test's max is 64: components unbound)");
		StringBuilder many = new StringBuilder("{\"containers\": [");
		for (int i = 0; i <= Fills.CONTAINERS_MAX; i++) {
			many.append(i == 0 ? "" : ",").append("{\"at\": [").append(i).append(",0,0], \"items\": [{\"slot\": 0, \"id\": \"minecraft:dirt\", \"count\": 1}]}");
		}
		assertTrue(Fills.refusal(entry(many + "]}", true)).contains("1..64"));
		assertTrue(Fills.refusal(entry("{\"containers\": [{\"at\": [0,0,0], \"items\": [{\"slot\": 0, \"id\": \"minecraft:dirt\", \"count\": 1}]}, "
			+ "{\"at\": [0,0,0], \"items\": [{\"slot\": 0, \"id\": \"minecraft:dirt\", \"count\": 1}]}]}", true)).contains("twice"));
	}

	@Test
	void aLockIsOnlyAKeptProperty() {
		Fills.Lock powered = new Fills.Lock(0, 0, 0, Map.of("powered", "true"));
		BlockState lever = Blocks.LEVER.defaultBlockState();
		BlockState locked = Fills.locked(lever, powered);
		assertTrue(locked.getValue(BlockStateProperties.POWERED));
		assertEquals(lever, Fills.unlocked(locked, lever, powered), "the unlock writes the template's value back");
		// a hopper's enabled is recomputed on a neighbour update: never a lock (the state is left as it is)
		BlockState hopper = Blocks.HOPPER.defaultBlockState();
		assertEquals(hopper, Fills.locked(hopper, new Fills.Lock(0, 0, 0, Map.of("enabled", "false"))));
	}

	@Test
	void oursWhileWithinItsDeclaration() {
		Map<String, Integer> declared = Map.of(COBBLE, 18, STICK, 1);
		assertTrue(Fills.within(Map.of(COBBLE, 18, STICK, 1), declared));
		assertTrue(Fills.within(Map.of(COBBLE, 10), declared), "the player emptied part of it: still ours");
		assertTrue(Fills.within(Map.of(), declared));
		assertFalse(Fills.within(Map.of(COBBLE, 19, STICK, 1), declared), "one more of its own item: cargo");
		assertFalse(Fills.within(Map.of(COBBLE, 18, "minecraft:dirt", 1), declared), "another item: cargo");
		// (the per-stack reads, plainCounts and holdsExactly, need bound item components: in game, fk-survival)
	}

	/** A ledger that paid the hall's blocks and its fill under its key (the fill billed under the target's credit key, F12). */
	static StockLedger paid(Map<String, Integer> blocks, Map<String, Integer> fill) {
		StockLedger l = new StockLedger();
		Map<String, Integer> all = new TreeMap<>(blocks);
		fill.forEach((k, v) -> all.merge(k, v, Integer::sum));
		all.forEach((k, v) -> {
			l.giveBack(Map.of(k, v), CAP, MAX);
			assertTrue(l.consume(k, v, CAP, MAX, new TreeMap<>()));
			l.pay(KEY, k, v);
		});
		l.markFilled(KEY);
		return l;
	}

	@Test
	void theCustodyRefundsWithTheBlocksOnceCappedByThePaidRecord() {
		StockLedger l = paid(Map.of(HOPPER, 1), Map.of(COBBLE, 18, STICK, 4));
		// the player took 8 cobblestone out of the filter hopper before the removal: the custody is what was left (min(actual, declared))
		l.holdCustody(KEY, Map.of(COBBLE, 10, STICK, 4));
		StockLedger.Credit c = l.credit(KEY, Map.of(HOPPER, 1), CAP, MAX);
		assertEquals(Map.of(HOPPER, 1, COBBLE, 10, STICK, 4), c.returned());
		assertTrue(l.custody(KEY).isEmpty(), "the custody went with the credit");
		assertFalse(l.filled(KEY), "the marker went with the credit");
		assertTrue(l.identityHolds());
		assertTrue(l.credit(KEY, Map.of(HOPPER, 1), CAP, MAX).already(), "credited once");
	}

	@Test
	void theCustodyIsCappedByThePaidRecord() {
		// a crash: the saved ledger paid the blocks but never the fill (the world got ahead): custody can't refund what was never charged
		StockLedger l = new StockLedger();
		l.giveBack(Map.of(HOPPER, 1), CAP, MAX);
		assertTrue(l.consume(HOPPER, 1, CAP, MAX, new TreeMap<>()));
		l.pay(KEY, HOPPER, 1);
		l.holdCustody(KEY, Map.of(COBBLE, 18));
		StockLedger.Credit c = l.credit(KEY, Map.of(HOPPER, 1), CAP, MAX);
		assertEquals(1, c.returned().values().stream().mapToInt(Integer::intValue).sum(), "never more than the record");
		assertTrue(l.identityHolds());
	}

	@Test
	void theMarkerAndTheCustodyAreSavedWithTheLedger() {
		StockLedger l = paid(Map.of(HOPPER, 1), Map.of(COBBLE, 18));
		l.holdCustody(KEY, Map.of(COBBLE, 18));
		StockLedger back = StockLedger.fromJson(JsonParser.parseString(l.toJson().toString()).getAsJsonObject());
		assertTrue(back.filled(KEY));
		assertEquals(Map.of(COBBLE, 18), back.custody(KEY));
		assertEquals(Map.of(COBBLE, 18), back.releaseCustody(KEY));
		assertTrue(back.custody(KEY).isEmpty());
		assertFalse(new StockLedger().toJson().has("filled"), "additive: absent when unused");
		assertFalse(new StockLedger().toJson().has("custody"));
	}
}
