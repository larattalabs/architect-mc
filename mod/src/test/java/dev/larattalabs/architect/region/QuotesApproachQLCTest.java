package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Approach;
import dev.larattalabs.architect.placement.TerrainFit;
import dev.larattalabs.architect.site.EntranceStyle;
import dev.larattalabs.architect.site.QuoteLand;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (QL-c) A quote plans a lot's entrance approach over the land the plan's roads and earlier tiles leave (QuoteLand), so it plans the approach
 * the realise plans: the review's probes (a hut joining a planned gravel road, a path tile that shortens the approach, tiles that lower the land
 * in front of the lot) and farmland of another moisture, which the realise neither writes nor pays.
 */
class QuotesApproachQLCTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
		GRASS = Blocks.GRASS_BLOCK.defaultBlockState();
		GRAVEL = Blocks.GRAVEL.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
	}

	/** The template's box; its door faces south at x 4.5, feet 11 (ApproachTest's fixture). Row i is z = 9 + i. */
	static final Anchors.Bounds BOX = new Anchors.Bounds(0, 10, 0, 9, 19, 9);
	static final int FEET = 11;
	static BlockState GRASS, GRAVEL, AIR;

	/** Grass up to y 10, air above: the land now. */
	static final EntranceStyle.StateAt NOW = (x, y, z) -> y <= 10 ? GRASS : AIR;

	/** A world as the quote reads it: {@code base}, with {@code land} on top outside the box's columns. */
	static EntranceStyle.StateAt over(QuoteLand land, EntranceStyle.StateAt base) {
		return (x, y, z) -> {
			BlockState p = land.outsideOf(BOX, x, y, z);
			return p != null ? p : base.at(x, y, z);
		};
	}

	/** The approach of the hut over {@code at}, its roads {@code roads} and, with {@code tiles}, the region ground they are. */
	static Approach.Plan plan(EntranceStyle.StateAt at, LongOpenHashSet roads, LongOpenHashSet tiles) {
		TerrainFit.World w = (x, y, z) -> {
			int f = TerrainFit.flags(at.at(x, y, z));
			return roads.contains(BlockPos.asLong(x, y, z)) ? f | TerrainFit.ROAD : f;
		};
		Approach.Surface s = EntranceStyle.surface(EmptyBlockGetter.INSTANCE, at, roads, !tiles.isEmpty(), tiles::contains);
		return Approach.plan(BOX, "south", 4.5, 4.5, FEET, Approach.Spec.DEFAULT, w, new Approach.Style("minecraft:dirt_path", null, s));
	}

	/** A road's surface cells across row {@code row} (y 10). */
	static Long2ObjectOpenHashMap<BlockState> road(int row, BlockState st) {
		Long2ObjectOpenHashMap<BlockState> m = new Long2ObjectOpenHashMap<>();
		for (int x = -6; x <= 15; x++) {
			m.put(BlockPos.asLong(x, 10, 9 + row), st);
		}
		return m;
	}

	/** An approachGround entry: per cell its writes [state, cond, walk] (one seq for every listed cell). */
	static JsonObject ground(List<int[]> cells, Object[]... writes) {
		JsonArray seq = new JsonArray();
		for (Object[] w : writes) {
			JsonArray e = new JsonArray();
			e.add((String) w[0]);
			e.add((Integer) w[1]);
			e.add((Integer) w[2]);
			seq.add(e);
		}
		JsonArray seqs = new JsonArray();
		seqs.add(seq);
		ByteBuffer b = ByteBuffer.allocate(cells.size() * 20).order(ByteOrder.LITTLE_ENDIAN);
		for (int[] c : cells) {
			b.putInt(c[0]).putInt(c[2]).putInt(c[1]).putInt(c[1]).putInt(0);
		}
		JsonObject o = new JsonObject();
		o.add("seqs", seqs);
		o.addProperty("runs", Base64.getEncoder().encodeToString(b.array()));
		return o;
	}

	/**
	 * CellCond.passes's rule over the test's blocks (the unit registry binds no tags, so the natural rule is spelled out: grass, dirt, stone):
	 * IF_AIR_OR_FLUID over air, ALWAYS_OURS over the region's own or natural, the others over natural.
	 */
	static final Quotes.Cond COND = (c, now, ours) -> {
		boolean natural = now.is(Blocks.GRASS_BLOCK) || now.is(Blocks.DIRT) || now.is(Blocks.STONE);
		return switch (c) {
			case Packed.IF_AIR_OR_FLUID -> now.isAir();
			case Packed.ALWAYS_OURS -> ours || natural;
			default -> natural;
		};
	};

	static Quotes.LandOf landOf(Long2ObjectOpenHashMap<BlockState> roads, JsonObject lotGround) {
		JsonObject all = new JsonObject();
		if (lotGround != null) {
			all.add("hut", lotGround);
		}
		return new Quotes.Land(roads, all, "p1").of("hut", (x, y, z) -> NOW.at(x, y, z), COND);
	}

	static LongOpenHashSet keys(Long2ObjectOpenHashMap<BlockState> m) {
		return new LongOpenHashSet(m.keySet());
	}

	@Test
	void aPlannedGravelRoadIsJoinedAsGravel() {
		// the review's probe: the hut joins a planned gravel road 4 rows out over grass. Read over the land now, the road's cells are grass and
		// the 9-cell approach takes grass (billed as dirt); the realise finds the road's gravel there and lays 9 gravel
		Long2ObjectOpenHashMap<BlockState> road = road(4, GRAVEL);
		Approach.Plan before = plan(NOW, keys(road), new LongOpenHashSet());
		assertTrue(before.pathBlock().startsWith("minecraft:grass_block"), "the land now: the road's cells are grass: " + before.pathBlock());
		Quotes.LandOf lo = landOf(road, null);
		assertNull(lo.gap());
		Approach.Plan quote = plan(EntranceStyle.withLand(lo.land(), NOW), keys(road), new LongOpenHashSet());
		Approach.Plan realise = plan((x, y, z) -> road.containsKey(BlockPos.asLong(x, y, z)) ? GRAVEL : NOW.at(x, y, z), keys(road), new LongOpenHashSet());
		assertEquals("minecraft:gravel", quote.pathBlock());
		assertEquals(9, quote.pathCount());
		assertEquals(realise.pathBlock(), quote.pathBlock());
		assertArrayEquals(realise.path(), quote.path());
		assertEquals(0, lo.land().tilesTouching(quote), "roads only: no tile changes the approach (exact)");
	}

	@Test
	void aPathTileThatShortensTheApproachShortensTheQuote() {
		// a gravel road 7 rows out: 6 rows, 18 gravel over the land now. A path tile of the plan lays a gravel walk across row 4 (over the grass,
		// IF_NATURAL): the realise stops there (its walk cells are road cells, Roads.roadCells), 3 rows, 9 gravel
		Long2ObjectOpenHashMap<BlockState> road = road(7, GRAVEL);
		Approach.Plan now = plan(EntranceStyle.withLand(landOf(road, null).land(), NOW), keys(road), new LongOpenHashSet());
		assertEquals(18, now.pathCount());
		List<int[]> walk = new ArrayList<>();
		for (int x = -6; x <= 15; x++) {
			walk.add(new int[] {x, 10, 13});
		}
		Quotes.LandOf lo = landOf(road, ground(walk, new Object[] {"minecraft:gravel", 0, 1}));
		assertNull(lo.gap());
		assertEquals(walk.size(), lo.walk().size());
		LongOpenHashSet roads = keys(road);
		roads.addAll(lo.walk());
		Approach.Plan quote = plan(over(lo.land(), NOW), roads, lo.land().tiles());
		assertEquals(3, quote.rows());
		assertEquals(9, quote.pathCount());
		assertEquals("minecraft:gravel", quote.pathBlock());
		assertTrue(lo.land().tilesTouching(quote) > 0, "the tiles change the approach's land: the quote names it inexact");
	}

	@Test
	void tilesThatLowerTheLandGiveTheRealisesLongerApproach() {
		// QL-b's leftover: the plan's tiles cut the grass in front of the lot two blocks down (y 9 and 10 to air, IF_NATURAL). Over the land now
		// the approach is 6 level rows; the realise steps down to the cut and plans more cells. The quote now plans the realise's approach
		List<int[]> cut = new ArrayList<>();
		for (int x = -6; x <= 15; x++) {
			for (int z = 10; z <= 40; z++) {
				cut.add(new int[] {x, 9, z});
				cut.add(new int[] {x, 10, z});
			}
		}
		Long2ObjectOpenHashMap<BlockState> none = new Long2ObjectOpenHashMap<>();
		Approach.Plan flat = plan(NOW, new LongOpenHashSet(), new LongOpenHashSet());
		Quotes.LandOf lo = landOf(none, ground(cut, new Object[] {"minecraft:air", 0, 0}));
		assertNull(lo.gap());
		Approach.Plan quote = plan(over(lo.land(), NOW), new LongOpenHashSet(), lo.land().tiles());
		EntranceStyle.StateAt after = (x, y, z) -> z >= 10 && (y == 9 || y == 10) ? AIR : NOW.at(x, y, z);
		Approach.Plan realise = plan(after, new LongOpenHashSet(), new LongOpenHashSet(cut.stream().mapToLong(c -> BlockPos.asLong(c[0], c[1], c[2])).toArray()));
		assertTrue(quote.changed() > flat.changed(), "the lowered land's approach is bigger than the flat one: " + quote.changed() + " vs " + flat.changed());
		assertArrayEquals(realise.path(), quote.path());
		assertArrayEquals(realise.slabs(), quote.slabs());
		assertArrayEquals(realise.fill(), quote.fill());
		assertArrayEquals(realise.feet(), quote.feet());
		assertTrue(lo.land().tilesTouching(quote) > 0);
	}

	@Test
	void aTileSkipsARoadsCellAndAnUnreadableCellIsAGap() {
		Long2ObjectOpenHashMap<BlockState> road = road(4, GRAVEL);
		Quotes.LandOf lo = landOf(road, ground(List.of(new int[] {4, 10, 13}), new Object[] {"minecraft:stone", 0, 0}));
		assertEquals(GRAVEL, lo.land().at(4, 10, 13), "held by the road: the tile skips it");
		assertTrue(lo.land().tiles().isEmpty());
		JsonObject all = new JsonObject();
		all.add("hut", ground(List.of(new int[] {900, 10, 13}), new Object[] {"minecraft:stone", 0, 0}));
		Quotes.LandOf gap = new Quotes.Land(new Long2ObjectOpenHashMap<>(), all, "p1").of("hut", (x, y, z) -> x > 100 ? null : NOW.at(x, y, z), COND);
		assertNotNull(gap.gap(), "a chunk not loaded: the approach's land is not known");
		Quotes.LandOf old = new Quotes.Land(new Long2ObjectOpenHashMap<>(), null, "p1").of("hut", (x, y, z) -> NOW.at(x, y, z), (c, now, ours) -> true);
		assertNotNull(old.gap(), "a plan made before QL-c: named");
		JsonObject capped = new JsonObject();
		JsonObject c = new JsonObject();
		c.addProperty("capped", 20000);
		capped.add("hut", c);
		assertNotNull(new Quotes.Land(new Long2ObjectOpenHashMap<>(), capped, "p1").of("hut", (x, y, z) -> NOW.at(x, y, z), (q, now, ours) -> true).gap());
	}

	@Test
	void anAlwaysOursWriteAfterTheRegionsOwnWritePasses() {
		// cond 3 (ALWAYS_OURS) over planks an earlier write of the plan laid (IF_AIR_OR_FLUID over the air): the region's own, so it passes, as
		// TileCheck's `ours` lets it; over a player's planks (no earlier write) it would not
		Quotes.LandOf lo = landOf(new Long2ObjectOpenHashMap<>(), ground(List.of(new int[] {4, 11, 13}), new Object[] {"minecraft:oak_planks", 2, 0},
			new Object[] {"minecraft:stone", 3, 0}));
		assertEquals(Blocks.STONE.defaultBlockState(), lo.land().at(4, 11, 13));
		assertTrue(lo.land().tiles().contains(BlockPos.asLong(4, 11, 13)));
		assertTrue(!COND.passes(3, Blocks.OAK_PLANKS.defaultBlockState(), false), "not ours: planks fail ALWAYS_OURS");
	}

	/** The world now with incidental cobblestone (a player's placed block, not a kept build) across row 4 at x 3..5, y 10. */
	static Quotes.Reads cobbled(boolean kept) {
		return new Quotes.Reads() {
			boolean cobble(int x, int y, int z) {
				return z == 13 && y == 10 && x >= 3 && x <= 5;
			}

			@Override
			public BlockState at(int x, int y, int z) {
				return cobble(x, y, z) ? Blocks.COBBLESTONE.defaultBlockState() : NOW.at(x, y, z);
			}

			@Override
			public boolean kept(int x, int y, int z) {
				return kept && cobble(x, y, z);
			}

			@Override
			public boolean incidental(int x, int y, int z) {
				return !kept && cobble(x, y, z);
			}
		};
	}

	@Test
	void aWalkOverIncidentalPlayerBlocksIsDecidedAsTheRealiseDecidesIt() {
		// the GPT review's probe: a dirt road 7 rows out, a planned 3-cell gravel walk (IF_NATURAL) across row 4 over incidental cobblestone.
		// CellCond alone skips the walk (cobblestone is not natural): 18 dirt. TileCheck passes an incidental cell (passesIncidental): the realise
		// lays the walk, joins it and lays 9 gravel. The quote decides it through the same Realised.decideCell
		Long2ObjectOpenHashMap<BlockState> road = road(7, Blocks.DIRT.defaultBlockState());
		JsonObject all = new JsonObject();
		all.add("hut", ground(List.of(new int[] {3, 10, 13}, new int[] {4, 10, 13}, new int[] {5, 10, 13}), new Object[] {"minecraft:gravel", 0, 1}));
		Quotes.LandOf lo = new Quotes.Land(road, all, "p1").of("hut", cobbled(false), COND);
		assertNull(lo.gap());
		assertEquals(0, lo.undecided());
		assertEquals(3, lo.walk().size(), "the incidental cells are written");
		LongOpenHashSet roads = keys(road);
		roads.addAll(lo.walk());
		Approach.Plan quote = plan(over(lo.land(), (x, y, z) -> cobbled(false).at(x, y, z)), roads, lo.land().tiles());
		assertEquals(3, quote.rows());
		assertEquals(9, quote.pathCount());
		assertEquals("minecraft:gravel", quote.pathBlock());
		assertTrue(lo.land().tilesTouching(quote) > 0);
	}

	@Test
	void aWalkOverAKeptBuildIsPlannedBothWays() {
		// the same walk over a kept build's cobblestone: the realise writes it only when its consent names the build, which a quote does not know.
		// Both lands come back: without the walk (the road at row 7: 18 dirt) and with it (9 gravel); the lot bills the larger of each item
		Long2ObjectOpenHashMap<BlockState> road = road(7, Blocks.DIRT.defaultBlockState());
		JsonObject all = new JsonObject();
		all.add("hut", ground(List.of(new int[] {3, 10, 13}, new int[] {4, 10, 13}, new int[] {5, 10, 13}), new Object[] {"minecraft:gravel", 0, 1}));
		Quotes.LandOf lo = new Quotes.Land(road, all, "p1").of("hut", cobbled(true), COND);
		assertEquals(3, lo.undecided());
		assertNotNull(lo.ifWritten());
		assertTrue(lo.walk().isEmpty(), "no consent: a build's cells are kept");
		LongOpenHashSet r1 = keys(road);
		Approach.Plan without = plan(over(lo.land(), (x, y, z) -> cobbled(true).at(x, y, z)), r1, lo.land().tiles());
		assertEquals(18, without.pathCount());
		assertTrue(without.pathBlock().startsWith("minecraft:dirt"), without.pathBlock());
		LongOpenHashSet r2 = keys(road);
		r2.addAll(lo.ifWritten().walk());
		Approach.Plan with = plan(over(lo.ifWritten().land(), (x, y, z) -> cobbled(true).at(x, y, z)), r2, lo.ifWritten().land().tiles());
		assertEquals(9, with.pathCount());
		assertEquals("minecraft:gravel", with.pathBlock());
	}

	@Test
	void farmlandOfAnotherMoistureIsNotBilled() {
		// the review's probe: a paid field cell planned moisture 7 over moisture-0 farmland: TileCheck queues it (another state), the run marks it
		// built (Builder.Run#matches: the block) unwritten and unpaid. The quote leaves it out (0), as it leaves out a cell of the same state
		BlockState dry = Blocks.FARMLAND.defaultBlockState().setValue(net.minecraft.world.level.block.state.properties.BlockStateProperties.MOISTURE, 0);
		ByteBuffer b = ByteBuffer.allocate(12).order(ByteOrder.LITTLE_ENDIAN);
		b.putInt(0).putInt(64).putInt(0);
		JsonObject row = new JsonObject();
		row.addProperty("state", "minecraft:farmland[moisture=7]");
		JsonObject its = new JsonObject();
		its.addProperty("minecraft:dirt", 1);
		row.add("items", its);
		row.addProperty("cells", Base64.getEncoder().encodeToString(b.array()));
		JsonArray a = new JsonArray();
		a.add(row);
		JsonObject t = new JsonObject();
		t.add("field", a);
		Quotes.Standing s = Quotes.standing(t, (x, y, z) -> dry);
		assertEquals(1, s.offCells());
		assertEquals(Map.of("minecraft:dirt", 0), s.terrain());
		// another block is still written and paid: dirt where the plan writes farmland
		Quotes.Standing d = Quotes.standing(t, (x, y, z) -> Blocks.DIRT.defaultBlockState());
		assertEquals(0, d.offCells());
		assertEquals(Map.of("minecraft:dirt", 1), d.terrain());
	}
}
