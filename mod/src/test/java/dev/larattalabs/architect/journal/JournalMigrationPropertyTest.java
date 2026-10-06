package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.V070World.SiteSpec;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.io.IOException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LeavesBlock;
import net.minecraft.world.level.block.state.BlockState;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The migration's property (docs/CONTRACT.md phase 5a "Migration unit tests", property test): random 0.7.0 worlds of 2-6 sites
 * with random held leaves, crates (a site's own or a group's shared one), stages and pending, placing and construction states
 * are migrated; then every undo group still standing is undone through journal planning ({@link Journal#planUndo}) in a
 * random order, and the cells equal the original snapshots (held leaves the natural leaf, crate cells what was there before).
 * The expected values are the generator's own, never a re-read of the files it wrote.
 */
class JournalMigrationPropertyTest {
	static final int WORLDS = 80;
	static final Value CRATE = Value.of("architect_mc:crate");

	@TempDir
	Path dir;

	@BeforeAll
	static void boot() {
		V070World.boot();
	}

	/** A held leaf: where, its recorded distance, what the world holds now, and whether it is still held. */
	record Held(long pos, int distance, BlockState now, boolean held) {
	}

	@Test
	void undoingEverythingAfterAMigrationGivesBackTheSnapshots() throws IOException {
		int pending = 0;
		int placing = 0;
		int construction = 0;
		int held = 0;
		int dropped = 0;
		int shared = 0;
		for (int i = 0; i < WORLDS; i++) {
			Random r = new Random(5000 + i);
			V070World w = new V070World(dir.resolve("w" + i));
			Map<Long, Value> world = new HashMap<>();
			List<SiteSpec> sites = new ArrayList<>();
			List<Held> leaves = new ArrayList<>();
			Map<Long, Value> crates = new LinkedHashMap<>();
			int n = 2 + r.nextInt(5);
			List<Integer> order = new ArrayList<>();
			for (int k = 0; k < n; k++) {
				order.add(k);
			}
			Collections.shuffle(order, r); // placedAt is not the file order
			List<SiteSpec> buildingSites = new ArrayList<>();
			for (int k = 0; k < n; k++) {
				int x = k * 24 + (k >= 3 ? 500 : 0); // some worlds span two 512-wide regions
				int z = r.nextInt(3) * 7 - 7;
				SiteSpec s = w.site("s" + (k + 1), x, 60 + r.nextInt(8), z, 2 + r.nextInt(4), 2 + r.nextInt(3), 2 + r.nextInt(4), V070WorldTimes.at(order.get(k)), r);
				sites.add(s);
				int kind = r.nextInt(10);
				if (kind < 2) {
					s.state = V070World.PENDING;
					s.at = V070WorldTimes.at(n + 1 + r.nextInt(5));
					pending++;
				} else if (kind < 4) {
					if (r.nextBoolean()) {
						w.placingJobs.add(s.id);
					} else {
						s.placingFlag = true;
					}
					placing++;
				} else if (kind < 7) {
					w.construction(s, r, V070World.crate(s.box.minX() + 1, s.box.minY(), s.snapBox.minZ() - 3));
					s.building = r.nextInt(4) != 0;
					construction++;
					if (s.building) {
						buildingSites.add(s);
					}
				}
				// the world now: what each state leaves
				for (long p : s.snapshot.keySet()) {
					Value v = switch (s.state) {
						case V070World.PENDING -> s.snapshot.get(p); // the 4d restore ran
						default -> {
							if (s.target != null) {
								yield s.building && r.nextBoolean() ? Journal.AIR : s.target.get(p); // queued cells cleared, some built
							}
							if (s.placingFlag || w.placingJobs.contains(s.id)) {
								yield r.nextBoolean() ? s.snapshot.get(p) : V070World.BUILDING[r.nextInt(V070World.BUILDING.length)];
							}
							yield V070World.BUILDING[r.nextInt(V070World.BUILDING.length)];
						}
					};
					world.put(p, v);
				}
				// held leaves, outside every restore box (0.7.0 never held a leaf in a standing site's box)
				if (!V070World.PENDING.equals(s.state)) {
					int nl = r.nextInt(4);
					for (int l = 0; l < nl; l++) {
						int lx = s.snapBox.minX() - 2 - r.nextInt(3);
						int ly = s.snapBox.minY() + l;
						int lz = s.snapBox.minZ() + r.nextInt(3);
						int d = 1 + r.nextInt(6);
						int roll = r.nextInt(5);
						BlockState now = roll == 0 ? Blocks.AIR.defaultBlockState() : V070World.leaf(roll != 1, 1 + r.nextInt(7)).setValue(LeavesBlock.WATERLOGGED,
							r.nextInt(6) == 0);
						w.hold(s, lx, ly, lz, d, now);
						leaves.add(new Held(Journal.pos(lx, ly, lz), d, now, roll > 1));
						world.put(Journal.pos(lx, ly, lz), WorldJournal.value(now));
					}
				}
			}
			// a group with a shared crate (2+ building construction sites), stages per site
			if (buildingSites.size() >= 2 && r.nextBoolean()) {
				List<SiteSpec> members = buildingSites.subList(0, 2 + r.nextInt(buildingSites.size() - 1));
				Construction.Crate c = members.get(0).crate;
				for (SiteSpec m : members) {
					m.crate = c;
				}
				w.group("g1", members, c);
				shared++;
			} else if (sites.size() >= 2 && r.nextBoolean()) {
				w.group("g1", sites.subList(0, 2), null); // a group without a crate
			}
			for (SiteSpec s : sites) {
				if (s.target != null && s.building && s.crate != null && !V070World.PENDING.equals(s.state)) {
					long cp = Journal.pos(s.crate.x(), s.crate.y(), s.crate.z());
					crates.put(cp, Value.of("minecraft:leaf_litter", "facing", "south", "segment_amount", "3"));
					world.put(cp, CRATE);
				}
			}
			w.write();
			Map<Long, Value> start = Map.copyOf(world);

			JournalStore store = JournalStore.open(w.dir);
			try {
				JournalMigration.Plan plan = JournalMigration.start(w, store);
				assertTrue(plan != null && plan.flagged().isEmpty(), "world " + i);
				// the undo groups still standing: a site's entries, a group's shared crate
				Map<String, List<String>> groups = new LinkedHashMap<>();
				Map<String, Entry> loaded = new LinkedHashMap<>();
				for (JournalStore.Meta m : store.index().entries().values()) {
					if (m.active()) {
						loaded.put(m.id(), store.load(m.id()));
						groups.computeIfAbsent(m.site(), k -> new ArrayList<>()).add(m.id());
					} else {
						assertEquals(Journal.Status.UNDONE, m.status());
					}
				}
				List<String> units = new ArrayList<>(groups.keySet());
				Collections.shuffle(units, r);
				for (String u : units) {
					List<String> ids = groups.get(u);
					Journal.UndoPlan p = Journal.planUndo(loaded.values(), ids, "test:" + u, 1L, (pos, after) -> world.get(pos).equals(after), Journal.Match.EQUAL);
					for (Journal.Write wr : p.writes()) {
						world.put(wr.pos(), wr.value());
					}
					loaded.putAll(p.updated());
					ids.forEach(loaded::remove);
				}
				assertTrue(loaded.isEmpty());
				// the cells equal the original snapshots
				for (SiteSpec s : sites) {
					for (var e : s.snapshot.entrySet()) {
						assertEquals(e.getValue(), world.get(e.getKey()), "world " + i + " " + s.id + " (" + s.state + ") at " + BlockPos.of(e.getKey()));
					}
				}
				for (Held h : leaves) {
					if (h.held()) {
						BlockState natural = h.now().setValue(LeavesBlock.PERSISTENT, false).setValue(LeavesBlock.DISTANCE, h.distance());
						assertEquals(WorldJournal.value(natural), world.get(h.pos()), "world " + i + " held leaf at " + BlockPos.of(h.pos()));
						held++;
					} else {
						assertEquals(start.get(h.pos()), world.get(h.pos()), "world " + i + ": a leaf no longer held is left as it is");
						dropped++;
					}
				}
				crates.forEach((p, v) -> assertEquals(v, world.get(p), "crate cell"));
				// nothing else was written
				for (var e : world.entrySet()) {
					boolean ours = sites.stream().anyMatch(s -> s.snapshot.containsKey(e.getKey())) || crates.containsKey(e.getKey())
						|| leaves.stream().anyMatch(h -> h.pos() == e.getKey());
					assertTrue(ours, "world " + i + ": a write outside the sites at " + BlockPos.of(e.getKey()));
				}
				assertFalse(store.find(m -> m.site().startsWith(SiteGroupRec.CRATE_PREFIX)).size() > 1);
			} finally {
				store.close();
			}
		}
		// the generator reached every kind of state
		assertTrue(pending > 5 && placing > 5 && construction > 5 && held > 20 && dropped > 5 && shared > 2,
			"pending " + pending + ", placing " + placing + ", construction " + construction + ", held " + held + ", dropped " + dropped + ", shared " + shared);
	}

	/** Distinct record times. */
	static final class V070WorldTimes {
		static long at(int k) {
			return 1_791_100_000_000L + k * 60_000L;
		}
	}
}
