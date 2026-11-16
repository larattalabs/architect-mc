package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.JournalStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.Test;

/**
 * (DR) UMT property P7 (docs/UMT.md): after a crash that loses world writes, an op's repair (DR's core: the owner's committed values,
 * the per-cell classifier, the roll-forward through the journal's write path, a stuck removal settled once unanimous) converges to the
 * journal's committed state, and a second repair writes nothing (idempotent). Targeted for F5 (a half-restored removal), H-core (a
 * half-placed site) and F7 (two stacked removals lost); then over the CRASH generator's seeds.
 */
class UmtRepairP7Test {
	static {
		UmtRunner.boot();
	}

	private static void exact(List<String> v) {
		assertTrue(v.isEmpty(), "not exact:\n" + String.join("\n", v));
	}

	static RepairCore.Reader reader(UmtSim sim) {
		return new RepairCore.Reader() {
			@Override
			public BlockState get(long pos) {
				return sim.world.get(pos);
			}

			@Override
			public @Nullable CompoundTag nbt(long pos) {
				CompoundTag t = sim.world.nbt(pos);
				return t == null ? null : t.copy();
			}

			@Override
			public boolean pt(long pos) {
				return sim.world.record(pos) != null;
			}
		};
	}

	/** DR's repair of everything on the model: returns cells written. Settles stuck removals whose cells are all OK. */
	static int repairAll(UmtSim sim) {
		try {
			JournalStore js = sim.store;
			RepairCore.Reader r = reader(sim);
			java.util.Set<String> jobSites = new java.util.HashSet<>();
			sim.jobs.forEach(j -> jobSites.addAll(j.sites));
			int n = 0;
			for (UmtSim.Rec x : List.copyOf(sim.recs.values())) {
				if (!x.pending || jobSites.contains(x.id)) {
					continue;
				}
				String g = SiteJournal.lastGroup(x.id);
				if (g == null) {
					continue;
				}
				List<RepairCore.Want> w = RepairCore.removalWants(js, x.id, g);
				n += RepairCore.rollForward(r, sim.world, w);
			}
			// settled once unanimous; every group released after all are judged (a lower's later undo is the upper's expected value: F1)
			List<String> release = new ArrayList<>();
			for (UmtSim.Rec x : List.copyOf(sim.recs.values())) {
				String g = x.pending && !jobSites.contains(x.id) ? SiteJournal.lastGroup(x.id) : null;
				if (g != null && RepairCore.removalWants(js, x.id, g).stream().allMatch(q -> RepairCore.classify(r, q) == RepairCore.Cell.OK)) {
					release.addAll(SiteJournal.undone(x.id, g).stream().map(JournalStore.Meta::id).toList());
					sim.recs.remove(x.id);
					sim.kept.remove(x.id);
					sim.trace.add("  repair: " + x.id + " settled (released)");
				}
			}
			if (!release.isEmpty()) {
				SiteJournal.releaseGroup(release);
				js.flush();
			}
			for (JournalStore.Meta m : List.copyOf(js.index().entries().values())) {
				if (m.status() == Journal.Status.ACTIVE && !jobSites.contains(m.site())) {
					n += RepairCore.rollForward(r, sim.world, RepairCore.placementWants(js, m));
				}
			}
			sim.world.tick();
			if (n > 0) {
				sim.trace.add("  repair: wrote " + n);
			}
			return n;
		} catch (Exception e) {
			throw new IllegalStateException(e);
		}
	}

	/** The repair as the op runs it after a start, with P7's idempotence check (a second repair writes nothing). */
	static int fuzzWritten;
	static int fuzzSettled;

	static void repairTwice(UmtSim sim) {
		int before = sim.recs.size();
		fuzzWritten += repairAll(sim);
		fuzzSettled += Math.max(0, before - sim.recs.size());
		int again = repairAll(sim);
		if (again != 0) {
			sim.violations.add("[P7] a second repair after the start wrote " + again + " cell(s) (not idempotent)");
		}
	}

	private static final BlockState BRICK = Blocks.STONE_BRICKS.defaultBlockState();
	private static final BlockState PLANK = Blocks.OAK_PLANKS.defaultBlockState();

