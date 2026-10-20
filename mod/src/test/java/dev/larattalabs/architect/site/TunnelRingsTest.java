package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.BuildOrder;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LanternBlock;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.SlabType;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * 6c RS-b (docs/CONTRACT.md "Phase 6c slice RS" §6.2, §6.4, §7.2; HANDOFF-RS "The split", RS-b item 1): a tunnel's target builds ring by
 * ring along its bore, each ring's lining before the carve behind it; no cut before a paid cell above it or beside it within 1 (the broken
 * variant carveFirst caught); no cell before what blocks it in the builder (a run never waits on a later run); a run per ring within the
 * quarter cap.
 */
class TunnelRingsTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
	}

	/** A tunnel's cells: positions, states, held (the carve and the floor's held dirt path), costs. */
	private record T(long[] pos, BlockState[] st, BitSet held, List<List<SurvivalItems.Cost>> costs) {
	}

	private static final class B {
		final List<Long> pos = new ArrayList<>();
		final List<BlockState> st = new ArrayList<>();
		final BitSet held = new BitSet();

		void add(int x, int y, int z, BlockState s, boolean h) {
			if (h) {
				held.set(pos.size());
			}
			pos.add(BlockPos.asLong(x, y, z));
			st.add(s);
		}

		T done() {
			long[] p = pos.stream().mapToLong(Long::longValue).toArray();
			BlockState[] s = st.toArray(new BlockState[0]);
			List<List<SurvivalItems.Cost>> c = new ArrayList<>();
			for (int i = 0; i < s.length; i++) {
				c.add(held.get(i) ? List.of() : Cells.cost(RegionTargets.dry(s[i])));
			}
			return new T(p, s, held, c);
		}
	}

	/**
	 * rs04's shape along +x (x 0..len-1): a bed (cobblestone) and a held dirt-path floor, a 3x3 carve, cobblestone walls and roof, a hanging
	 * lantern under the roof every 6, a floor that steps up one (a bottom slab) half way, a portal arch of stone bricks past each end.
	 */
	private static T tunnel(int len, int z0) {
		B b = new B();
		for (int x = 0; x < len; x++) {
			int f = x < len / 2 ? 0 : 1; // the floor steps up one half way
			b.add(x, f, z0 + 1, Blocks.COBBLESTONE.defaultBlockState(), false); // bed
			for (int z = z0; z <= z0 + 2; z++) {
				b.add(x, f + 1, z, x == len / 2 ? Blocks.COBBLESTONE_SLAB.defaultBlockState().setValue(SlabBlock.TYPE, SlabType.BOTTOM) : Blocks.DIRT_PATH.defaultBlockState(), x != len / 2);
			}
			for (int y = f + 2; y <= f + 4; y++) {
				for (int z = z0; z <= z0 + 2; z++) {
					boolean lamp = x % 6 == 3 && y == f + 4 && z == z0 + 1;
					b.add(x, y, z, lamp ? Blocks.LANTERN.defaultBlockState().setValue(LanternBlock.HANGING, true) : Blocks.AIR.defaultBlockState(), !lamp);
				}
				b.add(x, y, z0 - 1, Blocks.COBBLESTONE.defaultBlockState(), false);
				b.add(x, y, z0 + 3, Blocks.COBBLESTONE.defaultBlockState(), false);
			}
			for (int z = z0 - 1; z <= z0 + 3; z++) {
				b.add(x, f + 5, z, Blocks.COBBLESTONE.defaultBlockState(), false);
			}
		}
		for (int x : new int[] {-1, len}) {
			int f = x < 0 ? 0 : 1;
			for (int y = f + 1; y <= f + 5; y++) {
				b.add(x, y, z0 - 1, Blocks.STONE_BRICKS.defaultBlockState(), false);
				b.add(x, y, z0 + 3, Blocks.STONE_BRICKS.defaultBlockState(), false);
			}
		}
		return b.done();
	}

	private static List<RegionTargets.Bore> along(int len, int z0) {
		return List.of(new RegionTargets.Bore(-1, 0, z0 + 1, 1, 0, 0, 0, z0 - 1, len - 1, 6, z0 + 3));
	}

	@Test
	void theBoreIsCarvedRingByRingBehindItsLining() {
		int len = 20;
		T t = tunnel(len, 10);
		RegionTargets.Order o = RegionTargets.order(t.pos(), t.st(), t.held(), t.costs(), 100, it -> 64, along(len, 10));
		assertEquals(t.pos().length, o.order().length);
		assertEquals(-1, RegionTargets.firstUnsafeCut(t.pos(), t.st(), t.held(), o.order()), "no carve before a paid cell above it or beside it within 1");
		assertEquals(-1, RegionTargets.firstLateBlocker(t.pos(), t.st(), t.held(), o.order()), "no cell before what blocks it in the builder");
		// ring by ring: a carve at x comes after every paid cell at x + 1 and before any paid cell at x + 2 (the lining one ring ahead)
		int n = t.pos().length;
		int[] at = new int[n];
		for (int r = 0; r < n; r++) {
			at[o.order()[r]] = r;
		}
		for (int i = 0; i < n; i++) {
			if (!t.held().get(i) || !t.st()[i].isAir()) {
				continue;
			}
			int x = BlockPos.of(t.pos()[i]).getX();
			for (int j = 0; j < n; j++) {
				if (t.costs().get(j).isEmpty()) {
					continue;
				}
				int xj = BlockPos.of(t.pos()[j]).getX();
				if (xj >= 0 && xj <= x + 1 && xj < len) {
					assertTrue(at[j] < at[i], "the lining at x " + xj + " before the carve at x " + x);
				}
				if (xj >= x + 2 && xj < len) {
					assertTrue(at[j] > at[i], "the carve at x " + x + " before the lining at x " + xj + " (ring by ring, not course by course)");
				}
			}
		}
		// a run per ring: every run's paid cells within two adjacent rings (its own lining, the carve behind it rides along)
		int start = 0;
		for (int end : o.ends()) {
			int lo = Integer.MAX_VALUE, hi = Integer.MIN_VALUE;
			for (int r = start; r < end; r++) {
				int i = o.order()[r];
				if (!t.costs().get(i).isEmpty()) {
					int x = Math.max(0, Math.min(len - 1, BlockPos.of(t.pos()[i]).getX()));
					lo = Math.min(lo, x);
					hi = Math.max(hi, x);
				}
			}
			assertTrue(lo == Integer.MAX_VALUE || hi - lo <= 1, "run [" + start + ", " + end + ") spans rings " + lo + ".." + hi);
			start = end;
		}
		assertTrue(o.ends().length >= len - 2, "about a run per ring: " + o.ends().length);
	}

	@Test
	void courseOrderOpensTheBoreBeforeItsRoof() {
		// the broken variant _unsafe.carveFirst (BuildOrder alone, bottom up): caught by both checks
		T t = tunnel(12, 0);
		int n = t.pos().length;
		int[] y = new int[n], kind = new int[n], sup = new int[n], pair = new int[n];
		for (int i = 0; i < n; i++) {
			y[i] = BlockPos.of(t.pos()[i]).getY();
			kind[i] = Builder.kind(t.st()[i]);
			sup[i] = -1;
			pair[i] = -1;
		}
		int[] naive = BuildOrder.order(y, kind, sup, pair);
		assertTrue(RegionTargets.firstUnsafeCut(t.pos(), t.st(), t.held(), naive) >= 0);
		assertTrue(RegionTargets.firstLateBlocker(t.pos(), t.st(), t.held(), naive) >= 0);
		// a hanging lantern before its roof: a late blocker
		RegionTargets.Order o = RegionTargets.order(t.pos(), t.st(), t.held(), t.costs(), 100, it -> 64, along(12, 0));
		int[] q = o.order().clone();
		int lamp = -1;
		for (int r = 0; r < n; r++) {
			if (t.st()[q[r]].is(Blocks.LANTERN)) {
				lamp = r;
				break;
			}
		}
		int[] moved = new int[n];
		moved[0] = q[lamp];
		for (int r = 0, k = 1; r < n; r++) {
			if (r != lamp) {
				moved[k++] = q[r];
			}
		}
		assertTrue(RegionTargets.firstLateBlocker(t.pos(), t.st(), t.held(), moved) >= 0, "a lantern before its roof is caught");
	}

	@Test
	void ringRunsStayWithinAQuarterOfTheCapacity() {
		int len = 16;
		T t = tunnel(len, 0);
		List<List<SurvivalItems.Cost>> big = new ArrayList<>();
		for (int i = 0; i < t.pos().length; i++) {
			big.add(t.held().get(i) ? List.of() : List.of(new SurvivalItems.Cost("minecraft:cobblestone", 64)));
		}
		for (int cap : new int[] {2, 5, 100}) {
			RegionTargets.Order o = RegionTargets.order(t.pos(), t.st(), t.held(), big, cap, it -> 64, along(len, 0));
			assertEquals(-1, RegionTargets.firstLateBlocker(t.pos(), t.st(), t.held(), o.order()));
			int start = 0;
			for (int end : o.ends()) {
				Map<String, Integer> bill = new TreeMap<>();
				for (int r = start; r < end; r++) {
					big.get(o.order()[r]).forEach(c -> bill.merge(c.item(), c.count(), Integer::sum));
				}
				assertTrue(RegionTargets.stacks(bill, it -> 64) <= cap, "run " + bill + " within " + cap + " stacks");
				start = end;
			}
			assertEquals(t.pos().length, start);
		}
	}

	@Test
	void twoBoresOneAfterTheOtherAndTheIrMember() {
		// two bores of one group (a plan's demo tunnels share a part): the first's rings, then the second's, each behind its lining
		T a = tunnel(8, 0), b = tunnel(8, 20);
		int n = a.pos().length + b.pos().length;
		long[] pos = new long[n];
		BlockState[] st = new BlockState[n];
		BitSet held = new BitSet();
		List<List<SurvivalItems.Cost>> costs = new ArrayList<>();
		for (T t : new T[] {a, b}) {
			int off = t == a ? 0 : a.pos().length;
			for (int i = 0; i < t.pos().length; i++) {
				// the second bore runs the other way: mirror its x
				BlockPos p = BlockPos.of(t.pos()[i]);
				pos[off + i] = t == a ? t.pos()[i] : BlockPos.asLong(7 - p.getX(), p.getY(), p.getZ());
				st[off + i] = t.st()[i];
				if (t.held().get(i)) {
					held.set(off + i);
				}
				costs.add(t.costs().get(i));
			}
		}
		var ir = JsonParser.parseString("{\"survival\":{\"format\":1,\"groups\":[\"bore\",\"x\"],\"bores\":["
			+ "{\"group\":\"bore\",\"from\":[-1,0,1],\"dir\":[1,0],\"box\":[0,0,-1,7,6,3]},"
			+ "{\"group\":\"bore\",\"from\":[8,0,21],\"dir\":[-1,0],\"box\":[0,0,19,7,6,23]},"
			+ "{\"group\":\"x\",\"from\":[0,0,0],\"dir\":[0,1],\"box\":[0,0,0,1,1,1]}]}}").getAsJsonObject();
		List<RegionTargets.Bore> bores = RegionTargets.bores(ir, "bore");
		assertEquals(2, bores.size());
		assertEquals(-1, bores.get(1).dx());
		assertEquals(0, RegionTargets.bores(ir, "none").size());
		assertEquals(0, RegionTargets.bores(JsonParser.parseString("{\"survival\":{\"groups\":[]}}").getAsJsonObject(), "bore").size());
		RegionTargets.Order o = RegionTargets.order(pos, st, held, costs, 100, it -> 64, bores);
		assertEquals(-1, RegionTargets.firstUnsafeCut(pos, st, held, o.order()));
		assertEquals(-1, RegionTargets.firstLateBlocker(pos, st, held, o.order()));
		// the second bore's first carve (at x 7, its start) after every cell of the first bore's lining
		int lastA = -1, firstBcarve = Integer.MAX_VALUE;
		for (int r = 0; r < n; r++) {
			int i = o.order()[r];
			if (i < a.pos().length && !held.get(i)) {
				lastA = Math.max(lastA, r);
			}
			if (i >= a.pos().length && held.get(i) && st[i].isAir()) {
				firstBcarve = Math.min(firstBcarve, r);
			}
		}
		assertTrue(lastA < firstBcarve, "bore by bore");
		int firstB = o.order()[firstBcarve];
		assertEquals(7, BlockPos.of(pos[firstB]).getX(), "the second bore carved from its own start (x 7, heading -x)");
	}

	@Test
	void noBoresKeepsTheCourseOrder() {
		T t = tunnel(10, 0);
		RegionTargets.Order a = RegionTargets.order(t.pos(), t.st(), t.held(), t.costs(), 100, it -> 64);
		RegionTargets.Order b = RegionTargets.order(t.pos(), t.st(), t.held(), t.costs(), 100, it -> 64, List.of());
		assertTrue(java.util.Arrays.equals(a.order(), b.order()) && java.util.Arrays.equals(a.ends(), b.ends()), "a target with no bore: today's order");
	}
}
