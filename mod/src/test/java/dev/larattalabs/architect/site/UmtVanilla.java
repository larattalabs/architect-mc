package dev.larattalabs.architect.site;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;

/**
 * The vanilla-updates table (docs/UMT.md, "The vanilla table"; docs/FAST-CHECKS.md "Undo model tester"): every way the world changes a
 * cell by itself that UMT models around the real journal code. None of it is production code; each row names what it stands for in
 * vanilla, which past undo bug or gate noise it covers, how {@link UmtWorld}/{@link UmtSim} apply it, its class, and the in-game
 * probe that calibrates it (run at release and on every Minecraft update; on a mismatch the row is fixed before UMT is trusted).
 *
 * <p>Classes: <b>UPDATE</b> a change set off by a write (Architect's or a player's) through vanilla's shape updates and ticks: UMT
 * judges it (an undo must still come back exactly, or the difference is a finding); <b>EQUIV</b> a change the world makes over time
 * that {@code StillOurs} must count as still the entry's (drift ops); <b>NOISE</b> a change at cells no plan wrote, away from the plan,
 * that is the world's own (decor decay, an entity): never an undo miss, so the oracle names it and leaves it out, and the in-game
 * smoke hash must ignore it too.
 */
final class UmtVanilla {
	private UmtVanilla() {
	}

	enum Kind {
		UPDATE,
		EQUIV,
		NOISE
	}

	record Rule(String id, Kind kind, String vanilla, String covers, String model, String probe) {
	}

