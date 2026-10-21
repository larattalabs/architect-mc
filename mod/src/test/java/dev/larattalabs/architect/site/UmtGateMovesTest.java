package dev.larattalabs.architect.site;

import static dev.larattalabs.architect.site.UmtCase.G;
import static dev.larattalabs.architect.site.UmtCase.p;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.JournalStore;
import dev.larattalabs.architect.journal.Journal.Status;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.Test;

/**
 * The in-game undo assertions that left the slice tier for the undo model (docs/FAST-CHECKS.md, phase P1; docs/GATES.md "Fast checks
 * P1"). Each property here is the offline form of a named in-game group, on UMT's real journal, store, undo and settle code; the
 * in-game group still runs at release (the steps' full modes). Each was checked to go red with the production code it guards broken
 * (docs/GATES.md "Fast checks P1", the mutation table).
 *
 * <ul>
 * <li>4e-orders rows 2 and 4: every removal order of a layered four (a pad, a road, a site on the pad, a site over the first's edge)
 * and seeded orders of five (a site over the road's edge): exact, no leak, the next start settles everything;</li>
 * <li>4e-crash K1, K2, K4, K5, K6, K8: each kill point leaves the state the gate asserts after the restart, then a final removal is
 * exact;</li>
 * <li>4d-all row 13 and 6a-eflat rows 6-7: stage undos (a subset of the group's members, a later stage first or forced over a later
 * one) and a single lot's undo are exact;</li>
 * <li>c30-ingame row 3: a staged group placed and removed twelve times leaves the world exact after every removal.</li>
 * </ul>
 */
class UmtGateMovesTest {
	static {
		UmtRunner.boot();
	}

	private static void exact(List<String> v, String what) {
		List<String> real = v.stream().filter(x -> !x.startsWith("[UC] ")).toList();
		assertTrue(real.isEmpty(), what + ": not exact:\n" + String.join("\n", real));
	}

	/** The 4e fixture's four (T a pad cell site, R a road across it, H a site on T, X a site over H's east edge) and L (a site over R's edge). */
	record Fixture(UmtCase c, Map<String, UmtSim.Rec> recs) {
		void removeAll(List<String> order) throws Exception {
			for (String k : order) {
				UmtSim.Rec r = recs.get(k);
				if (r.kind == UmtOps.Kind.TILE) {
					c.sim.removeGroup(List.of(r), null);
				} else {
					c.sim.remove(r, null);
				}
			}
		}
	}

	static Fixture fixture(boolean withL) throws Exception {
		UmtCase c = UmtCase.of(w -> {
		});
		Map<String, UmtSim.Rec> m = new LinkedHashMap<>();
		// T: the pad, a cell site (a CELL entry, as gate4e:pad); R: a road across it (layered over T); H on T; X over H's east edge
		Map<Long, BlockState> pad = new LinkedHashMap<>();
		for (int x = 0; x <= 6; x++) {
			for (int z = 0; z <= 5; z++) {
				pad.put(p(x, G, z), Blocks.COARSE_DIRT.defaultBlockState());
			}
		}
		m.put("T", c.sim.cells(UmtOps.Kind.ROAD, 1, pad));
		Map<Long, BlockState> road = new LinkedHashMap<>();
		for (int x = 0; x <= 7; x++) {
			road.put(p(x, G, 5), Blocks.DIRT_PATH.defaultBlockState());
		}
		road.put(p(7, G + 1, 6), Blocks.OAK_FENCE.defaultBlockState());
		road.put(p(7, G + 2, 6), Blocks.LANTERN.defaultBlockState());
		m.put("R", c.sim.cells(UmtOps.Kind.ROAD, 1, road));
		// H and X stand on the pad (their boxes start above it, as the cabin and the gatehouse on gate4e's pad do)
		m.put("H", c.site(1, G + 1, 1, 3, G + 3, 3, Blocks.OAK_PLANKS.defaultBlockState(), UmtCase.cells(p(2, G + 2, 2), Blocks.AIR, p(1, G + 2, 1), Blocks.OAK_FENCE),
			1));
		m.put("X", c.site(3, G + 1, 1, 5, G + 3, 3, Blocks.STONE_BRICKS.defaultBlockState(), UmtCase.cells(p(4, G + 2, 2), Blocks.AIR, p(3, G + 2, 2),
			Blocks.GLASS_PANE), 1));
		if (withL) {
			m.put("L", c.site(5, G, 5, 7, G + 1, 7, Blocks.SPRUCE_PLANKS.defaultBlockState(), Map.of(), 0));
		}
		c.sim.world.autosave(); // the fixture is saved (4e saves its base worlds), so a crash loses only what comes after
		return new Fixture(c, m);
	}

