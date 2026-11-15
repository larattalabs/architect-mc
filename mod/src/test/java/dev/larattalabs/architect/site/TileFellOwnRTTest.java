package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayDeque;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.server.Bootstrap;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (RT) The tile writer's felling (C31) never takes a log the region built. PAY P2 S3: the ground stage's retaining wall
 * ({@code monastery_retain}, spruce logs over natural grass, as evalTile has them) stood; a later stage's path tile wrote a fence
 * (ALWAYS_OURS) over one of its logs; that write seeded a felling which flooded the whole connected wall to air within the tile's
 * window (231 cells, 40 open drops). The kit has no felling, so the realised cells must equal evalTile's: the wall stays. The flood
 * here walks the same seed and neighbour decisions TileCheck.trees does (26-connected), over a small map world.
 */
class TileFellOwnRTTest {
	@BeforeAll
	static void boot() {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		LOG = Blocks.SPRUCE_LOG.defaultBlockState();
		GRASS = Blocks.GRASS_BLOCK.defaultBlockState();
		AIR = Blocks.AIR.defaultBlockState();
	}

	// (set after the bootstrap: a static initializer would touch the registries first)
	private static BlockState LOG;
	private static BlockState GRASS;
	private static BlockState AIR;

	/** A log (unit tests bind no tags, so TileCheck.treeLog's {@code #logs} read is the block itself here). */
	private static boolean log(BlockState s) {
		return s.is(Blocks.SPRUCE_LOG);
	}

	/** A tiny world: the cells written so far, grass below y 0 and air above, the region's own cells and another owner's. */
	private static final class World {
		final Long2ObjectOpenHashMap<BlockState> at = new Long2ObjectOpenHashMap<>();
		final LongOpenHashSet ours = new LongOpenHashSet();
		final LongOpenHashSet others = new LongOpenHashSet();

		BlockState get(long p) {
			BlockState s = at.get(p);
			return s != null ? s : BlockPos.getY(p) < 0 ? GRASS : AIR;
		}

		/** One tile: writes each cell (ALWAYS: the condition is not under test), then fells as TileCheck does; the felled cells. */
		LongOpenHashSet tile(Long2ObjectOpenHashMap<BlockState> cells, boolean region) {
			LongArrayList logs = new LongArrayList();
			for (var e : cells.long2ObjectEntrySet()) {
				if (TileCheck.fellsFrom(log(get(e.getLongKey())), ours.contains(e.getLongKey()))) {
					logs.add(e.getLongKey());
				}
			}
			ArrayDeque<Long> flood = new ArrayDeque<>(logs);
			LongOpenHashSet seen = new LongOpenHashSet(logs);
			LongOpenHashSet felled = new LongOpenHashSet();
			while (!flood.isEmpty()) {
				long q = flood.poll();
				for (int dx = -1; dx <= 1; dx++) {
					for (int dy = -1; dy <= 1; dy++) {
						for (int dz = -1; dz <= 1; dz++) {
							long np = BlockPos.asLong(BlockPos.getX(q) + dx, BlockPos.getY(q) + dy, BlockPos.getZ(q) + dz);
							if (!seen.add(np) || !log(get(np))) {
								continue;
							}
							if (TileCheck.fellStops(others.contains(np), ours.contains(np), false, false, true) != null) {
								continue;
							}
							flood.add(np);
							if (!cells.containsKey(np)) {
								felled.add(np);
							}
						}
					}
				}
			}
			for (var e : cells.long2ObjectEntrySet()) {
				at.put(e.getLongKey(), e.getValue());
				if (region) {
					ours.add(e.getLongKey());
				}
			}
			for (long f : felled) {
				at.put(f, AIR);
				if (region) {
					ours.add(f);
				}
			}
			return felled;
		}
	}

	private static long p(int x, int y, int z) {
		return BlockPos.asLong(x, y, z);
	}

	/** The retaining wall: a run of logs two high, sunk one into the grass (as monastery_retain's front at x 3627). */
	private static Long2ObjectOpenHashMap<BlockState> wall() {
		Long2ObjectOpenHashMap<BlockState> w = new Long2ObjectOpenHashMap<>();
		for (int z = 0; z < 9; z++) {
			w.put(p(0, -1, z), LOG);
			w.put(p(0, 0, z), LOG);
		}
		return w;
	}

	@Test
	void aLaterWriteOverTheRegionsOwnLogFellsNothing() {
		World w = new World();
		Long2ObjectOpenHashMap<BlockState> ground = wall();
		assertTrue(w.tile(ground, true).isEmpty(), "the ground stage over grass fells nothing");
		Long2ObjectOpenHashMap<BlockState> route = new Long2ObjectOpenHashMap<>();
		route.put(p(0, 0, 8), Blocks.SPRUCE_FENCE.defaultBlockState()); // routes_monastery's fence over the wall's end log
		assertTrue(w.tile(route, true).isEmpty(), "a write over the region's own log is no felling");
		// the realised cells equal evalTile's model: every wall cell but the fenced one stays a log
		for (var e : ground.long2ObjectEntrySet()) {
			BlockState want = route.containsKey(e.getLongKey()) ? route.get(e.getLongKey()) : e.getValue();
			assertEquals(want, w.get(e.getLongKey()), "the wall cell " + BlockPos.of(e.getLongKey()));
		}
	}

	@Test
	void aNaturalTrunkTouchingTheWallGoesAndTheWallStays() {
		World w = new World();
		w.tile(wall(), true);
		for (int y = 1; y <= 5; y++) {
			w.at.put(p(1, y, 4), LOG); // a grown trunk leaning on the wall (diagonal to its top at (0, 0, 4))
		}
		Long2ObjectOpenHashMap<BlockState> cut = new Long2ObjectOpenHashMap<>();
		cut.put(p(1, 3, 4), AIR);
		LongOpenHashSet felled = w.tile(cut, true);
		assertEquals(4, felled.size(), "the trunk's other logs go: " + felled);
		for (long q : wall().keySet()) {
			assertEquals(LOG, w.get(q), "the wall cell " + BlockPos.of(q));
		}
	}

	@Test
	void aPlainNaturalTrunkStillGoesWhole() {
		World w = new World();
		for (int y = 0; y <= 6; y++) {
			w.at.put(p(5, y, 5), LOG);
		}
		Long2ObjectOpenHashMap<BlockState> cut = new Long2ObjectOpenHashMap<>();
		cut.put(p(5, 0, 5), Blocks.STONE.defaultBlockState());
		assertEquals(6, w.tile(cut, true).size(), "C31: a trunk any of whose logs the tile changes goes whole");
	}

	@Test
	void theDecisions() {
		assertFalse(TileCheck.fellsFrom(true, true), "the region's own log seeds nothing");
		assertTrue(TileCheck.fellsFrom(true, false), "a grown log seeds a felling");
		assertFalse(TileCheck.fellsFrom(false, false), "no log");
		assertEquals("owned", TileCheck.fellStops(true, true, false, false, true), "another owner's first (a cell both ours and theirs)");
		assertEquals(TileCheck.OURS, TileCheck.fellStops(false, true, true, true, true));
		assertEquals("build", TileCheck.fellStops(false, false, true, true, true));
		assertEquals("protected", TileCheck.fellStops(false, false, false, true, true));
		assertEquals("player", TileCheck.fellStops(false, false, false, false, false));
		assertNull(TileCheck.fellStops(false, false, false, false, true));
	}
}
