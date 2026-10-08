package dev.larattalabs.architect.delta;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.Sections;
import dev.larattalabs.architect.journal.WorldJournal;
import dev.larattalabs.architect.placement.Anchors;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Delta apply's invariants over random version chains and random operation sequences (docs/CONTRACT.md phase 5b gate 1,
 * "Mod, pure JVM"), on {@link DeltaModel}: chains of 3-6 versions from random edits (re-materials, growth toward -x with the
 * frame moving, shrink, removed cells), every rotation, a pad layered below the site sometimes, random applies and reverts:
 * <ul>
 * <li>E1 path independence: with no player edits, after any sequence the union box + 8 equals a fresh placement of the current
 * version on the original world;</li>
 * <li>E2: a revert of the top delta restores exactly the world before that apply;</li>
 * <li>E3: Remove at any point restores the original world, player edits included (BOX);</li>
 * <li>E4: an apply writes only {@code Δ'} (the model has no shape updates; guards are captured, not written);</li>
 * <li>E5: under KEEP, player-edited {@code Δ} cells are untouched and reported; cells outside {@code Δ} are untouched by
 * apply and revert;</li>
 * <li>E6: a fold changes no undo result except the folded version;</li>
 * <li>E7: only suffixes are undone (the model's revert takes the deltas above the target, never a middle one);</li>
 * <li>per-section planning equals whole-entry planning with delta entries included.</li>
 * </ul>
 */
class DeltaPropertyTest {
	static final int RUNS = 150;

	@BeforeAll
	static void boot() {
		TestBoot.boot();
	}

	record Fixture(DeltaModel m, DeltaModel world0, List<DeltaModel.Version> versions, Anchors.Bounds region) {
	}

	/** A world (with a pad T under the site sometimes), a chain of versions, S placed at version 1. */
	static Fixture fixture(Random r) {
		DeltaModel m = new DeltaModel();
		Map<Long, BlockState> d = DeltaModel.building(r, 4 + r.nextInt(4), 3 + r.nextInt(3), 4 + r.nextInt(4));
		List<DeltaModel.Version> vs = new ArrayList<>();
		vs.add(DeltaModel.Version.of(1, d));
		int n = 3 + r.nextInt(4);
		for (int i = 2; i <= n; i++) {
			d = DeltaModel.edit(r, r.nextInt(3) == 0 ? vs.get(r.nextInt(vs.size())).design() : d);
			vs.add(DeltaModel.Version.of(i, d));
		}
		int y = DeltaModel.GROUND + (r.nextBoolean() ? 0 : 2);
		int[] min = {r.nextInt(5), y, r.nextInt(5)};
		if (r.nextInt(3) == 0) {
			// a pad T (a CELL cell site) under the site: S layers over it
			List<Cell> cells = new ArrayList<>();
			long l = m.layer++;
			for (int x = -4; x < 14; x++) {
				for (int z = -4; z < 14; z++) {
					long p = Journal.pos(x, DeltaModel.GROUND, z);
					Value v = WorldJournal.value(Blocks.COBBLESTONE.defaultBlockState());
					cells.add(new Cell(p, l, m.at(p), v));
					m.world.put(p, v);
				}
			}
			m.entries.put("jT", new Entry("jT", "cells", "T", "minecraft:overworld", Policy.CELL, 0L, Status.ACTIVE, cells, null, null));
		}
		DeltaModel world0 = m.copy();
		int turns = r.nextInt(4);
		m.place(vs.get(0), min, turns);
		Anchors.Bounds region = new Anchors.Bounds(-16, DeltaModel.GROUND - 16, -16, 30, DeltaModel.GROUND + 16, 30);
		return new Fixture(m, world0, vs, region);
	}

	@Test
	void e1PathIndependenceE2RevertE4MinimalWritesE3Remove() {
		Random r = new Random(5_0501L);
		int applies = 0;
		int reverts = 0;
		int growth = 0;
		for (int run = 0; run < RUNS; run++) {
			Fixture f = fixture(r);
			DeltaModel m = f.m();
			int ops = 6 + r.nextInt(8);
			for (int op = 0; op < ops; op++) {
				DeltaModel.Site s = m.site;
				if (r.nextInt(3) > 0 || s.deltas.isEmpty()) {
					DeltaModel.Version b = f.versions().get(r.nextInt(f.versions().size()));
					DeltaModel pre = m.copy();
					DeltaModel.Applied a = m.apply(b, DeltaPlanner.Edits.OVERWRITE);
					assertNull(a.refused(), "run " + run + " op " + op + ": " + a.refused());
					applies++;
					if (!a.outcome().growth().isEmpty()) {
						growth++;
					}
					// E4: only Δ' changed
					for (long p : m.touched) {
						assertTrue(a.outcome().write().containsKey(p), "run " + run + ": an apply wrote " + p + " outside Δ'");
					}
					// E2: the top delta's revert gives the world before the apply back
					DeltaModel rev = m.copy();
					rev.site = copySite(m.site);
					rev.revert(rev.site.deltas.size() - 1);
					assertEquals(List.of(), DeltaModel.diff(rev, pre, f.region()), "run " + run + " op " + op + ": E2");
				} else {
					int k = r.nextInt(s.chain.size());
					m.revert(k);
					reverts++;
				}
				// E1: equal to a fresh placement of the current version on the original world
				DeltaModel fresh = DeltaModel.fresh(f.world0(), m.site.version, m.site.boxMin, m.site.turns);
				assertEquals(List.of(), DeltaModel.diff(m, fresh, f.region()), "run " + run + " op " + op + ": E1 (version " + m.site.version.n() + ")");
			}
			// E3: Remove gives the original world back
			m.remove();
			assertEquals(List.of(), DeltaModel.diff(m, f.world0(), f.region()), "run " + run + ": E3");
		}
		assertTrue(applies > RUNS * 3, "applies " + applies);
		assertTrue(reverts > RUNS, "reverts " + reverts);
		assertTrue(growth > RUNS / 4, "growth " + growth);
	}

	static DeltaModel.Site copySite(DeltaModel.Site s) {
		DeltaModel.Site c = new DeltaModel.Site();
		c.version = s.version;
		c.boxMin = s.boxMin;
		c.turns = s.turns;
		c.base = s.base;
		c.deltas.addAll(s.deltas);
		c.chain.addAll(s.chain);
		c.mins.addAll(s.mins);
		return c;
	}

	@Test
	void e5KeepLeavesPlayerEditsAndCellsOutsideDeltaE3RemoveIsExactWithEdits() {
		Random r = new Random(5_0505L);
		Value edit = WorldJournal.value(Blocks.GOLD_BLOCK.defaultBlockState());
		int keptTotal = 0;
		for (int run = 0; run < RUNS; run++) {
			Fixture f = fixture(r);
			DeltaModel m = f.m();
			for (int op = 0; op < 8; op++) {
				// the player edits a few cells of the site
				List<Long> mine = new ArrayList<>();
				for (Entry e : m.active()) {
					if (e.site().equals("S")) {
						for (Cell c : e.cells()) {
							mine.add(c.pos());
						}
					}
				}
				Set<Long> edited = new HashSet<>();
				for (int i = 0; i < 1 + r.nextInt(4); i++) {
					long p = mine.get(r.nextInt(mine.size()));
					m.world.put(p, edit);
					edited.add(p);
				}
				Map<Long, Value> before = new HashMap<>(m.world);
				DeltaModel.Version b = f.versions().get(r.nextInt(f.versions().size()));
				DeltaModel.Applied a = m.apply(b, DeltaPlanner.Edits.KEEP);
				assertNull(a.refused(), "run " + run + ": " + a.refused());
				Set<Long> keptPos = new HashSet<>();
				for (DeltaPlanner.Kept k : a.outcome().kept()) {
					keptPos.add(k.pos());
					assertEquals(edit, m.at(k.pos()), "run " + run + ": a kept cell was written");
				}
				for (long p : edited) {
					if (a.set().delta().containsKey(p)) {
						assertTrue(keptPos.contains(p), "run " + run + ": an edited Δ cell was not reported kept");
					}
				}
				keptTotal += keptPos.size();
				// cells outside Δ are untouched
				for (long p : m.touched) {
					assertTrue(a.set().delta().containsKey(p), "run " + run + ": wrote " + p + " outside Δ");
				}
				for (var e : before.entrySet()) {
					if (!a.set().delta().containsKey(e.getKey())) {
						assertEquals(e.getValue(), m.at(e.getKey()));
					}
				}
				// a revert of that delta touches only its own entry's cells; cells outside Δ ∪ guards keep the edits
				if (r.nextBoolean()) {
					Map<Long, Value> pre = new HashMap<>(m.world);
					m.revert(m.site.deltas.size() - 1);
					for (long p : m.touched) {
						assertTrue(a.outcome().entryCells().contains(p), "run " + run + ": a revert wrote " + p + " outside its entry");
					}
					for (long p : edited) {
						if (!a.outcome().entryCells().contains(p)) {
							assertEquals(pre.getOrDefault(p, DeltaModel.terrain(p)), m.at(p));
						}
					}
				}
			}
			m.remove();
			assertEquals(List.of(), DeltaModel.diff(m, f.world0(), f.region()), "run " + run + ": E3 with edits");
		}
		assertTrue(keptTotal > RUNS, "kept " + keptTotal);
	}

	@Test
	void refuseModeRefusesEditedDeltaCells() {
		Random r = new Random(5_0506L);
		int refused = 0;
		for (int run = 0; run < 60; run++) {
			Fixture f = fixture(r);
			DeltaModel m = f.m();
			DeltaModel.Version b = f.versions().get(1 + r.nextInt(f.versions().size() - 1));
			DeltaModel probe = m.copy();
			probe.site = copySite(m.site);
			DeltaModel.Applied dry = probe.apply(b, DeltaPlanner.Edits.OVERWRITE);
			if (dry.set().delta().isEmpty()) {
				continue;
			}
			long p = dry.set().delta().keySet().iterator().next();
			if (m.stacks().holder(p) != DeltaPlanner.Holder.SITE) {
				continue;
			}
			m.world.put(p, WorldJournal.value(Blocks.GOLD_BLOCK.defaultBlockState()));
			DeltaModel.Applied a = m.apply(b, DeltaPlanner.Edits.REFUSE);
			assertTrue(a.refused() != null && a.refused().startsWith("PLAYER_EDITS"), "run " + run);
			refused++;
		}
		assertTrue(refused > 10, "refused " + refused);
	}

	@Test
	void e6FoldChangesNoUndoResultExceptTheFoldedVersion() {
		Random r = new Random(5_0507L);
		int folds = 0;
		for (int run = 0; run < 60; run++) {
			Fixture f = fixture(r);
			DeltaModel a = f.m();
			DeltaModel b = a.copy(); // never folds
			b.site = copySite(a.site);
			b.maxDeltas = Integer.MAX_VALUE;
			int n = 7 + r.nextInt(4);
			for (int i = 0; i < n; i++) {
				DeltaModel.Version v = f.versions().get(r.nextInt(f.versions().size()));
				assertNull(a.apply(v, DeltaPlanner.Edits.OVERWRITE).refused());
				assertNull(b.apply(v, DeltaPlanner.Edits.OVERWRITE).refused());
				assertEquals(List.of(), DeltaModel.diff(a, b, f.region()), "run " + run + ": apply " + i);
			}
			folds += b.site.deltas.size() - a.site.deltas.size();
			assertTrue(a.site.deltas.size() <= DeltaModel.MAX_DELTAS);
			// every retained version: the same revert result
			int retained = a.site.chain.size();
			for (int k = retained - 1; k >= 0; k--) {
				DeltaModel ra = a.copy();
				ra.site = copySite(a.site);
				DeltaModel rb = b.copy();
				rb.site = copySite(b.site);
				ra.revert(k);
				rb.revert(k + (b.site.chain.size() - retained));
				assertEquals(List.of(), DeltaModel.diff(ra, rb, f.region()), "run " + run + ": revert to retained " + k);
			}
			// Remove: the same
			DeltaModel xa = a.copy();
			xa.site = copySite(a.site);
			DeltaModel xb = b.copy();
			xb.site = copySite(b.site);
			xa.remove();
			xb.remove();
			assertEquals(List.of(), DeltaModel.diff(xa, xb, f.region()), "run " + run + ": remove");
			assertEquals(List.of(), DeltaModel.diff(xa, f.world0(), f.region()), "run " + run + ": remove = world0");
			// depth: S's own entries at any cell <= 1 + MAX_DELTAS
			for (Entry e : a.active()) {
				for (Cell c : e.cells()) {
					long own = a.stack(c.pos()).stream().filter(x -> x.getKey().site().equals("S")).count();
					assertTrue(own <= 1 + DeltaModel.MAX_DELTAS, "depth " + own);
				}
			}
		}
		assertTrue(folds > 30, "folds " + folds);
	}

	@Test
	void e7OnlySuffixesAreUndone() {
		Random r = new Random(5_0508L);
		for (int run = 0; run < 40; run++) {
			Fixture f = fixture(r);
			DeltaModel m = f.m();
			for (int i = 0; i < 4; i++) {
				m.apply(f.versions().get(r.nextInt(f.versions().size())), DeltaPlanner.Edits.OVERWRITE);
			}
			List<String> before = new ArrayList<>(m.site.deltas);
			int k = r.nextInt(m.site.chain.size());
			m.revert(k);
			// what stays is a prefix of what was there
			assertEquals(before.subList(0, k), m.site.deltas);
			for (String id : before.subList(k, before.size())) {
				assertTrue(!m.entries.containsKey(id), "undone " + id);
			}
		}
	}

	@Test
	void perSectionPlanningEqualsWholeEntryPlanningWithDeltaEntries() {
		Random r = new Random(5_0509L);
		int sectioned = 0;
		for (int run = 0; run < 60; run++) {
			Fixture f = fixture(r);
			DeltaModel m = f.m();
			for (int i = 0; i < 1 + r.nextInt(4); i++) {
				m.apply(f.versions().get(r.nextInt(f.versions().size())), DeltaPlanner.Edits.OVERWRITE);
			}
			List<String> subset = new ArrayList<>();
			if (r.nextBoolean() || m.site.deltas.isEmpty()) {
				subset.add(m.site.base);
				subset.addAll(m.site.deltas);
			} else {
				subset.addAll(m.site.deltas.subList(r.nextInt(m.site.deltas.size()), m.site.deltas.size()));
			}
			Journal.World w = (pos, after) -> m.now().holds(pos, after);
			Journal.UndoPlan whole = Journal.planUndo(m.active(), subset, "g", 3L, w, Journal.Match.EQUAL);
			Map<Long, List<Entry>> bySection = new TreeMap<>();
			for (Entry e : m.active()) {
				Sections.slice(e).forEach((k, x) -> bySection.computeIfAbsent(k, kk -> new ArrayList<>()).add(x));
			}
			TreeSet<Long> sections = new TreeSet<>();
			for (String id : subset) {
				for (Cell c : m.entries.get(id).cells()) {
					sections.add(Sections.key(c.pos()));
				}
			}
			if (sections.size() > 1) {
				sectioned++;
			}
			Sections.Plan per = Sections.plan(sections, k -> (Collection<Entry>) bySection.getOrDefault(k, List.of()), subset, "g", 3L, w,
				Journal.Match.EQUAL);
			Map<Long, Value> a = new LinkedHashMap<>();
			for (Journal.Write x : whole.writes()) {
				a.put(x.pos(), x.value());
			}
			Map<Long, Value> b = new LinkedHashMap<>();
			for (Journal.Write x : per.writes()) {
				b.put(x.pos(), x.value());
			}
			assertEquals(new TreeMap<>(a), new TreeMap<>(b), "run " + run);
			assertEquals(whole.stats(), per.stats(), "run " + run);
		}
		assertTrue(sectioned > 10, "sectioned " + sectioned);
	}
}