	static final List<Rule> TABLE = List.of(
		new Rule("V1", Kind.UPDATE, "Level.setBlock without UPDATE_KNOWN_SHAPE (16) sends updateShape to the six neighbours; Sites.FLAGS (290) does, "
			+ "CELL_FLAGS (816) and UPDATE_SKIP_ALL_SIDEEFFECTS don't; UpdateMask (4e) drops updates into a restore's covered cells",
			"every row below that a write triggers", "UmtWorld.updates: flags decide; masked positions get nothing",
			"(to build) write one cell with each flag set beside a falling block and a dirt path, read the neighbours after 2 ticks"),
		new Rule("V2", Kind.UPDATE, "FallingBlock.onPlace / updateShape schedule a tick; at the tick a falling block over a free cell "
			+ "(FallingBlock.isFree: air, fire, fluid, replaceable) falls to the first non-free cell (TickDeferral holds and then releases the tick)",
			"sand vanish (70fc0dd0), the 4d gravel column into a restored hole, F2, F3",
			"UmtWorld.tick: the block moves down its column; the record (PT) is dropped",
			"gate6cb tile-gravity (exists); (to build) sand over air written by a restore template, gravel on a cell a site writes under"),
		new Rule("V3", Kind.UPDATE, "DirtPathBlock / FarmBlock.updateShape: a solid block (BlockState.isSolid, not a fence gate) above schedules "
			+ "a tick that turns the path or farmland to dirt", "lamp on dirt path (52cc9606, LP)",
			"UmtWorld.turnsToDirt at the tick", "(to build) a fence, a slab, a lantern written over a path and over farmland, read after 1 tick (irr-ingame lp covers the road-post case on fix/lamp-path)"),
		new Rule("V4", Kind.UPDATE, "fences, walls, panes and iron bars change their connection properties on updateShape and update their own "
			+ "neighbours in turn", "lamp on dirt path: a lot's write beside a road post reconnected the fence; the path under it turned",
			"UmtWorld.updates: a connecting block reached by a shape update passes it on (once per cascade)",
			"(to build) a fence post beside a fresh write, the path under the post read after 1 tick"),
		new Rule("V5", Kind.UPDATE, "VegetationBlock / carpets / leaf litter / snow layers return air from updateShape when their support goes",
			"4d's leaf_litter missing after the undo (a write under it, outside the box)",
			"UmtWorld.updates: a dependent above a written cell breaks when the cell can't hold it (supports())",
			"(to build) grass, a poppy, leaf litter and a carpet on cells a FLAGS write changes"),
		new Rule("V6", Kind.EQUIV, "WeatheringCopper random ticks step a copper block to its next stage; honeycomb wax and an axe scrape change it "
			+ "in place", "copper undo (a3478515, CU)", "UmtSim.drift: getNext / HoneycombItem.WAXABLES", "dev.copper.use (exists, CU) on every copper form"),
		new Rule("V7", Kind.EQUIV, "farmland dries or is trampled to dirt; grass, mycelium, podzol spread onto dirt and die under a block",
			"CU's farmland and dirt (S-CU-3), phase 6a spread", "UmtSim.drift", "(to build) a farmland cell left dry; a grass cell under a slab, after random ticks"),
		new Rule("V8", Kind.EQUIV, "water flows into air an entry cleared; a source under the sky freezes to ice", "phase 6a fluid in cleared "
			+ "air, 6c H §4.3", "UmtSim.drift (level 7 flowing water beside water; ice over a source)", "h-ingame's census on a drained basin"),
		new Rule("V9", Kind.UPDATE, "a restore writes flowing water with CELL_FLAGS (no tick): it never flows again unless something ticks it "
			+ "(FluidRearm wakes it once the restores are done)", "relief re-tick (7bd8c817)",
			"UmtSim's FluidRearm property: every non-source fluid a restore writes is queued (production SiteJournal.writeCells calls "
				+ "FluidRearm.wrote)", "relief-probe (fix/relief-flow branch): a stream feeder restored, the cell below it after 20 ticks"),
		new Rule("V10", Kind.EQUIV, "a property StillOurs counts volatile changes by use or neighbours: a door or trapdoor opened, a lamp lit, "
			+ "powered, a fence or wall connecting, a stair's shape, leaves' distance, waterlogged", "StillOurs.VOLATILE / CONNECTIONS (4e S2)",
			"UmtSim.volatileFlip: one volatile property of a standing entry's cell cycled", "(to build) each volatile property flipped on a road "
				+ "cell, then its removal"),
		new Rule("N1", Kind.NOISE, "brown and red mushrooms pop off at light > 12 and spread at random ticks; leaf litter and short plants "
			+ "are trampled or eaten", "4d's intermittent 'group undo back exactly' (18 of 84 logs: leaf_litter, brown mushroom)",
			"UmtSim.noise: a decor cell no entry ever wrote, two or more cells from any written one, goes to air; the oracle names it NOISE",
			"none needed: the oracle's rule (kind, unwritten, away from the plan) is the in-game hash's ignore list"),
		new Rule("N2", Kind.NOISE, "an entity in a site box (a bee, a villager) makes removeGroup wait or refuse", "4d's bee in the box",
			"not modelled (UMT has no entities): an in-game smoke failing on it is noise", "none: the refusal names the entity"));

	/** How often each rule fired in this JVM (the CI test prints it: a rule that never fires is a generator gap). */
	static final Map<String, AtomicLong> FIRED = new LinkedHashMap<>();

	static {
		for (Rule r : TABLE) {
			FIRED.put(r.id(), new AtomicLong());
		}
	}

	static void fired(String id) {
		FIRED.get(id).incrementAndGet();
	}

	/** V5: whether {@code below} holds the dependent {@code s} up (vegetation on dirt-like ground; the rest on a solid block). */
	static boolean supports(BlockState s, BlockState below) {
		if (s.getBlock() instanceof net.minecraft.world.level.block.VegetationBlock && !(s.getBlock() instanceof net.minecraft.world.level.block.MushroomBlock)) {
			return below.is(BlockTags.DIRT) || below.is(Blocks.FARMLAND);
		}
		return below.isSolid();
	}

	/** V5's dependents: TileCheck's own class, gravity blocks aside (V2). */
	static boolean decor(BlockState s) {
		return TileCheck.dependent(s) && !(s.getBlock() instanceof FallingBlock);
	}

	/** V4: blocks that reshape against their neighbours. */
	static boolean connects(BlockState s) {
		var b = s.getBlock();
		return b instanceof net.minecraft.world.level.block.FenceBlock || b instanceof net.minecraft.world.level.block.WallBlock
			|| b instanceof net.minecraft.world.level.block.IronBarsBlock;
	}
}
