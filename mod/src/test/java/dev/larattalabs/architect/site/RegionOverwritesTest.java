package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.survival.SurvivalItems;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.StairBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (XR, docs/CONTRACT.md "Slice XR") Writers of a survival region over one cell: the owner rule ({@link RegionOverwrites#owner}: the latest
 * writer whose run matches what stands), {@link RegionOverwrites#retake} (a write takes up the owner's paid block and gives it back once)
 * and the shadow rule (an earlier writer that also matches counts and refunds nothing). Real {@link Builder.Run}s (costs through
 * {@code Cells.cost}, {@code matches} with soilSame, {@code refundCost}); the cell's world and the writers' order are modelled. The
 * independent expectation: every unit consumed is given back, or standing in exactly one paid cell (the audit and the removal's refund).
 */
class RegionOverwritesTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		AIR = initAIR(); BRICKS = initBRICKS(); PLANKS = initPLANKS(); COBBLE = initCOBBLE(); DIRT = initDIRT(); GRASS = initGRASS(); PATH = initPATH(); STAIR_E = initSTAIR_E(); STAIR_N = initSTAIR_N();
	}

	private static final BlockPos P = new BlockPos(3, 64, 5);
	private static final Anchors.Bounds BOX = new Anchors.Bounds(P.getX(), P.getY(), P.getZ(), P.getX(), P.getY(), P.getZ());

	/** A one-cell writer: its run (the cell's target, held: costs nothing), its order. */
	static RegionOverwrites.Live writer(String id, long order, BlockState target, boolean paid) {
		Map<Long, Journal.Value> v = Map.of(P.asLong(), WorldJournal.value(target));
		Cells cells = Cells.fromValues(BOX, v);
		Site s = new Site(id, "t", "none", BOX, BOX, Map.of(), order, Site.OVERWORLD, BOX, Builder.JOURNAL_TARGET, null, null,
			new Construction(Construction.BUILDING, new int[] {0}, Builder.JOURNAL_TARGET, null, new BitSet(), false, null));
		Builder.Run r = new Builder.Run(s, cells);
		if (!paid) {
			r.cost.set(0, List.of());
		}
		return new RegionOverwrites.Live(id, order, r, null);
	}

	/** The outcome of a chain of writes over one cell. */
	record Outcome(Map<String, Integer> consumed, Map<String, Integer> back, Map<String, Integer> standing, Map<String, Map<String, Integer>> backBy,
		BlockState world, int writes) {
		/** consumed - given back - standing, per item (empty: conserved). */
		Map<String, Integer> diff() {
			Map<String, Integer> d = new TreeMap<>(consumed);
			back.forEach((k, n) -> d.merge(k, -n, Integer::sum));
			standing.forEach((k, n) -> d.merge(k, -n, Integer::sum));
			d.values().removeIf(n -> n == 0);
			return d;
		}
	}

	/**
	 * The writers write in order, as the builders do: a writer whose run already matches the cell is built (it pays nothing, writes nothing);
	 * else it pays its cell's cost, takes up what stands ({@code retake} over the others, when not air) and writes its block; once written,
	 * a target's run is soilSame (BUILT). {@code shadow}: the owner rule in the audit (false: the broken variant, every matching writer
	 * counts). The audit (= the removal's refund): every paid writer matching the block standing, less the shadowed.
	 */
	static Outcome chain(BlockState start, List<RegionOverwrites.Live> ws, boolean shadow) {
		BlockState world = start;
		Map<String, Integer> consumed = new TreeMap<>(), back = new TreeMap<>();
		Map<String, Map<String, Integer>> backBy = new TreeMap<>();
		int writes = 0;
		ws = new ArrayList<>(ws);
		for (int wi = 0; wi < ws.size(); wi++) {
			// a target's journal before: what it found at its put-down (a writer is put down, then writes, in order)
			RegionOverwrites.Live w0 = ws.get(wi);
			// a lot ("L..."): its placement clears every queued cell and rebuilds it (it always writes; no journal before is read)
			boolean lot = w0.id().startsWith("L");
			RegionOverwrites.Live w = new RegionOverwrites.Live(w0.id(), w0.order(), w0.run(), null, lot ? null : Cells.fromValues(BOX, Map.of(P.asLong(),
				WorldJournal.value(world))));
			ws.set(wi, w);
			Builder.Run r = w.run();
			// the writers put down before this one (a writer is put down, then writes, in order)
			List<RegionOverwrites.Live> others = new ArrayList<>(ws.subList(0, wi));
			if (!lot && r.matches(world, 0)) {
				if (world.equals(r.target[0]) || RegionOverwrites.owner(RegionOverwrites.claims(others, P, world, null, null)) < 0) {
					// the same state (P1 skips a no-op write), or the world's own block: never queued, costs nothing
					r.cost.set(0, List.of());
				}
				r.markBuilt(0, true);
				continue;
			}
			for (SurvivalItems.Cost c : r.cost.get(0)) {
				consumed.merge(c.item(), c.count(), Integer::sum);
			}
			Map<String, Integer> got = RegionOverwrites.retake(others, P, world, (items, at) -> items.forEach((k, n) -> back.merge(k, n, Integer::sum)), P,
				w.id());
			if (!got.isEmpty()) {
				// whose: the owner of what stood
				List<RegionOverwrites.Live> who = new ArrayList<>();
				int t = RegionOverwrites.taken(RegionOverwrites.claims(others, P, world, who, null));
				backBy.computeIfAbsent(who.get(t).id(), x -> new TreeMap<>()).putAll(got);
			}
			world = r.target[0];
			r.markBuilt(0, true);
			r.soilSame = true;
			writes++;
		}
		Map<String, Integer> standing = new TreeMap<>();
		for (RegionOverwrites.Live w : ws) {
			if (!w.paid(0) || !w.run().matches(world, 0)) {
				continue;
			}
			List<RegionOverwrites.Live> others = new ArrayList<>(ws);
			others.remove(w);
			if (shadow && RegionOverwrites.shadowed(w.claim(0, world), RegionOverwrites.claims(others, P, world, null, null))) {
				continue;
			}
			w.run().refundCost(world, 0).forEach(c -> standing.merge(c.item(), c.count(), Integer::sum));
		}
		return new Outcome(consumed, back, standing, backBy, world, writes);
	}

	private static BlockState AIR;
	private static BlockState initAIR() { return Blocks.AIR.defaultBlockState(); }
	private static BlockState BRICKS;
	private static BlockState initBRICKS() { return Blocks.STONE_BRICKS.defaultBlockState(); }
	private static BlockState PLANKS;
	private static BlockState initPLANKS() { return Blocks.SPRUCE_PLANKS.defaultBlockState(); }
	private static BlockState COBBLE;
	private static BlockState initCOBBLE() { return Blocks.COBBLESTONE.defaultBlockState(); }
	private static BlockState DIRT;
	private static BlockState initDIRT() { return Blocks.DIRT.defaultBlockState(); }
	private static BlockState GRASS;
	private static BlockState initGRASS() { return Blocks.GRASS_BLOCK.defaultBlockState(); }
	private static BlockState PATH;
	private static BlockState initPATH() { return Blocks.DIRT_PATH.defaultBlockState(); }
	private static BlockState STAIR_E;
	private static BlockState initSTAIR_E() { return Blocks.STONE_BRICK_STAIRS.defaultBlockState().setValue(StairBlock.FACING, Direction.EAST); }
	private static BlockState STAIR_N;
	private static BlockState initSTAIR_N() { return Blocks.STONE_BRICK_STAIRS.defaultBlockState().setValue(StairBlock.FACING, Direction.NORTH); }

	private static Map<String, Integer> m(Object... kv) {
		Map<String, Integer> o = new TreeMap<>();
		for (int i = 0; i < kv.length; i += 2) {
			o.put((String) kv[i], (Integer) kv[i + 1]);
		}
		return o;
	}

	@Test
	void twoWritersTheLaterGivesTheEarliersBlockBack() {
		// XL's case: a route's paid dirt path (billed as dirt), then a bridge's deck of planks over it
		Outcome o = chain(AIR, List.of(writer("routes", 1, PATH, true), writer("links", 2, PLANKS, true)), true);
		assertEquals(Map.of(), o.diff(), "conserved");
		assertEquals(m("minecraft:dirt", 1), o.back(), "the path's dirt given back once");
		assertEquals(Map.of("routes", m("minecraft:dirt", 1)), o.backBy());
		assertEquals(m("minecraft:spruce_planks", 1), o.standing(), "the deck stands, its writer's");
	}

	@Test
	void threeWritersEachBlockComesBackOnceAndTheLastStands() {
		// A paid, B over A, C over B: A's block back at B's write, B's (the refund's taker, never A again) at C's
		Outcome o = chain(AIR, List.of(writer("a", 1, COBBLE, true), writer("b", 2, BRICKS, true), writer("c", 3, PLANKS, true)), true);
		assertEquals(Map.of(), o.diff());
		assertEquals(m("minecraft:cobblestone", 1, "minecraft:stone_bricks", 1), o.back());
		assertEquals(Map.of("a", m("minecraft:cobblestone", 1), "b", m("minecraft:stone_bricks", 1)), o.backBy());
		assertEquals(m("minecraft:spruce_planks", 1), o.standing(), "the removal refunds the final block, once");
	}

	@Test
	void aBlockGivenBackIsNeverGivenBackAgain() {
		// A-B-A: C writes A's block back over B. A's run matches again but owns nothing (it was given back at B's write): C owns it
		Outcome o = chain(AIR, List.of(writer("a", 1, COBBLE, true), writer("b", 2, BRICKS, true), writer("c", 3, COBBLE, true)), true);
		assertEquals(Map.of(), o.diff(), "conserved: " + o);
		assertEquals(m("minecraft:cobblestone", 1), o.standing(), "counted once (C's), not twice");
		// and a fourth over it: C's cobblestone goes back, not A's a second time
		Outcome o4 = chain(AIR, List.of(writer("a", 1, COBBLE, true), writer("b", 2, BRICKS, true), writer("c", 3, COBBLE, true), writer("d", 4, PLANKS,
			true)), true);
		assertEquals(Map.of(), o4.diff());
		assertEquals(Map.of("a", m("minecraft:cobblestone", 1), "b", m("minecraft:stone_bricks", 1), "c", m("minecraft:cobblestone", 1)), o4.backBy());
		// the broken variant (no shadow, every matching writer counts, as XL's audit and removal did): one cobblestone too many
		Outcome bad = chain(AIR, List.of(writer("a", 1, COBBLE, true), writer("b", 2, BRICKS, true), writer("c", 3, COBBLE, true)), false);
		assertEquals(m("minecraft:cobblestone", -1), bad.diff(), "the broken variant is caught");
	}

	@Test
	void theSameBlockInAnotherStateIsTheLaterWritersWithoutAWrite() {
		// B's stair faces north over A's stair facing east: B's run matches by block (built, pays nothing, writes nothing); A, its
		// writer, owns it and B is shadowed: one stair consumed, one standing
		Outcome o = chain(AIR, List.of(writer("a", 1, STAIR_E, true), writer("b", 2, STAIR_N, true)), true);
		assertEquals(0, o.writes() - 1, "only A wrote");
		assertEquals(Map.of(), o.diff());
		assertEquals(m("minecraft:stone_brick_stairs", 1), o.standing());
		assertEquals(Map.of(), o.back());
		Outcome bad = chain(AIR, List.of(writer("a", 1, STAIR_E, true), writer("b", 2, STAIR_N, true)), false);
		assertNotEquals(Map.of(), bad.diff(), "without the shadow both count it");
	}

	@Test
	void anOverwriteByAirGivesBackAndLeavesNothingStanding() {
		Outcome o = chain(AIR, List.of(writer("fill", 1, BRICKS, true), writer("cut", 2, AIR, false)), true);
		assertEquals(Map.of(), o.diff());
		assertEquals(m("minecraft:stone_bricks", 1), o.back());
		assertEquals(Map.of(), o.standing(), "the removal refunds nothing there");
	}

	@Test
	void soilOverSoilTheLaterOwnsIt() {
		// a paid dirt, then a paid grass over it: XL skipped the retake and counted both (soilSame); XR gives the dirt back and the grass's
		// writer owns the cell (the dirt's run still matches grass, soilSame, but is shadowed): the same sum, one owner
		Outcome o = chain(AIR, List.of(writer("a", 1, DIRT, true), writer("b", 2, GRASS, true)), true);
		assertEquals(Map.of(), o.diff());
		assertEquals(m("minecraft:dirt", 1), o.back());
		assertEquals(m("minecraft:dirt", 1), o.standing());
	}

	@Test
	void aHeldOrFreeCellGivesNothingBack() {
		// a held cell's block, then a paid target of the same block: it matches without writing, so it never paid: nobody counts it
		Outcome h = chain(AIR, List.of(writer("held", 1, BRICKS, false), writer("b", 2, BRICKS, true)), true);
		assertEquals(Map.of(), h.diff());
		assertEquals(Map.of(), h.standing());
		Outcome o = chain(AIR, List.of(writer("held", 1, BRICKS, false), writer("b", 2, PLANKS, true)), true);
		assertEquals(Map.of(), o.back(), "a held cell cost nothing");
		assertEquals(Map.of(), o.diff());
		// a free natural block in the world (no writer's) is never given back
		Outcome n = chain(COBBLE, List.of(writer("b", 2, PLANKS, true)), true);
		assertEquals(Map.of(), n.back());
	}

	@Test
	void theOwnerIsTheLatestMatchingClaim() {
		var a = new RegionOverwrites.Claim("a", 1, true, true, true);
		var b = new RegionOverwrites.Claim("b", 2, true, false, true);
		var c = new RegionOverwrites.Claim("c", 3, false, true, true);
		assertEquals(2, RegionOverwrites.owner(List.of(a, b, c)));
		assertEquals(-1, RegionOverwrites.taken(List.of(a, b, c)), "the owner's cell was free: nothing to give back");
		assertEquals(0, RegionOverwrites.taken(List.of(a, b)));
		assertEquals(-1, RegionOverwrites.owner(List.of(b)));
		assertTrue(RegionOverwrites.shadowed(a, List.of(b, c)));
		assertFalse(RegionOverwrites.shadowed(c, List.of(a, b)));
		// a later claim that matches without writing (the same block in another state) owns nothing while a writer matches
		var same = new RegionOverwrites.Claim("d", 4, true, true, false);
		assertEquals(0, RegionOverwrites.owner(List.of(a, same)));
		assertTrue(RegionOverwrites.shadowed(same, List.of(a)));
		assertFalse(RegionOverwrites.shadowed(a, List.of(same)));
		assertEquals(0, RegionOverwrites.owner(List.of(same)), "none writes: the latest that matches");
		// a tie in order: by id
		assertEquals(1, RegionOverwrites.owner(List.of(new RegionOverwrites.Claim("x1", 5, true, true, true), new RegionOverwrites.Claim("x2", 5, true, true, true))));
	}

	@Test
	void everyChainOfUpToFourWritersConserves() {
		BlockState[] blocks = {AIR, BRICKS, PLANKS, COBBLE, DIRT, GRASS, PATH, STAIR_E, STAIR_N};
		int n = 0;
		for (int len = 1; len <= 4; len++) {
			int combos = (int) Math.pow(blocks.length * 2, len);
			for (int code = 0; code < combos; code++) {
				for (int v = 0; v < 4; v++) {
					BlockState start = v % 2 == 0 ? AIR : DIRT;
					boolean lots = v >= 2; // every second writer a lot
					List<RegionOverwrites.Live> ws = new ArrayList<>();
					int c = code;
					for (int i = 0; i < len; i++) {
						int k = c % (blocks.length * 2);
						c /= blocks.length * 2;
						ws.add(writer((lots && i % 2 == 1 ? "L" : "w") + i, i + 1, blocks[k / 2], k % 2 == 0));
					}
					Outcome o = chain(start, ws, true);
					assertEquals(Map.of(), o.diff(), () -> "chain " + ws.stream().map(w -> w.run().target[0] + (w.paid(0) ? "" : " (free)")).toList() + " over "
						+ start + ": " + o);
					n++;
				}
			}
		}
		assertTrue(n > 10_000, "chains checked: " + n);
	}
}
