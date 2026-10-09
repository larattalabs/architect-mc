package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Gate item 1 (mod, world seam) and item 8 for regions, on the journal's own rules over random fixtures:
 * <ul>
 * <li>a tile's P1 with conditions: cells owned by a site (BOX) or another owner are skipped, IF_NATURAL skips built blocks,
 * ALWAYS_OURS writes over this region's own earlier tiles, no-op cells are skipped: the PLACING entry holds only what passed;</li>
 * <li>region undo planned as one group equals undoing tile by tile in reverse order (with and without player edits);</li>
 * <li>without edits the group undo gives the original world back; a player's block on a pad cell survives it (kept);</li>
 * <li>invariant (iii) for regions: a lot LAYERed on a pad, a player edit on a lot cell: undoing pad then lot, or lot then pad,
 * gives the same end state (a region never writes CELL over BOX).</li>
 * </ul>
 */
class RegionJournalTest {
	static final Value GRASS = Value.of("minecraft:grass_block");
	static final Value DIRT = Value.of("minecraft:dirt");
	static final Value STONE = Value.of("minecraft:stone");
	static final Value AIR = Journal.AIR;
	static final Value BRICKS = Value.of("minecraft:stone_bricks");
	static final Value PLANKS = Value.of("minecraft:spruce_planks");
	static final Value PATH = Value.of("minecraft:dirt_path");
	static final Value PLAYER = Value.of("minecraft:gold_block");
	static final Set<String> NATURAL = Set.of("minecraft:grass_block", "minecraft:dirt", "minecraft:stone", "minecraft:air", "minecraft:dirt_path");
	static final int IF_NATURAL = 0;
	static final int ALWAYS_OURS = 3;

	/** A world, its journal, and who owns what (owner per entry). */
	static final class W {
		final Map<Long, Value> world = new HashMap<>();
		final Map<String, Entry> entries = new LinkedHashMap<>();
		final Map<String, String> owner = new HashMap<>();
		final Map<String, Boolean> regionTile = new HashMap<>();
		long layer = 1;

		Value at(long p) {
			return world.getOrDefault(p, Journal.y(p) < 64 ? STONE : Journal.y(p) == 64 ? GRASS : AIR);
		}

		/** A region tile's P1-P3 + P5: conditions and ownership resolved against the world now; returns the cells that passed. */
		Map<Long, Value> tile(String id, String region, Map<Long, Value> to, Map<Long, Integer> cond) {
			Map<Long, Value> passed = new LinkedHashMap<>();
			for (var e : to.entrySet()) {
				long p = e.getKey();
				var st = Journal.stack(entries.values(), p);
				boolean others = false;
				boolean ours = false;
				for (var x : st) {
					String eid = x.getKey().id();
					if (Boolean.TRUE.equals(regionTile.get(eid)) && region.equals(owner.get(eid))) {
						ours = true;
					} else {
						others = true;
					}
				}
				if (others) {
					continue; // skipped, owned
				}
				Value now = at(p);
				boolean natural = NATURAL.contains(now.name());
				int c = cond.getOrDefault(p, IF_NATURAL);
				boolean ok = c == ALWAYS_OURS ? ours || natural : natural;
				if (!ok || now.equals(e.getValue())) {
					continue; // condition, or no change
				}
				passed.put(p, e.getValue());
			}
			change(id, Policy.CELL, passed, region, true);
			return passed;
		}

		Entry change(String id, Policy policy, Map<Long, Value> to, String own, boolean tile) {
			List<Cell> cells = new ArrayList<>();
			long l = layer++;
			for (var t : to.entrySet()) {
				cells.add(new Cell(t.getKey(), l, at(t.getKey()), t.getValue()));
				world.put(t.getKey(), t.getValue());
			}
			Entry e = new Entry(id, policy == Policy.BOX ? "site" : "architect:terrain", id, "minecraft:overworld", policy, l, Status.ACTIVE, cells, null, null);
			entries.put(id, e);
			owner.put(id, own);
			regionTile.put(id, tile);
			return e;
		}

		void undo(List<String> ids) {
			Journal.UndoPlan p = Journal.planUndo(entries.values(), ids, ids.get(0), 0L, (pos, after) -> at(pos).equals(after), Journal.Match.EQUAL);
			for (Journal.Write w : p.writes()) {
				world.put(w.pos(), w.value());
			}
			entries.putAll(p.updated());
			ids.forEach(entries::remove);
		}

		W copy() {
			W s = new W();
			s.world.putAll(world);
			s.entries.putAll(entries);
			s.owner.putAll(owner);
			s.regionTile.putAll(regionTile);
			s.layer = layer;
			return s;
		}
	}

	static final List<Long> POS = new ArrayList<>();

	static {
		for (int x = 0; x < 6; x++) {
			for (int z = 0; z < 4; z++) {
				for (int y = 62; y <= 67; y++) {
					POS.add(Journal.pos(x, y, z));
				}
			}
		}
	}

	static Map<Long, Value> snapshot(W w) {
		Map<Long, Value> out = new HashMap<>();
		for (long p : POS) {
			out.put(p, w.at(p));
		}
		return out;
	}