	/** F5: a removal's restore written, half of it lost (the world never saved those chunks): stuck at the start, rolled forward, exact. */
	@Test
	void p7_f5_aHalfRestoredRemovalRollsForward() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec s = c.site(1, G + 1, 1, 4, G + 2, 4, BRICK, Map.of(), 0);
			c.sim.remove(s, null);
			// the lost writes: half the restored cells show the site's block again
			for (int x = 1; x <= 2; x++) {
				for (int z = 1; z <= 4; z++) {
					c.sim.world.natural(p(x, G + 1, z), BRICK);
					c.sim.world.natural(p(x, G + 2, z), BRICK);
				}
			}
			c.sim.restart(false);
			assertTrue(c.sim.recs.containsKey(s.id) && c.sim.recs.get(s.id).pending, "the precondition: the removal settled KEEP (stuck): "
				+ c.sim.trace);
			assertEquals(16, repairAll(c.sim), "the 16 lagging cells rolled forward");
			assertEquals(0, repairAll(c.sim), "a second repair writes nothing");
			assertTrue(!c.sim.recs.containsKey(s.id), "the stuck record settled (released)");
			exact(c.sim.end());
		}
	}

	/** H-core: a site placed, half its writes lost: its ACTIVE entry rolls forward; a player's block (a record) and a changed one stay. */
	@Test
	void p7_hcore_aHalfPlacedSiteRollsForwardAndLeavesForeignCells() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			c.site(1, G + 1, 1, 4, G + 1, 4, BRICK, Map.of(), 0);
			for (int z = 1; z <= 4; z++) {
				c.sim.world.natural(p(1, G + 1, z), Blocks.AIR.defaultBlockState()); // lost: back to its before
			}
			c.sim.world.natural(p(3, G + 1, 3), Blocks.GLASS.defaultBlockState()); // neither value: foreign
			c.sim.tainted.add(p(3, G + 1, 3));
			c.sim.world.player(p(4, G + 1, 4), Blocks.AIR.defaultBlockState(), null, null);
			c.sim.world.player(p(4, G + 1, 4), PLANK, new dev.larattalabs.architect.journal.Pt(new java.util.UUID(9L, 9L), null), null);
			c.sim.tainted.add(p(4, G + 1, 4));
			c.sim.restart(false);
			assertEquals(4, repairAll(c.sim), "only the 4 lagging cells");
			assertEquals(Blocks.GLASS, c.at(p(3, G + 1, 3)).getBlock(), "the foreign cell is left");
			assertEquals(Blocks.OAK_PLANKS, c.at(p(4, G + 1, 4)).getBlock(), "the player's block is left");
			assertEquals(0, repairAll(c.sim), "idempotent");
			exact(c.sim.end());
		}
	}

	/** F7: two stacked sites removed (upper, then lower), both removals' writes lost in part: top-down, the lower not cut. */
	@Test
	void p7_f7_twoStackedRemovalsRollForwardTopDown() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			UmtSim.Rec a = c.site(1, G + 1, 1, 4, G + 2, 4, BRICK, Map.of(), 0);
			UmtSim.Rec b = c.site(3, G + 1, 3, 6, G + 3, 6, PLANK, Map.of(), 1);
			Map<Long, BlockState> shown = new TreeMap<>();
			for (int x = 1; x <= 6; x++) {
				for (int z = 1; z <= 6; z++) {
					for (int y = G + 1; y <= G + 3; y++) {
						shown.put(p(x, y, z), c.at(p(x, y, z)));
					}
				}
			}
			c.sim.remove(b, null);
			c.sim.remove(a, null);
			// lost: the columns x 3..4 (shared) and x 1 show what stood before both removals
			shown.forEach((q, st) -> {
				int x = BlockPos.getX(q) - UmtCase.X;
				if (x == 1 || x == 3 || x == 4) {
					c.sim.world.natural(q, st);
				}
			});
			c.sim.restart(false);
			assertTrue(c.sim.recs.get(a.id) != null && c.sim.recs.get(a.id).pending, "the lower is stuck: " + c.sim.trace);
			assertTrue(repairAll(c.sim) > 0, "rolled forward");
			assertEquals(0, repairAll(c.sim), "idempotent");
			String why = "";
			if (!c.sim.recs.isEmpty()) {
				String g = SiteJournal.lastGroup(b.id);
				for (RepairCore.Want q : RepairCore.removalWants(c.sim.store, b.id, g)) {
					RepairCore.Cell cl = RepairCore.classify(reader(c.sim), q);
					if (cl != RepairCore.Cell.OK) {
						why += BlockPos.of(q.pos()).toShortString() + " " + cl + " want " + q.expected() + " pre " + q.pre() + " now " + c.at(q.pos()) + "\n";
					}
				}
			}
			assertTrue(c.sim.recs.isEmpty(), "both settled: " + c.sim.recs + "\n" + why + c.sim.trace);
			exact(c.sim.end());
		}
	}

	/**
	 * P7 over the CRASH generator: after every crash's start the repair runs (twice: the second writes nothing). No [P7] violation, and
	 * no record or entry is left at the end as F5 (kept forever) once the repair has rolled it forward.
	 */
	@Test
	void p7_anyCrashRepairConvergesAndIsIdempotent() {
		int seeds = Integer.getInteger("umt.p7.seeds", 150);
		List<String> bad = new ArrayList<>();
		UmtSim.AFTER_START = UmtRepairP7Test::repairTwice;
		try {
			for (long s = 1; s <= seeds && bad.size() < 3; s++) {
				UmtRunner.Result r = UmtRunner.run(UmtOps.generate(s, UmtOps.Gen.CRASH));
				for (String v : r.violations()) {
					if (v.startsWith("[P7]") || v.startsWith("[F5] record left") || v.startsWith("[F5] journal entry left")) {
						bad.add("seed " + s + ": " + v + "\n" + r.report());
						break;
					}
				}
			}
		} finally {
			UmtSim.AFTER_START = null;
		}
		assertTrue(bad.isEmpty(), String.join("\n\n", bad));
		System.out.println("P7: " + seeds + " CRASH seeds, the repairs wrote " + fuzzWritten + " cell(s) and settled " + fuzzSettled + " stuck record(s)");
		assertTrue(fuzzWritten > 0, "the CRASH seeds gave the repair something to roll forward (not vacuous)");
	}
}