	static List<List<String>> perms(List<String> a) {
		if (a.size() <= 1) {
			return List.of(a);
		}
		List<List<String>> out = new ArrayList<>();
		for (int i = 0; i < a.size(); i++) {
			List<String> rest = new ArrayList<>(a);
			String x = rest.remove(i);
			for (List<String> q : perms(rest)) {
				List<String> o = new ArrayList<>();
				o.add(x);
				o.addAll(q);
				out.add(o);
			}
		}
		return out;
	}

	/** After the removals and a clean start: no record and no journal entry left (4e's "the next start settles every removal"). */
	static void settled(Fixture f, String what) throws Exception {
		f.c.sim.restart(false);
		assertTrue(f.c.sim.recs.isEmpty(), what + ": records left after the start: " + f.c.sim.recs.values() + "\n" + f.c.sim.report());
		assertTrue(f.c.sim.store.index().entries().isEmpty(), what + ": journal entries left after the start: " + f.c.sim.store.index().entries().keySet());
	}

	/**
	 * (4e-orders rows 2 and 4) Every one of the 24 removal orders of T, R, H, X, one by one, then the group removal of all four, and 6
	 * seeded orders of five with L over R's edge: after each removal no standing site's top cell changed (no leak), at the end the world
	 * is the world before, and the next start settles everything.
	 */
	@Test
	void orders4e_everyOrderOfTheLayeredFixtureIsExactLeaksNothingAndSettles() throws Exception {
		int runs = 0;
		for (List<String> order : perms(List.of("T", "R", "H", "X"))) {
			Fixture f = fixture(false);
			try (UmtCase c = f.c()) {
				f.removeAll(order);
				settled(f, "order " + order);
				exact(c.sim.end(), "order " + order);
				runs++;
			}
		}
		Fixture g = fixture(false);
		try (UmtCase c = g.c()) {
			c.sim.removeGroup(new ArrayList<>(g.recs().values()), null);
			settled(g, "the group removal");
			exact(c.sim.end(), "the group removal");
		}
		Random r = new Random(4242);
		for (int i = 0; i < 6; i++) {
			List<String> order = new ArrayList<>(List.of("T", "R", "H", "X", "L"));
			java.util.Collections.shuffle(order, r);
			Fixture f = fixture(true);
			try (UmtCase c = f.c()) {
				f.removeAll(order);
				settled(f, "order with L " + order);
				exact(c.sim.end(), "order with L " + order);
				runs++;
			}
		}
		assertTrue(runs == 30);
	}

	/** Generations on disk that the index doesn't name for a known entry (a half-written commit's): the start deletes them. */
	static List<String> strayGenerations(JournalStore store) throws IOException {
		Pattern region = Pattern.compile("r\\.(-?\\d+)\\.(-?\\d+)\\.(\\d+)\\.nbt");
		Pattern head = Pattern.compile("head\\.(\\d+)\\.nbt");
		List<String> out = new ArrayList<>();
		Path e = store.dir().resolve(JournalStore.ENTRIES);
		if (!Files.isDirectory(e)) {
			return out;
		}
		try (var dirs = Files.list(e)) {
			for (Path d : dirs.toList()) {
				JournalStore.Meta m = store.index().entries().get(d.getFileName().toString());
				if (m == null) {
					continue;
				}
				try (var files = Files.list(d)) {
					for (Path f : files.toList()) {
						String n = f.getFileName().toString();
						Matcher rm = region.matcher(n);
						Matcher hm = head.matcher(n);
						String key = rm.matches() ? rm.group(1) + "," + rm.group(2) : hm.matches() ? "head" : null;
						int gen = rm.matches() ? Integer.parseInt(rm.group(3)) : hm.matches() ? Integer.parseInt(hm.group(1)) : -1;
						if (key != null && !Integer.valueOf(gen).equals(m.files().get(key))) {
							out.add(m.id() + "/" + n);
						}
					}
				}
			}
		}
		return out;
	}

	static List<String> statuses(UmtCase c) {
		return c.sim.store.index().entries().values().stream().map(m -> m.site() + ":" + m.status()).toList();
	}

