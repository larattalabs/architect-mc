package dev.larattalabs.architect.site;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.survival.BuildOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import net.minecraft.SharedConstants;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.Holder;
import net.minecraft.core.MappedRegistry;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.Identifier;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.block.Block;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.Bootstrap;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (8a TO, docs/CONTRACT.md "Phase 8a" §3, §7 row 2) The terrain order ({@link BuildOrder#forTerrain} through
 * {@link RegionTargets#terrainOrder}, the path slice ST calls) as property tests over committed plans realised in survival (BF x01-x03,
 * F1's spire and ice spikes, F3's grove, a terrace; kit/test/terrain-order-cells.mjs exports their cells with node) and a few synthetic
 * cases: every prefix of the order is connected, no loose or resting block goes in over nothing, no leaf goes in where no standing log
 * holds it, cuts go top down and first. Each part is checked as one target and as its tile targets in feed order (each tile's connected
 * prefix built, the rest ordered again once more stands: what ST does with {@link BuildOrder.Terrain#connected}).
 */
class TerrainOrderTest {
	static final Path KIT = Path.of("../kit");

	/** Boots and binds the block tags the order reads (leaves, logs, and the natural ones site-solid reads), as NaturalDriftTest does. */
	@BeforeAll
	static void boot() throws Exception {
		SharedConstants.tryDetectVersion();
		Bootstrap.bootStrap();
		JsonObject fx = JsonParser.parseString(java.nio.file.Files.readString(KIT.resolve("test/fixtures/natural/conds.json"))).getAsJsonObject();
		Map<TagKey<Block>, List<Holder<Block>>> tags = new HashMap<>();
		for (var e : fx.getAsJsonObject("tags").entrySet()) {
			List<Holder<Block>> hs = new ArrayList<>();
			for (var id : e.getValue().getAsJsonArray()) {
				BuiltInRegistries.BLOCK.get(Identifier.parse(id.getAsString())).ifPresent(hs::add);
			}
			tags.put(TagKey.create(Registries.BLOCK, Identifier.parse(e.getKey())), hs);
		}
		((MappedRegistry<Block>) BuiltInRegistries.BLOCK).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.BLOCK, tags)).apply();
		assertTrue(Blocks.OAK_LEAVES.defaultBlockState().is(BlockTags.LEAVES) && Blocks.SPRUCE_WOOD.defaultBlockState().is(BlockTags.LOGS));
	}

	@AfterAll
	static void unbind() {
		((MappedRegistry<Block>) BuiltInRegistries.BLOCK).prepareTagReload(new net.minecraft.tags.TagLoader.LoadResult<>(Registries.BLOCK, Map.of())).apply();
	}

	/** One fixture's cells: per cell its position, after, before, group and tile; the land's solid cells; the floating anchors. */
	record Fx(String id, long[] pos, BlockState[] after, BlockState[] before, int[] group, int[] tile, int groups, Set<Long> solid, List<long[]> floating) {
	}

	static Fx load(String fixture, String prefix) throws Exception {
		List<String> cmd = new ArrayList<>(List.of("node", KIT.resolve("test/terrain-order-cells.mjs").toString(), fixture));
		if (prefix != null) {
			cmd.add(prefix);
		}
		Process p;
		try {
			p = new ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.DISCARD).start();
		} catch (java.io.IOException e) {
			Assumptions.abort("node is not on the PATH: " + e.getMessage());
			return null;
		}
		String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
		assertTrue(p.waitFor(120, TimeUnit.SECONDS) && p.exitValue() == 0, fixture + ": the export failed");
		JsonObject j = JsonParser.parseString(out).getAsJsonObject();
		JsonArray st = j.getAsJsonArray("states");
		BlockState[] states = new BlockState[st.size()];
		for (int i = 0; i < states.length; i++) {
			states[i] = BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, st.get(i).getAsString(), false).blockState();
		}
		JsonArray cells = j.getAsJsonArray("cells");
		int n = cells.size();
		long[] pos = new long[n];
		BlockState[] after = new BlockState[n], before = new BlockState[n];
		int[] group = new int[n], tile = new int[n];
		for (int i = 0; i < n; i++) {
			JsonArray c = cells.get(i).getAsJsonArray();
			pos[i] = BlockPos.asLong(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt());
			after[i] = states[c.get(3).getAsInt()];
			before[i] = states[c.get(4).getAsInt()];
			group[i] = c.get(5).getAsInt();
			tile[i] = c.get(6).getAsInt();
		}
		Set<Long> solid = new HashSet<>();
		for (var e : j.getAsJsonArray("solid")) {
			JsonArray c = e.getAsJsonArray();
			solid.add(BlockPos.asLong(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()));
		}
		List<long[]> floating = new ArrayList<>();
		for (var e : j.getAsJsonArray("floating")) {
			JsonArray c = e.getAsJsonArray();
			floating.add(new long[] {BlockPos.asLong(c.get(0).getAsInt(), c.get(1).getAsInt(), c.get(2).getAsInt()), c.get(3).getAsInt()});
		}
		return new Fx(fixture, pos, after, before, group, tile, j.getAsJsonArray("groups").size(), solid, floating);
	}

	/** What the property checks found over one fixture. */
	static final class Tally {
		int cells, cuts, leaves, loose, rest, rounds, reordered;
	}

	/**
	 * Build {@code fx}'s cells of each group target by target ({@code byTile}: its tiles in feed order; else the whole group), each
	 * target's connected prefix at a time, and check every cell as it goes in against the world as it stands (independently of the
	 * order's own rules). Returns the tally; fails on any broken rule or on a stall (cells nothing ever reaches).
	 */
	static Tally build(Fx fx, boolean byTile) {
		Tally t = new Tally();
		int n = fx.pos().length;
		Map<Long, Integer> at = new HashMap<>(n * 2);
		Map<Long, BlockState> world = new HashMap<>(n * 2);
		for (int i = 0; i < n; i++) {
			at.put(fx.pos()[i], i);
			world.put(fx.pos()[i], fx.before()[i]);
		}
		java.util.function.Function<BlockPos, BlockState> land = p -> {
			BlockState s = world.get(p.asLong());
			return s != null ? s : fx.solid().contains(p.asLong()) ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		};
		boolean[] built = new boolean[n];
		boolean[] rooted = new boolean[n];
		for (int g = 0; g < fx.groups(); g++) {
			// the group's targets, in feed order
			Map<Integer, List<Integer>> targets = new java.util.TreeMap<>();
			for (int i = 0; i < n; i++) {
				if (fx.group()[i] == g) {
					targets.computeIfAbsent(byTile ? fx.tile()[i] : 0, k -> new ArrayList<>()).add(i);
				}
			}
			List<BlockPos> floating = new ArrayList<>();
			for (long[] f : fx.floating()) {
				if (f[1] == g) {
					floating.add(BlockPos.of(f[0]));
				}
			}
			boolean seeded = floating.isEmpty();
			List<List<Integer>> pending = new ArrayList<>(targets.values());
			while (!pending.isEmpty()) {
				t.rounds++;
				boolean progress = false;
				List<List<Integer>> next = new ArrayList<>();
				for (List<Integer> cells : pending) {
					int m = cells.size();
					long[] pos = new long[m];
					BlockState[] after = new BlockState[m], before = new BlockState[m];
					for (int k = 0; k < m; k++) {
						pos[k] = fx.pos()[cells.get(k)];
						after[k] = fx.after()[cells.get(k)];
						before[k] = fx.before()[cells.get(k)];
					}
					BuildOrder.Terrain o = RegionTargets.terrainOrder(pos, after, before, land, floating);
					int[] perm = o.order().clone();
					Arrays.sort(perm);
					for (int k = 0; k < m; k++) {
						assertEquals(k, perm[k], fx.id() + ": a permutation");
					}
					for (int r = 0; r < o.connected(); r++) {
						int i = cells.get(o.order()[r]);
						boolean cut = r < o.cuts();
						assertEquals(cut, fx.after()[i].isAir(), fx.id() + ": the cuts first");
						check(fx, i, at, land, built, rooted, floating, seeded, t);
						seeded |= !cut;
						built[i] = true;
						world.put(fx.pos()[i], fx.after()[i]);
						if (fx.after()[i].is(BlockTags.LEAVES)) {
							rooted[i] = true;
						}
					}
					prefixStands(fx, g, at, built, floating);
					progress |= o.connected() > 0;
					if (o.connected() < m) {
						List<Integer> left = new ArrayList<>();
						for (int r = o.connected(); r < m; r++) {
							left.add(cells.get(o.order()[r]));
						}
						next.add(left);
						t.reordered += left.size();
					}
				}
				assertTrue(progress, fx.id() + " group " + g + (byTile ? " by tile" : "") + ": " + next.stream().mapToInt(List::size).sum()
					+ " cells nothing reaches");
				pending = next;
			}
		}
		for (int i = 0; i < n; i++) {
			assertTrue(built[i], fx.id() + ": every cell built");
		}
		t.cells = n;
		return t;
	}

	/**
	 * The built set as a whole (not only each cell as it came): every built fill of group {@code g} (resting blocks aside) is joined
	 * through built fills to what stays: the land, a cell that was solid and stays solid (an unbuilt fill over solid, or a built one
	 * that replaced solid), or a floating anchor's 3x3. An unbuilt cut still standing counts for nothing: it is going.
	 */
	static void prefixStands(Fx fx, int g, Map<Long, Integer> at, boolean[] built, List<BlockPos> floating) {
		int n = fx.pos().length;
		boolean[] reached = new boolean[n];
		java.util.ArrayDeque<Integer> q = new java.util.ArrayDeque<>();
		for (int i = 0; i < n; i++) {
			if (!built[i] || fx.group()[i] != g || !bears(fx, i)) {
				continue;
			}
			BlockPos p = BlockPos.of(fx.pos()[i]);
			boolean root = Builder.anchorState(fx.before()[i]);
			for (Direction d : Direction.values()) {
				long k = p.relative(d).asLong();
				Integer j = at.get(k);
				root |= j == null ? fx.solid().contains(k) : !built[j] && !fx.after()[j].isAir() && Builder.anchorState(fx.before()[j]);
			}
			for (BlockPos f : floating) {
				root |= Math.abs(p.getX() - f.getX()) <= 1 && Math.abs(p.getZ() - f.getZ()) <= 1 && p.getY() == f.getY() - 1;
			}
			if (root) {
				reached[i] = true;
				q.add(i);
			}
		}
		while (!q.isEmpty()) {
			BlockPos p = BlockPos.of(fx.pos()[q.poll()]);
			for (Direction d : Direction.values()) {
				Integer j = at.get(p.relative(d).asLong());
				if (j != null && built[j] && !reached[j] && bears(fx, j)) {
					reached[j] = true;
					q.add(j);
				}
			}
		}
		for (int i = 0; i < n; i++) {
			if (built[i] && fx.group()[i] == g && bears(fx, i)) {
				assertTrue(reached[i], fx.id() + ": " + BlockPos.of(fx.pos()[i]).toShortString() + " hangs in the built set");
			}
		}
	}

	/** A built cell that joins others: not a cut, not a resting block. */
	static boolean bears(Fx fx, int i) {
		BlockState a = fx.after()[i];
		return !a.isAir() && !(Builder.kind(a) == BuildOrder.ATTACHABLE && !a.is(BlockTags.LEAVES));
	}

	/** The rules a cell must meet as it goes in, read off the world as it stands. */
	static void check(Fx fx, int i, Map<Long, Integer> at, java.util.function.Function<BlockPos, BlockState> land, boolean[] built, boolean[] rooted,
		List<BlockPos> floating, boolean seeded, Tally t) {
		BlockPos p = BlockPos.of(fx.pos()[i]);
		BlockState a = fx.after()[i];
		String where = fx.id() + ": " + p.toShortString() + " " + a;
		if (a.isAir()) {
			// top down: the cell above, when it is a cut of these cells, is gone already
			Integer up = at.get(p.above().asLong());
			assertTrue(up == null || !fx.after()[up].isAir() || built[up], where + ": a cut under a standing cut");
			t.cuts++;
			return;
		}
		if (Builder.gravity(a) || Builder.kind(a) == BuildOrder.ATTACHABLE && !a.is(BlockTags.LEAVES)) {
			BlockState under = land.apply(p.below());
			assertTrue(Builder.anchorState(under) && Builder.kind(under) != BuildOrder.ATTACHABLE, where + ": over " + under);
			if (Builder.gravity(a)) {
				t.loose++;
			} else {
				t.rest++;
			}
			return;
		}
		if (a.is(BlockTags.LEAVES)) {
			t.leaves++;
			// no orphan leaf: next to a standing log, or a leaf already held by one (land leaves are held by their own logs)
			boolean held = false;
			for (Direction d : Direction.values()) {
				BlockPos q = p.relative(d);
				Integer j = at.get(q.asLong());
				BlockState s = land.apply(q);
				held |= s.is(BlockTags.LOGS) || s.is(BlockTags.LEAVES) && (j == null || rooted[j]);
			}
			assertTrue(held, where + ": an orphan leaf");
			return;
		}
		// connected: it replaces a solid cell, touches solid land, a log or a leaf, or seeds a floating form under its anchor
		boolean ok = Builder.anchorState(fx.before()[i]);
		for (Direction d : Direction.values()) {
			BlockState s = land.apply(p.relative(d));
			ok |= Builder.anchorState(s) || s.is(BlockTags.LOGS) || s.is(BlockTags.LEAVES);
		}
		for (BlockPos f : floating) {
			ok |= !seeded && Math.abs(p.getX() - f.getX()) <= 1 && Math.abs(p.getZ() - f.getZ()) <= 1 && p.getY() == f.getY() - 1;
		}
		assertTrue(ok, where + ": not connected when it comes");
	}

	static void both(String fixture, String prefix, int atLeast) throws Exception {
		Fx fx = load(fixture, prefix);
		assertTrue(fx.pos().length >= atLeast, fixture + ": " + fx.pos().length + " cells");
		Tally whole = build(fx, false);
		assertEquals(0, whole.reordered, fixture + ": one target per part reaches every cell in one order");
		Tally tiles = build(fx, true);
		System.out.printf("TO %s: %d cells (%d cuts, %d leaves, %d loose, %d resting); by tile %d rounds, %d cells ordered again%n", fixture, whole.cells,
			whole.cuts, whole.leaves, whole.loose, whole.rest, tiles.rounds, tiles.reordered);
	}

	@Test
	void bfX01HollowMountain() throws Exception {
		both("bf/x01_hollow_mountain.json", null, 30000);
	}

	@Test
	void bfX02CraterLake() throws Exception {
		// its cut and fill are held (the lake's shell is paid): the order covers them as the part's cells
		both("bf/x02_crater_lake.json", "f_", 4000);
	}

	@Test
	void bfX03FloatingIsland() throws Exception {
		both("bf/x03_island_hamlet.json", null, 7000);
	}

	@Test
	void f1SpireAndIceSpikes() throws Exception {
		both("valid/v04_rock_spire.json", "f_", 500);
		both("valid/v05_ice_spike.json", null, 1000);
	}

	@Test
	void f3GroveTreesAndMushrooms() throws Exception {
		// F3's trees are billed in survival (class 2), so the export takes the forms' parts by name: the order covers them too
		both("valid/v72_f3_grove.json", "f_", 9000);
	}

	@Test
	void terrace() throws Exception {
		both("valid/v06_terrace.json", "f_", 1000);
	}

	// ------------------------------------------------------------------ synthetic cases

	static BlockState st(String s) throws Exception {
		return BlockStateParser.parseForBlock(BuiltInRegistries.BLOCK, s, false).blockState();
	}

	/** A synthetic target over flat stone (y <= 64 solid): its cells' order, by position. */
	static List<String> order(Map<BlockPos, String> cells, Set<BlockPos> solidLand, List<BlockPos> floating, int[] connectedOut) throws Exception {
		int n = cells.size();
		long[] pos = new long[n];
		BlockState[] after = new BlockState[n], before = new BlockState[n];
		List<BlockPos> keys = new ArrayList<>(cells.keySet());
		for (int i = 0; i < n; i++) {
			pos[i] = keys.get(i).asLong();
			after[i] = st(cells.get(keys.get(i)));
			before[i] = after[i].isAir() ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
		BuildOrder.Terrain o = RegionTargets.terrainOrder(pos, after, before, p -> solidLand.contains(p) ? Blocks.STONE.defaultBlockState()
			: Blocks.AIR.defaultBlockState(), floating);
		connectedOut[0] = o.connected();
		List<String> out = new ArrayList<>();
		for (int i : o.order()) {
			out.add(keys.get(i).toShortString());
		}
		return out;
	}

	static Set<BlockPos> ground(int y) {
		Set<BlockPos> s = new HashSet<>();
		for (int x = -8; x <= 8; x++) {
			for (int z = -8; z <= 8; z++) {
				s.add(new BlockPos(x, y, z));
			}
		}
		return s;
	}

	// ------------------------------------------------------------------ (8a ST, GPT review P1 1, 4, 5) the live rule

	/** {@link RegionTargets#supportRule} over a map of the world (absent: air; {@code unloaded}: no chunk), no target cell built. */
	static int rule(BlockPos p, String after, String was, String now, Map<BlockPos, String> world, Set<BlockPos> unloaded, List<BlockPos> floating)
		throws Exception {
		Map<BlockPos, BlockState> w = new HashMap<>();
		for (var e : world.entrySet()) {
			w.put(e.getKey(), st(e.getValue()));
		}
		return RegionTargets.supportRule(p, st(after), was == null ? null : st(was), st(now), o -> unloaded.contains(o) ? null : w.getOrDefault(o,
			Blocks.AIR.defaultBlockState()), o -> false, o -> false, o -> false, floating);
	}

	@Test
	void aLeafNeedsALogNeverTheGround() throws Exception {
		BlockPos p = new BlockPos(0, 65, 0);
		Map<BlockPos, String> world = new HashMap<>();
		world.put(p.below(), "minecraft:stone");
		String leaf = "minecraft:oak_leaves[persistent=true,distance=1]";
		assertEquals(RegionTargets.MANDATORY, rule(p, leaf, null, "minecraft:air", world, Set.of(), List.of()), "a leaf on stone with no log waits");
		world.put(p.east(), "minecraft:oak_log");
		assertEquals(RegionTargets.READY, rule(p, leaf, null, "minecraft:air", world, Set.of(), List.of()), "beside a standing log it goes in");
		world.remove(p.east());
		world.put(p.east(), "minecraft:oak_leaves[persistent=false,distance=2]");
		assertEquals(RegionTargets.READY, rule(p, leaf, null, "minecraft:air", world, Set.of(), List.of()), "beside a leaf a log holds");
		world.put(p.east(), "minecraft:oak_leaves[persistent=true,distance=7]");
		assertEquals(RegionTargets.MANDATORY, rule(p, leaf, null, "minecraft:air", world, Set.of(), List.of()), "not beside a leaf no log holds");
		// TO's order too: one leaf over solid ground, no log anywhere, is never connected
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		c.put(p, leaf);
		int[] k = {0};
		order(c, ground(64), List.of(), k);
		assertEquals(0, k[0], "forTerrain: a leaf with no log is not connected");
	}

	@Test
	void aLeafGoesInOnlyWhereVanillaHoldsIt() throws Exception {
		BlockPos p = new BlockPos(0, 65, 0);
		Map<BlockPos, String> world = new HashMap<>();
		String free = "minecraft:oak_leaves[persistent=false,distance=6]";
		world.put(p.east(), "minecraft:oak_leaves[persistent=false,distance=6]");
		assertEquals(RegionTargets.MANDATORY, rule(p, free, null, "minecraft:air", world, Set.of(), List.of()),
			"beside a leaf at distance 6 a non-persistent leaf would be at 7 and decay: it waits");
		world.put(p.east(), "minecraft:oak_leaves[persistent=false,distance=5]");
		assertEquals(RegionTargets.READY, rule(p, free, null, "minecraft:air", world, Set.of(), List.of()), "at 5 it would be at 6: held");
		// TO's land: a leaf beside a logless external leaf (distance 7) is not connected
		assertEquals(BuildOrder.LAND_NONE, RegionTargets.terrainLand(st("minecraft:oak_leaves[persistent=true,distance=7]")));
		assertEquals(BuildOrder.LAND_NONE, RegionTargets.terrainLand(st("minecraft:oak_leaves[persistent=false,distance=6]")));
		assertEquals(BuildOrder.LAND_LEAF, RegionTargets.terrainLand(st("minecraft:oak_leaves[persistent=false,distance=2]")));
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		c.put(p, "minecraft:oak_leaves[persistent=true,distance=1]");
		int n = 1;
		long[] pos = {p.asLong()};
		BlockState[] after = {st(c.get(p))}, before = {Blocks.AIR.defaultBlockState()};
		BlockState logless = st("minecraft:oak_leaves[persistent=true,distance=7]");
		BuildOrder.Terrain o = RegionTargets.terrainOrder(pos, after, before, q -> q.equals(p.west()) ? logless : Blocks.AIR.defaultBlockState(), List.of());
		assertEquals(0, o.connected(), "forTerrain: a logless external leaf holds nothing");
		assertEquals(1, n);
	}

	@Test
	void anUnknownSupportIsReadByLoadingItsChunk() throws Exception {
		// a loaded, isolated fill at a chunk's edge: five air neighbours, the sixth in a chunk not loaded (stone there)
		BlockPos p = new BlockPos(15, 66, 0);
		BlockState stone = Blocks.STONE.defaultBlockState(), air = Blocks.AIR.defaultBlockState();
		java.util.function.Function<BlockPos, BlockState> loaded = o -> o.getX() >= 16 ? null : air;
		java.util.function.Function<BlockPos, BlockState> disk = o -> o.getX() >= 16 ? stone : air;
		int[] none = {0};
		assertEquals(RegionTargets.UNKNOWN, RegionTargets.supportRule(p, stone, null, air, RegionTargets.loadingWorld(loaded, disk, none), o -> false, o -> false,
			o -> false, List.of()), "with no load allowed: unknown (the rule before: a wait for ever)");
		int[] one = {1};
		assertEquals(RegionTargets.READY, RegionTargets.supportRule(p, stone, null, air, RegionTargets.loadingWorld(loaded, disk, one), o -> false, o -> false,
			o -> false, List.of()), "its chunk loaded to read it: supported");
		assertEquals(0, one[0], "one load spent");
	}

	@Test
	void aFailedBarrierNeverCompletesOnTheNextTurn() {
		RegionTargets.Plan pl = new RegionTargets.Plan(0L, new java.util.BitSet(), new int[] {1}, null);
		int[] calls = {0};
		assertFalse(RegionTargets.mayComplete(pl, 1000, () -> {
			calls[0]++;
			return false;
		}), "a failed save: still building");
		assertFalse(RegionTargets.mayComplete(pl, 1001, () -> {
			calls[0]++;
			return true;
		}), "the next turn does not complete without a barrier");
		assertEquals(1, calls[0], "nor tries one before the retry");
		assertTrue(RegionTargets.mayComplete(pl, 1000 + RegionTargets.DURABLE_RETRY, () -> {
			calls[0]++;
			return true;
		}), "a later successful barrier completes it");
		assertEquals(2, calls[0]);
	}

	@Test
	void roundFourPersistentLeafRewriteAndThrowingBarrier() throws Exception {
		// a persistent leaf (it never decays) beside a leaf a log holds at distance 6: it goes in (round 3's rule kept it waiting for ever)
		BlockPos p = new BlockPos(0, 65, 0);
		Map<BlockPos, String> world = new HashMap<>();
		world.put(p.east(), "minecraft:oak_leaves[persistent=false,distance=6]");
		assertEquals(RegionTargets.READY, rule(p, "minecraft:oak_leaves[persistent=true,distance=7]", null, "minecraft:air", world, Set.of(), List.of()));
		// a written leaf a neighbour changed (its distance), or a waterlogged leaf planned dry, is set to its planned state: our own block
		BlockState planned = st("minecraft:oak_leaves[persistent=true,distance=1,waterlogged=false]");
		assertTrue(RegionTargets.mayReplace(false, st("minecraft:oak_leaves[persistent=true,distance=4,waterlogged=false]"), planned, false, () -> false),
			"a volatile property's drift (distance) is ours");
		assertTrue(RegionTargets.mayReplace(false, st("minecraft:oak_leaves[persistent=false,distance=1,waterlogged=false]"), planned, true, () -> false),
			"a cell this run wrote is ours whatever its state");
		assertFalse(RegionTargets.mayReplace(false, st("minecraft:cobblestone"), planned, true, () -> false), "a player's block is not ours to replace");
		assertTrue(RegionTargets.mayReplace(true, st("minecraft:cobblestone"), planned, false, () -> false), "the tile's planned before is");
		// (round 5, GPT check P2) another writer's block of the same type in another state is not ours (round 4's block-type rule took it)
		BlockState logY = st("minecraft:oak_log[axis=y]");
		assertFalse(RegionTargets.mayReplace(false, st("minecraft:oak_log[axis=x]"), logY, false, () -> false), "a foreign oak_log[axis=x] is left alone");
		assertTrue(RegionTargets.mayReplace(false, st("minecraft:oak_log[axis=x]"), logY, true, () -> false), "the same cell, written by this run, is ours");
		// a barrier that throws takes the same retry delay as one that fails
		RegionTargets.Plan pl = new RegionTargets.Plan(0L, new java.util.BitSet(), new int[] {1}, null);
		int[] calls = {0};
		assertFalse(RegionTargets.mayComplete(pl, 500, () -> {
			calls[0]++;
			throw new IllegalStateException("injected flush failure");
		}));
		assertFalse(RegionTargets.mayComplete(pl, 501, () -> {
			calls[0]++;
			return true;
		}), "no barrier on the next turn after a throw");
		assertEquals(1, calls[0]);
	}

	@Test
	void mandatoryRulesAreNotReleasableAndUnloadedSupportIsUnknown() throws Exception {
		BlockPos p = new BlockPos(0, 66, 0);
		// a loose block over air: mandatory (release never writes it), over an unloaded chunk: unknown
		assertEquals(RegionTargets.MANDATORY, rule(p, "minecraft:sand", null, "minecraft:air", Map.of(), Set.of(), List.of()));
		assertEquals(RegionTargets.UNKNOWN, rule(p, "minecraft:sand", null, "minecraft:air", Map.of(), Set.of(p.below()), List.of()));
		// a fill nothing reaches: the only releasable wait; with a neighbour in an unloaded chunk: unknown (no release on a missing chunk)
		assertEquals(RegionTargets.UNREACHED, rule(p, "minecraft:stone", null, "minecraft:air", Map.of(), Set.of(), List.of()));
		assertEquals(RegionTargets.UNKNOWN, rule(p, "minecraft:stone", null, "minecraft:air", Map.of(), Set.of(p.west()), List.of()));
		assertEquals(RegionTargets.READY, rule(p, "minecraft:stone", null, "minecraft:air", Map.of(), Set.of(), List.of(new BlockPos(0, 67, 0))),
			"under a floating anchor's 3x3");
		// a fill over a support it replaces counts only while that support still stands
		assertEquals(RegionTargets.READY, rule(p, "minecraft:dirt", "minecraft:grass_block", "minecraft:grass_block", Map.of(), Set.of(), List.of()));
		assertEquals(RegionTargets.UNREACHED, rule(p, "minecraft:dirt", "minecraft:grass_block", "minecraft:air", Map.of(), Set.of(), List.of()),
			"its before mined since: no support");
	}

	@Test
	void aStagedCellMatchesOnlyItsWholeState() throws Exception {
		BlockState snow2 = st("minecraft:snow[layers=2]"), snow3 = st("minecraft:snow[layers=3]");
		BlockState logY = st("minecraft:oak_log[axis=y]"), logX = st("minecraft:oak_log[axis=x]");
		assertTrue(dev.larattalabs.architect.journal.Copper.is(snow2, snow3.getBlock()), "the block-only rule (before ST's fix) reads it built");
		assertFalse(Builder.Run.stagedMatches(snow2, snow3), "a snow layer of the wrong thickness is not built");
		assertFalse(Builder.Run.stagedMatches(logX, logY), "a log on the wrong axis is not built");
		assertTrue(Builder.Run.stagedMatches(snow3, snow3));
		assertFalse(Builder.Run.stagedMatches(st("minecraft:grass_block"), st("minecraft:dirt")), "grass on a cell planned dirt is not built (INSTANT wrote dirt)");
		// (GPT final review) every property counts for a cell not yet written by its target
		assertFalse(Builder.Run.stagedMatches(st("minecraft:oak_leaves[persistent=true,distance=1,waterlogged=true]"), st(
			"minecraft:oak_leaves[persistent=true,distance=1,waterlogged=false]")), "waterlogged leaves planned dry are not built");
		assertFalse(Builder.Run.stagedMatches(st("minecraft:frosted_ice[age=3]"), st("minecraft:frosted_ice[age=0]")), "frosted ice of another age is not built");
		assertTrue(dev.larattalabs.architect.journal.StillOurs.holds(st("minecraft:frosted_ice[age=3]"), null, st("minecraft:frosted_ice[age=0]"), null)
			|| dev.larattalabs.architect.journal.StillOurs.holds(st("minecraft:oak_leaves[persistent=true,distance=1,waterlogged=true]"), null, st(
				"minecraft:oak_leaves[persistent=true,distance=1,waterlogged=false]"), null), "the journal's leniency (the rule before) reads one of them built");
	}

	@Test
	void sandAfterItsFillAndAnOverhangFromItsPillar() throws Exception {
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		c.put(new BlockPos(0, 67, 0), "minecraft:sand"); // on the pillar's top
		c.put(new BlockPos(3, 67, 0), "minecraft:dirt"); // the overhang's tip
		c.put(new BlockPos(2, 67, 0), "minecraft:dirt");
		c.put(new BlockPos(1, 67, 0), "minecraft:dirt");
		c.put(new BlockPos(0, 66, 0), "minecraft:dirt");
		c.put(new BlockPos(0, 65, 0), "minecraft:dirt"); // the pillar's foot, on the ground
		c.put(new BlockPos(5, 66, 5), "minecraft:gravel"); // over nothing: the plan's own floating gravel
		int[] k = {0};
		List<String> o = order(c, ground(64), List.of(), k);
		assertEquals(6, k[0], "all but the gravel over nothing");
		assertEquals(List.of("0, 65, 0", "0, 66, 0"), o.subList(0, 2));
		assertTrue(o.indexOf("0, 67, 0") > o.indexOf("0, 66, 0"));
		assertTrue(o.indexOf("1, 67, 0") < o.indexOf("2, 67, 0") && o.indexOf("2, 67, 0") < o.indexOf("3, 67, 0"), "the overhang from its pillar out");
		assertEquals("5, 66, 5", o.get(6), "nothing reaches it: last, past connected");
	}

	@Test
	void cutsFirstTopDown() throws Exception {
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		for (int y = 62; y <= 64; y++) {
			c.put(new BlockPos(0, y, 0), "minecraft:air");
		}
		c.put(new BlockPos(1, 65, 0), "minecraft:dirt");
		int[] k = {0};
		List<String> o = order(c, ground(64), List.of(), k);
		assertEquals(List.of("0, 64, 0", "0, 63, 0", "0, 62, 0", "1, 65, 0"), o);
		assertEquals(4, k[0]);
	}

	@Test
	void leavesFarFromTheirLogAndABranchHeldOnlyThroughLeaves() throws Exception {
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		c.put(new BlockPos(0, 65, 0), "minecraft:oak_log");
		// a leaf run 7 long from the trunk (persistent, as the INSTANT write writes it), then a branch log hanging off its end only
		for (int x = 1; x <= 7; x++) {
			c.put(new BlockPos(x, 65, 0), "minecraft:oak_leaves[distance=" + Math.min(x, 7) + ",persistent=true,waterlogged=false]");
		}
		c.put(new BlockPos(8, 65, 0), "minecraft:oak_log");
		c.put(new BlockPos(8, 66, 0), "minecraft:oak_leaves[distance=1,persistent=true,waterlogged=false]");
		// a leaf over the run, not touching the log: never before the run that holds them
		c.put(new BlockPos(4, 66, 0), "minecraft:oak_leaves[distance=5,persistent=true,waterlogged=false]");
		// a leaf drooping onto the land beside the run's far end: held by the run, not by the ground it touches
		c.put(new BlockPos(7, 65, 1), "minecraft:oak_leaves[distance=7,persistent=true,waterlogged=false]");
		int[] k = {0};
		Set<BlockPos> land = ground(64);
		land.removeIf(p -> p.getX() >= 1 && p.getZ() != 1); // the run hangs over air past the trunk
		List<String> o = order(c, land, List.of(), k);
		assertEquals(c.size(), k[0], "no deadlock: the branch log comes once a held leaf touches it");
		assertEquals("0, 65, 0", o.get(0));
		for (int x = 1; x <= 7; x++) {
			assertTrue(o.indexOf((x - 1) + ", 65, 0") < o.indexOf(x + ", 65, 0"), "the run from its log out");
		}
		assertTrue(o.indexOf("8, 65, 0") > o.indexOf("7, 65, 0"));
		assertTrue(o.indexOf("8, 66, 0") > o.indexOf("8, 65, 0"));
		assertTrue(o.indexOf("4, 66, 0") > o.indexOf("4, 65, 0"));
		assertTrue(o.indexOf("7, 65, 1") > o.indexOf("7, 65, 0"), "not seeded by the ground: " + o);
	}

	@Test
	void aFloatingSlabGrowsFromItsAnchor() throws Exception {
		Map<BlockPos, String> c = new java.util.LinkedHashMap<>();
		for (int x = -4; x <= 4; x++) {
			for (int z = -1; z <= 1; z++) {
				c.put(new BlockPos(x, 100, z), "minecraft:grass_block");
			}
		}
		int[] k = {0};
		List<String> withAnchor = order(c, ground(64), List.of(new BlockPos(3, 101, 0)), k);
		assertEquals(c.size(), k[0]);
		Set<String> first9 = new HashSet<>(withAnchor.subList(0, 9));
		for (int x = 2; x <= 4; x++) {
			for (int z = -1; z <= 1; z++) {
				assertTrue(first9.contains(x + ", 100, " + z), "the anchor's 3x3 first: " + withAnchor);
			}
		}
		order(c, ground(64), List.of(), k);
		assertEquals(0, k[0], "without its anchor nothing holds it");
	}
}