	/** A random region over the world: 2-4 tiles in stage 1 (pads, carve), 1-3 later tiles (paths ALWAYS_OURS), maybe a lot. */
	static List<String> realise(W w, Random r, String region, boolean lot) {
		List<String> tiles = new ArrayList<>();
		int t1 = 2 + r.nextInt(3);
		Value[] pal = {AIR, DIRT, STONE, BRICKS, PLANKS};
		for (int i = 0; i < t1 + 1 + r.nextInt(3); i++) {
			boolean later = i >= t1;
			Map<Long, Value> to = new LinkedHashMap<>();
			Map<Long, Integer> cond = new HashMap<>();
			for (long p : POS) {
				if (r.nextInt(3) == 0) {
					to.put(p, later ? PATH : pal[r.nextInt(pal.length)]);
					cond.put(p, later ? ALWAYS_OURS : IF_NATURAL);
				}
			}
			String id = region + "t" + i;
			w.tile(id, region, to, cond);
			tiles.add(id);
		}
		if (lot) {
			Map<Long, Value> box = new LinkedHashMap<>();
			for (long p : POS) {
				if (Journal.x(p) >= 2 && Journal.x(p) <= 3 && Journal.y(p) >= 65) {
					box.put(p, PLANKS);
				}
			}
			w.change(region + "lot", Policy.BOX, box, region, false);
			tiles.add(region + "lot");
		}
		return tiles;
	}

	@Test
	void tileChecksSkipSitesOtherOwnersBuiltBlocksAndNoOps() {
		W w = new W();
		long built = Journal.pos(0, 64, 0);
		long site = Journal.pos(1, 64, 0);
		long foreign = Journal.pos(2, 64, 0);
		long same = Journal.pos(3, 63, 0);
		long free = Journal.pos(4, 64, 0);
		w.world.put(built, BRICKS); // a player's block
		w.change("lotX", Policy.BOX, Map.of(site, PLANKS), "steward", false);
		w.change("other", Policy.CELL, Map.of(foreign, DIRT), "someone", true);
		Map<Long, Value> to = new LinkedHashMap<>();
		for (long p : List.of(built, site, foreign, same, free)) {
			to.put(p, STONE);
		}
		Map<Long, Value> passed = w.tile("t0", "steward", to, Map.of());
		assertEquals(Map.of(free, STONE), passed, "only the free natural cell is written");
		// ALWAYS_OURS over the region's own tile cell; IF_NATURAL would skip bricks the region itself wrote
		w.tile("t1", "steward", Map.of(Journal.pos(5, 64, 0), BRICKS), Map.of());
		Map<Long, Value> notOurs = w.tile("t3", "steward", Map.of(Journal.pos(5, 64, 0), STONE), Map.of());
		assertTrue(notOurs.isEmpty(), "IF_NATURAL leaves a non-natural block, even the region's own");
		Map<Long, Value> again = w.tile("t2", "steward", Map.of(Journal.pos(5, 64, 0), PATH), Map.of(Journal.pos(5, 64, 0), ALWAYS_OURS));
		assertEquals(1, again.size());
		Map<Long, Value> foreignOurs = w.tile("t4", "other", Map.of(Journal.pos(5, 64, 0), PATH), Map.of(Journal.pos(5, 64, 0), ALWAYS_OURS));
		assertTrue(foreignOurs.isEmpty(), "another region's tiles are not ours");
	}

	@Test
	void groupUndoEqualsTileByTileAndGivesTheWorldBack() {
		Random r = new Random(6060);
		for (int f = 0; f < 300; f++) {
			W w = new W();
			Map<Long, Value> h0 = snapshot(w);
			List<String> ids = realise(w, r, "steward", f % 3 == 0);
			boolean edits = f % 2 == 1;
			Set<Long> edited = new HashSet<>();
			if (edits) {
				for (int i = 0; i < 3; i++) {
					long p = POS.get(r.nextInt(POS.size()));
					w.world.put(p, PLAYER);
					edited.add(p);
				}
			}
			W g = w.copy();
			g.undo(ids);
			W t = w.copy();
			List<String> rev = new ArrayList<>(ids);
			Collections.reverse(rev);
			for (String id : rev) {
				t.undo(List.of(id));
			}
			assertEquals(snapshot(t), snapshot(g), "fixture " + f + ": the group undo and tile by tile in reverse order differ");
			if (!edits) {
				assertEquals(h0, snapshot(g), "fixture " + f + ": the undo is not exact");
			} else {
				for (long p : edited) {
					boolean onBox = ids.stream().anyMatch(id -> id.endsWith("lot") && w.entries.get(id).cells().stream().anyMatch(c -> c.pos() == p));
					if (!onBox) {
						assertEquals(PLAYER, g.at(p), "fixture " + f + ": a player's block on a region cell must survive the undo (kept)");
					}
				}
			}
		}
	}

	@Test
	void invariantIiiForRegionsPadAndLotInEitherOrder() {
		Random r = new Random(806);
		for (int f = 0; f < 300; f++) {
			W w = new W();
			List<String> ids = realise(w, r, "steward", true);
			String lot = ids.get(ids.size() - 1);
			// a player edit on a lot cell
			Cell c = w.entries.get(lot).cells().get(r.nextInt(w.entries.get(lot).cells().size()));
			w.world.put(c.pos(), PLAYER);
			List<String> pads = ids.subList(0, ids.size() - 1);
			W a = w.copy();
			a.undo(new ArrayList<>(pads));
			a.undo(List.of(lot));
			W b = w.copy();
			b.undo(List.of(lot));
			b.undo(new ArrayList<>(pads));
			assertEquals(snapshot(a), snapshot(b), "fixture " + f + ": pad then lot and lot then pad differ");
			// and no tile cell lies over a BOX cell
			for (String id : pads) {
				for (Cell tc : w.entries.get(id).cells()) {
					var st = Journal.stack(w.entries.values(), tc.pos());
					boolean boxBelow = false;
					for (var x : st) {
						if (x.getKey().id().equals(id)) {
							assertTrue(!boxBelow, "a tile cell over a BOX cell");
						}
						boxBelow |= x.getKey().policy() == Policy.BOX;
					}
				}
			}
		}
	}
}