	/**
	 * (4e-crash K1, K2, K4, K5, K6, K8) A kill at each point, with and without an autosave just before, then the start; the state the
	 * gate asserts after the start, then a final removal of everything is exact. The in-game points map to UMT's (docs/UMT.md "Crash
	 * points"): K1 a fault inside the P3 commit before the index (write, move, read back); K2; K4 after the ACTIVE commit before the record
	 * is placed (P7 committed, P8); K5 before the R2 commit is durable (its first write); K6; K8 inside the R2 commit that hands H's cells
	 * down to X (move, read back: files written, the index not).
	 */
	@Test
	void crash4e_killPointsLeaveTheStatesTheGateAsserts() throws Exception {
		List<String> bad = new ArrayList<>();
		int runs = 0;
		for (boolean save : new boolean[] {false, true}) {
			// placement points: a new site beside the fixture
			for (UmtOps.Crash k : List.of(new UmtOps.Crash("P3", "write", 0, save), new UmtOps.Crash("P3", "move", 0, save), new UmtOps.Crash("P3",
				"read back", 0, save), new UmtOps.Crash("K2", null, 0, save), new UmtOps.Crash("P7", "committed", 0, save), new UmtOps.Crash("P8", null,
					0, save))) {
				Fixture f = fixture(false);
				try (UmtCase c = f.c()) {
					var before = c.sim.world.copy();
					int recsBefore = c.sim.recs.size();
					int entriesBefore = c.sim.store.index().entries().size();
					try {
						c.sim.apply(new UmtOps.Place(UmtOps.Kind.SITE, UmtCase.X, UmtCase.Z + 5, 3, 2, 3, 77L, 0, k));
						bad.add(k + ": no halt");
					} catch (UmtSim.Halt h) {
						c.sim.restart(true);
					}
					runs++;
					boolean late = k.point().equals("P8") || k.point().equals("P7");
					if (!late) {
						// K1, K2: no site and no entry; nothing written
						if (c.sim.recs.size() != recsBefore || c.sim.store.index().entries().size() != entriesBefore) {
							bad.add(k + ": a record or an entry was left (" + c.sim.recs.values() + "; " + statuses(c) + ")");
						}
						if (!c.sim.world.diff(before, x -> false).isEmpty()) {
							bad.add(k + ": the world changed: " + c.sim.world.diff(before, x -> false));
						}
					} else {
						// K4: the journal wins: the record is placed, its entry ACTIVE
						UmtSim.Rec n = c.sim.recs.values().stream().filter(x -> !f.recs().containsValue(x)).findFirst().orElse(null);
						if (n == null || n.placing || n.pending || SiteJournal.active(n.id).stream().anyMatch(m -> m.status() != Status.ACTIVE)) {
							bad.add(k + ": the record is not placed with ACTIVE entries (" + c.sim.recs.values() + "; " + statuses(c) + ")");
						}
					}
					List<String> v = c.sim.end().stream().filter(x -> !x.startsWith("[UC] ")).toList();
					if (!v.isEmpty()) {
						bad.add(k + ": the final removal is not exact: " + v);
					}
				}
			}
			// removal points: H's removal hands its cells under X down to X
			for (UmtOps.Crash k : List.of(new UmtOps.Crash("R2", "write", 0, save), new UmtOps.Crash("K6", null, 0, save), new UmtOps.Crash("R2", "move",
				0, save), new UmtOps.Crash("R2", "read back", 0, save))) {
				Fixture f = fixture(false);
				try (UmtCase c = f.c()) {
					try {
						c.sim.remove(f.recs().get("H"), k);
						bad.add(k + ": no halt");
					} catch (UmtSim.Halt h) {
						c.sim.restart(true);
					}
					runs++;
					// the hand-down did not half apply: X, T and R stand with ACTIVE entries, no half-written generation is left (the start's
					// tidy). H: UMT models a removal as a queued RestoreJob, so after K5/K8 (R2 not durable) and K6 the removal resumes and
					// takes H down (pending, its entry UNDONE) and the next start settles it. In game a small site's removal (Sites.remove)
					// is not queued: after K5/K8 it is dropped and H stands, after K6 the evidence takes H back (4e-crash-full, release).
					List<String> notStanding = f.recs().values().stream().filter(x -> !x.id.equals(f.recs().get("H").id)).filter(x -> !c.sim.recs.containsKey(
						x.id) || x.placing || x.pending).map(x -> x.id).toList();
					if (!notStanding.isEmpty()) {
						bad.add(k + ": X, T and R don't all stand: " + notStanding + " (" + c.sim.recs.values() + ")");
					}
					String hId = f.recs().get("H").id;
					if (c.sim.store.index().entries().values().stream().anyMatch(m -> !m.site().equals(hId) && m.status() != Status.ACTIVE)) {
						bad.add(k + ": an entry of X, T or R is not ACTIVE: " + statuses(c));
					}
					List<String> stray = strayGenerations(c.sim.store);
					if (!stray.isEmpty()) {
						bad.add(k + ": half-written generations left after the start: " + stray);
					}
					c.sim.restart(false);
					if (c.sim.recs.containsKey(hId) && SiteJournal.active(hId).isEmpty()) {
						bad.add(k + ": H was neither settled nor standing after the next start (" + c.sim.recs.values() + "; " + statuses(c) + ")");
					}
					List<String> v = c.sim.end().stream().filter(x -> !x.startsWith("[UC] ")).toList();
					if (!v.isEmpty()) {
						bad.add(k + ": the final removal is not exact: " + v);
					}
				}
			}
		}
		assertTrue(runs == 20, "runs " + runs);
		assertTrue(bad.isEmpty(), String.join("\n", bad));
	}

