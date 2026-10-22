package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.region.Packed;
import dev.larattalabs.architect.survival.BuildOrder;
import dev.larattalabs.architect.survival.StockLedger;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 6c RS (docs/CONTRACT.md "Phase 6c slice RS" §6, §9, §13 item 1): a target's build order (a carve after its lining, the broken variant
 * carveFirst caught), its runs (a course each, at most a quarter of the stockpile's capacity in stacks), ARTL v2's classes and groups,
 * the lava scoop (never a bucket minted; once per key; the broken variants lavaRefund and loseCredit caught by the per-item sum).
 */
class RegionTargetsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** A 3-wide bore 3 high along x (x 0..9, y 1..3, z 1..3): the carve held, the lining (floor, walls, roof) paid. */
	private record Bore(long[] pos, BlockState[] st, BitSet held, List<List<SurvivalItems.Cost>> costs) {
	}

	private static Bore bore() {
		List<Long> pos = new ArrayList<>();
		List<BlockState> st = new ArrayList<>();
		BitSet held = new BitSet();
		for (int x = 0; x < 10; x++) {
			for (int y = 0; y <= 4; y++) {
				for (int z = 0; z <= 4; z++) {
					boolean inside = y >= 1 && y <= 3 && z >= 1 && z <= 3;
					boolean lining = !inside;
					if (inside) {
						held.set(pos.size());
						st.add(Blocks.AIR.defaultBlockState());
					} else if (lining) {
						st.add(Blocks.STONE_BRICKS.defaultBlockState());
					}
					pos.add(BlockPos.asLong(x, y, z));
				}
			}
		}
		long[] p = pos.stream().mapToLong(Long::longValue).toArray();
		BlockState[] s = st.toArray(new BlockState[0]);
		List<List<SurvivalItems.Cost>> c = new ArrayList<>();
		for (int i = 0; i < s.length; i++) {
			c.add(held.get(i) ? List.of() : Cells.cost(s[i]));
		}
		return new Bore(p, s, held, c);
	}

	@Test
	void theCarveComesAfterItsLining() {
		Bore b = bore();
		RegionTargets.Order o = RegionTargets.order(b.pos(), b.st(), b.held(), b.costs(), 100, it -> 64);
		assertEquals(-1, RegionTargets.firstUnsafeCut(b.pos(), b.st(), b.held(), o.order()), "no carve before the paid cells above and beside it");
		assertEquals(b.pos().length, o.order().length);
		// the broken variant _unsafe.carveFirst: BuildOrder alone (bottom up) opens the bore before its roof: caught
		int n = b.pos().length;
		int[] y = new int[n], kind = new int[n], sup = new int[n], pair = new int[n];
		for (int i = 0; i < n; i++) {
			y[i] = BlockPos.of(b.pos()[i]).getY();
			kind[i] = Builder.kind(b.st()[i]);
			sup[i] = -1;
			pair[i] = -1;
		}
		int[] naive = BuildOrder.order(y, kind, sup, pair);
		assertTrue(RegionTargets.firstUnsafeCut(b.pos(), b.st(), b.held(), naive) >= 0, "carveFirst is caught");
	}

	@Test
	void runsAreCoursesWithinAQuarterOfTheCapacity() {
		Bore b = bore();
		RegionTargets.Order o = RegionTargets.order(b.pos(), b.st(), b.held(), b.costs(), 100, it -> 64);
		// every run's bill within the cap; with a cap of 1 stack (64 bricks) the 10-long courses (at most 30 bricks) still fit whole
		for (int cap : new int[] {1, 100}) {
			RegionTargets.Order oc = RegionTargets.order(b.pos(), b.st(), b.held(), b.costs(), cap, it -> 64);
			int start = 0;
			for (int end : oc.ends()) {
				Map<String, Integer> bill = new TreeMap<>();
				for (int r = start; r < end; r++) {
					b.costs().get(oc.order()[r]).forEach(c -> bill.merge(c.item(), c.count(), Integer::sum));
				}
				assertTrue(RegionTargets.stacks(bill, it -> 64) <= Math.max(1, cap), "run [" + start + ", " + end + ") " + bill + " within " + cap + " stacks");
				start = end;
			}
			assertEquals(b.pos().length, start);
		}
		assertTrue(o.ends().length >= 5, "a run per course at least: " + o.ends().length);
		// a cap smaller than a course cuts it
		List<List<SurvivalItems.Cost>> big = new ArrayList<>();
		for (int i = 0; i < b.pos().length; i++) {
			big.add(b.held().get(i) ? List.of() : List.of(new SurvivalItems.Cost("minecraft:stone_bricks", 64)));
		}
		RegionTargets.Order ob = RegionTargets.order(b.pos(), b.st(), b.held(), big, 2, it -> 64);
		int start = 0;
		for (int end : ob.ends()) {
			int stacks = 0;
			for (int r = start; r < end; r++) {
				stacks += big.get(ob.order()[r]).isEmpty() ? 0 : 1;
			}
			assertTrue(stacks <= 2, "a cut course within 2 stacks: " + stacks);
			start = end;
		}
		assertTrue(ob.ends().length > o.ends().length);
	}

	@Test
	void stacksCountWholeStacks() {
		assertEquals(0, RegionTargets.stacks(Map.of(), it -> 64));
		assertEquals(2, RegionTargets.stacks(Map.of("a", 65), it -> 64));
		assertEquals(3, RegionTargets.stacks(Map.of("a", 64, "b", 2), it -> it.equals("b") ? 1 : 64));
	}

	/** An ARTL v2 payload of one section: two cells of one state, classes held and paid, groups 3 and 7. */
	@Test
	void artlVersion2CarriesClassesAndGroups() {
		ByteArrayOutputStream o = new ByteArrayOutputStream();
		o.writeBytes("ARTL".getBytes(StandardCharsets.US_ASCII));
		o.write(2);
		o.write(0);
		o.write(0);
		o.write(0);
		o.write(1); // sections
		o.write(0); // sx zigzag
		o.write(8); // sy 4
		o.write(0); // sz
		o.write(1); // palette
		byte[] id = "minecraft:stone".getBytes(StandardCharsets.UTF_8);
		o.write(id.length);
		o.writeBytes(id);
		o.write(2); // cells
		o.write(0x01);
		o.write(0x00); // pos 1
		o.write(0x02);
		o.write(0x00); // pos 2
		o.write(Packed.HELD);
		o.write(Packed.PAID);
		o.write(3);
		o.write(0);
		o.write(7);
		o.write(0);
		Packed.Tile t = Packed.decode(o.toByteArray());
		assertTrue(t.survival());
		assertArrayEquals(new byte[] {Packed.HELD, Packed.PAID}, t.cls());
		assertArrayEquals(new int[] {3, 7}, t.group());
		assertEquals(BlockPos.asLong(1, 64, 0), t.pos()[0]);
	}

	@Test
	void theLavaScoopNeverMintsABucketAndCreditsOnce() {
		StockLedger l = new StockLedger();
		l.giveBack(Map.of("minecraft:bucket", 2), 81, it -> 64);
		Map<String, Integer> over = new TreeMap<>();
		StockLedger.Credit c = Stockpiles.scoopInto(l, "region:rg1@1:fluids", 3, 1, 27 * 3, it -> it.endsWith("bucket") ? 16 : 64, over);
		assertEquals(Map.of("minecraft:lava_bucket", 2, "minecraft:iron_bars", 1), c.returned(), "two buckets, two lava buckets: the third source drains");
		assertEquals(0, l.stock("minecraft:bucket"));
		assertEquals(2, l.stock("minecraft:lava_bucket"));
		StockLedger.Credit again = Stockpiles.scoopInto(l, "region:rg1@1:fluids", 3, 1, 27 * 3, it -> 64, over);
		assertTrue(again.already(), "a resumed removal credits nothing again");
		assertEquals(2, l.stock("minecraft:lava_bucket"));
		// the per-item sum over the bucket family (bucket + lava bucket) and the bars: the scoop keeps it (3 = 2 + the 1 lava standing before)
		// the broken variant _unsafe.lavaRefund: a lava refund without the scoop (credited, no bucket consumed) mints a bucket: caught
		StockLedger bad = new StockLedger();
		bad.giveBack(Map.of("minecraft:bucket", 2), 81, it -> 64);
		bad.credit("bad", Map.of("minecraft:lava_bucket", 2), 81, it -> 64);
		assertEquals(4, bad.stock("minecraft:bucket") + bad.stock("minecraft:lava_bucket"), "two buckets minted");
		assertEquals(2, l.stock("minecraft:bucket") + l.stock("minecraft:lava_bucket"), "the scoop's sum is the buckets it had");
		// the broken variant _unsafe.loseCredit: a refund without its key (giveBack twice for one removal) credits twice: caught by the key
		StockLedger k = new StockLedger();
		k.credit("road:c5@9", Map.of("minecraft:stone_bricks", 4), 81, it -> 64);
		k.credit("road:c5@9", Map.of("minecraft:stone_bricks", 4), 81, it -> 64);
		assertEquals(4, k.stock("minecraft:stone_bricks"), "keyed: once");
		StockLedger u = new StockLedger();
		u.giveBack(Map.of("minecraft:stone_bricks", 4), 81, it -> 64);
		u.giveBack(Map.of("minecraft:stone_bricks", 4), 81, it -> 64);
		assertEquals(8, u.stock("minecraft:stone_bricks"), "unkeyed: twice (the broken variant)");
	}

	@Test
	void aTargetsRecordCarriesItsRegionPartAndHeldCells() {
		Bore b = bore();
		List<dev.larattalabs.architect.journal.Journal.Value> vals = new ArrayList<>();
		for (BlockState s : b.st()) {
			vals.add(dev.larattalabs.architect.journal.WorldJournal.value(s));
		}
		RegionTargets.Group g = new RegionTargets.Group(2, "bore", b.pos(), vals.toArray(new dev.larattalabs.architect.journal.Journal.Value[0]), b.held());
		Infra i = RegionTargets.record(null, "c9", "architect:path", "test:rs", null, new Site.Member("g1", "b1", "t:forms:path:0,0"), "minecraft:overworld", "rg1",
			g, "rg1|forms|path|0,0");
		assertTrue(RegionTargets.is(i));
		assertEquals("rg1", RegionTargets.regionOf(i));
		assertEquals("bore", RegionTargets.partOf(i));
		assertEquals("rg1", i.ext().get(RegionTargets.EXT_REGION).getAsString());
		assertEquals("bore", i.ext().get(RegionTargets.EXT_PART).getAsString());
		assertNotNull(i.construction());
		assertTrue(i.construction().building());
		assertNull(i.construction().crate(), "no crate: the owner's stockpile");
		assertEquals(b.pos().length, i.construction().size());
		assertEquals(b.held().cardinality(), RegionTargets.spec(i).get("heldCells").getAsInt());
		assertTrue(i.placing(), "placing until P8");
	}
}