	/**
	 * (4d-all row 13, 6a-eflat rows 6 and 7) Stages are subsets of one undo group: three stages placed, the last undone first then the
	 * first (4d), and a middle stage undone while a later one stands over it (6a's forced lots-3 under lots-4), and one lot alone: each
	 * removal leaves the standing ones exact, and the end is exact.
	 */
	@Test
	void stages4d6a_stageUndosAndOneLotAreExact() throws Exception {
		for (int variant = 0; variant < 3; variant++) {
			try (UmtCase c = UmtCase.of(w -> {
			})) {
				UmtSim.Rec s1 = c.site(0, G, 0, 2, G + 2, 2, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 1);
				UmtSim.Rec s2 = c.site(2, G, 0, 4, G + 2, 2, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 1);
				UmtSim.Rec s3a = c.site(4, G, 0, 6, G + 3, 2, Blocks.SPRUCE_PLANKS.defaultBlockState(), Map.of(), 1);
				UmtSim.Rec s3b = c.site(0, G, 4, 3, G + 2, 7, Blocks.BRICKS.defaultBlockState(), Map.of(), 1);
				switch (variant) {
					case 0 -> { // 4d: undo s3 (two lots) then s1
						c.sim.removeGroup(List.of(s3a, s3b), null);
						c.sim.removeGroup(List.of(s1), null);
					}
					case 1 -> { // 6a: the middle stage forced while the later one over its edge stands
						c.sim.removeGroup(List.of(s2), null);
						c.sim.removeGroup(List.of(s3a, s3b), null);
					}
					default -> c.sim.remove(s3b, null); // 6a: one lot's undo
				}
				c.sim.restart(false);
				exact(c.sim.end(), "variant " + variant);
			}
		}
	}

	/** (c30-ingame row 3) A staged group of six placed over overlapping lots and removed as one, twelve times: exact after every removal. */
	@Test
	void c30_aStagedGroupPlacedAndRemovedTwelveTimesIsExactEachTime() throws Exception {
		try (UmtCase c = UmtCase.of(w -> {
		})) {
			var before = c.sim.world.copy();
			for (int run = 0; run < 12; run++) {
				List<UmtSim.Rec> g = new ArrayList<>();
				g.add(c.sim.cells(UmtOps.Kind.ROAD, 2, Map.of(p(0, G, 7), Blocks.DIRT_PATH.defaultBlockState(), p(1, G, 7), Blocks.DIRT_PATH
					.defaultBlockState(), p(2, G, 7), Blocks.DIRT_PATH.defaultBlockState())));
				g.add(c.site(0, G, 0, 2, G + 2, 2, Blocks.OAK_PLANKS.defaultBlockState(), Map.of(), 2));
				g.add(c.site(2, G, 0, 4, G + 2, 2, Blocks.STONE_BRICKS.defaultBlockState(), Map.of(), 2));
				g.add(c.site(4, G, 0, 6, G + 2, 3, Blocks.SPRUCE_PLANKS.defaultBlockState(), Map.of(), 2));
				g.add(c.site(0, G, 3, 3, G + 1, 6, Blocks.BRICKS.defaultBlockState(), Map.of(), 2));
				g.add(c.site(3, G, 4, 6, G + 3, 6, Blocks.COBBLESTONE.defaultBlockState(), Map.of(), 2));
				c.sim.removeGroup(g, null);
				c.sim.restart(false);
				List<String> d = c.sim.world.diff(before, x -> false);
				assertTrue(d.isEmpty(), "run " + run + ": the lots are not as before: " + d.subList(0, Math.min(10, d.size())));
				assertTrue(c.sim.recs.isEmpty() && c.sim.store.index().entries().isEmpty(), "run " + run + ": not settled: " + c.sim.recs.values() + " "
					+ statuses(c));
			}
			exact(c.sim.end(), "c30");
		}
	}
}
