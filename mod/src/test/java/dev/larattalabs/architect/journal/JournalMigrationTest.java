package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import dev.larattalabs.architect.journal.V070World.SiteSpec;
import dev.larattalabs.architect.placement.Anchors;
import dev.larattalabs.architect.placement.Reconcile;
import dev.larattalabs.architect.site.Construction;
import dev.larattalabs.architect.site.Infra;
import dev.larattalabs.architect.site.Site;
import dev.larattalabs.architect.site.SiteGroupRec;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtAccounter;
import net.minecraft.nbt.NbtIo;
import net.minecraft.world.level.block.Blocks;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The 4d -> 4e import ({@link JournalMigration}) without a server (docs/CONTRACT.md phase 5a "Migration unit tests (the 4e
 * caveat)", one test per numbered case, plus a real-file fixture). The world is {@link V070World}: synthetic 0.7.0 files and a
 * map of block states as the {@link JournalMigration.MigrationWorld}. A world start is {@link JournalMigration#start}, the
 * decision the server makes when its journal opened.
 */
class JournalMigrationTest {
	@TempDir
	Path dir;

	JournalStore store;

	@BeforeAll
	static void boot() {
		V070World.boot();
	}

	@AfterEach
	void close() {
		JournalStore.faultHook = null;
		if (store != null) {
			store.close();
		}
	}

	/** A world start: opens the journal (closing the previous one) and runs the start-up import. */
	JournalMigration.Plan start(V070World w) throws IOException {
		if (store != null) {
			store.close();
		}
		store = JournalStore.open(w.dir);
		return JournalMigration.start(w, store);
	}

	List<JournalStore.Meta> entries(String site) {
		return store.find(m -> m.site().equals(site));
	}

	JournalStore.Meta only(String site, String kind) {
		List<JournalStore.Meta> ms = store.find(m -> m.site().equals(site) && m.kind().equals(kind));
		assertEquals(1, ms.size(), site + "/" + kind + ": " + ms);
		return ms.get(0);
	}

	Map<Long, Cell> cells(JournalStore.Meta m) throws IOException {
		Map<Long, Cell> out = new HashMap<>();
		for (Cell c : store.load(m.id()).cells()) {
			assertNull(out.put(c.pos(), c), "one cell per position");
		}
		return out;
	}

	static long t(int n) {
		return 1_791_000_000_000L + n * 1000L;
	}

	// ------------------------------------------------------------------ 1-3: a standing site, its ring and held leaves

	@Test
	void instantSiteBecomesAnActiveBoxEntryWithTheSnapshotAsBefore() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 10, 64, 10, 5, 4, 6, t(1), new Random(1));
		a.snapshot.put(Journal.pos(10, 63, 10), V070World.chest(true)); // a filled chest in the terrain: its BE NBT must survive
		w.write();
		JournalMigration.Plan p = start(w);
		assertNotNull(p);
		assertFalse(p.late());
		assertEquals(1, p.entries());
		JournalStore.Meta m = only("s1", WorldJournal.SITE);
		assertEquals(Status.ACTIVE, m.status());
		assertEquals(Policy.BOX, m.policy());
		assertEquals(V070World.DIM, m.dimension());
		assertEquals(t(1), m.createdAt());
		assertEquals(a.snapBox.volume(), m.cells());
		assertArrayEquals(new int[] {a.snapBox.minX(), a.snapBox.minY(), a.snapBox.minZ(), a.snapBox.maxX(), a.snapBox.maxY(), a.snapBox.maxZ()}, m.box());
		Map<Long, Cell> cs = cells(m);
		assertEquals(a.snapshot.keySet(), cs.keySet(), "the restore box, cell for cell");
		for (var e : a.snapshot.entrySet()) {
			Cell c = cs.get(e.getKey());
			assertEquals(e.getValue(), c.before(), "before = the snapshot's block and BE NBT at " + e.getKey());
			assertNull(c.after(), "after unknown");
			assertEquals(m.layer(), c.layer());
		}
		assertEquals(V070World.chest(true).nbt(), cs.get(Journal.pos(10, 63, 10)).before().nbt());
		// the record is the entry's meta; the old file name maps to the entry
		assertEquals(a.site().toJson(), store.head(m.id()).meta());
		assertEquals(Map.of(JournalMigration.SNAPSHOT_DIR + "/" + a.snapshotFile, m.id()), store.index().legacy());
		assertEquals(List.of(a.snapshotFile), V070World.list(w.legacyDir()));
		assertFalse(Files.exists(w.snapDir()));
		assertTrue(store.durable() == store.index(), "the commit is durable");
	}

	@Test
	void leafRingBecomesTheEntrysRingUnchanged() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 70, 0, 4, 3, 4, t(1), new Random(2));
		a.ring = new int[] {-2, 71, 3, 5, 9, 72, -1, 2, 5, 70, 8, 6};
		SiteSpec b = w.site("s2", 30, 70, 0, 3, 3, 3, t(2), new Random(3)); // no ring
		w.write();
		start(w);
		assertArrayEquals(a.ring, store.head(only("s1", WorldJournal.SITE).id()).ring());
		assertArrayEquals(new int[0], store.head(only(b.id, WorldJournal.SITE).id()).ring());
	}

	@Test
	void heldLeavesBecomeALeavesCellEntryAndLeavesNoLongerHeldAreDropped() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 70, 0, 4, 3, 4, t(1), new Random(4));
		w.hold(a, -3, 72, 1, 3, V070World.leaf(true, 3)); // held
		w.hold(a, -3, 73, 1, 2, V070World.leaf(true, 7).setValue(net.minecraft.world.level.block.LeavesBlock.WATERLOGGED, true)); // held, read as is
		w.hold(a, 6, 71, 2, 4, V070World.leaf(false, 4)); // decayed back to natural: not held
		w.hold(a, 6, 72, 2, 5, Blocks.AIR.defaultBlockState()); // gone
		w.write();
		JournalMigration.Plan p = start(w);
		JournalStore.Meta site = only("s1", WorldJournal.SITE);
		JournalStore.Meta lv = only("s1", WorldJournal.LEAVES);
		assertEquals(Policy.CELL, lv.policy());
		assertEquals(Status.ACTIVE, lv.status());
		assertEquals(site.group(), lv.group());
		Map<Long, Cell> cs = cells(lv);
		assertEquals(Set.of(Journal.pos(-3, 72, 1), Journal.pos(-3, 73, 1)), cs.keySet());
		Cell c1 = cs.get(Journal.pos(-3, 72, 1));
		assertEquals(WorldJournal.value(V070World.leaf(false, 3)), c1.before(), "before = the natural leaf with the recorded distance");
		assertEquals(WorldJournal.value(V070World.leaf(true, 3)), c1.after(), "after = the leaf as read");
		Cell c2 = cs.get(Journal.pos(-3, 73, 1));
		assertEquals(WorldJournal.value(V070World.leaf(false, 2).setValue(net.minecraft.world.level.block.LeavesBlock.WATERLOGGED, true)), c2.before());
		assertEquals(WorldJournal.value(V070World.leaf(true, 7).setValue(net.minecraft.world.level.block.LeavesBlock.WATERLOGGED, true)), c2.after());
		assertTrue(p.notes().stream().anyMatch(n -> n.startsWith("s1: 2 held leaves are no longer persistent leaves")), p.notes().toString());
		// a dimension the server doesn't have: no leaves entry, the site still imports
		V070World w2 = new V070World(dir.resolve("other"));
		SiteSpec b = w2.site("s1", 0, 70, 0, 4, 3, 4, t(1), new Random(4));
		b.dimension = "minecraft:the_moon";
		w2.hold(b, -3, 72, 1, 3, V070World.leaf(true, 3));
		Files.createDirectories(w2.dir);
		w2.write();
		start(w2);
		assertEquals(1, store.index().entries().size());
		only("s1", WorldJournal.SITE);
	}

	// ------------------------------------------------------------------ 4-5: construction targets and crates

	@Test
	void constructionTargetBecomesTheEntrysAfterAndTheQueueIndexesMapToEntryCells() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec c = w.site("s1", 100, 64, -40, 6, 5, 7, t(1), new Random(5));
		w.construction(c, new Random(6), V070World.crate(100, 65, -50));
		w.write();
		JournalMigration.Plan p = start(w);
		JournalStore.Meta m = only("s1", WorldJournal.SITE);
		Map<Long, Cell> cs = cells(m);
		for (var e : c.target.entrySet()) {
			assertEquals(e.getValue(), cs.get(e.getKey()).after(), "after = the target at " + e.getKey());
			assertEquals(c.snapshot.get(e.getKey()), cs.get(e.getKey()).before());
		}
		// the queue (restore-box indexes, x fastest, then z, then y, as 0.7.0 wrote them) names entry cells whose after is the
		// target block it queued: the record's queue needs no rewrite
		Construction con = c.site().construction();
		Anchors.Bounds rb = c.site().restoreBox();
		int dx = rb.maxX() - rb.minX() + 1;
		int dz = rb.maxZ() - rb.minZ() + 1;
		for (int i = 0; i < con.size(); i++) {
			int[] o = Construction.offsets(con.cell(i), dx, dz);
			long pos = Journal.pos(rb.minX() + o[0], rb.minY() + o[1], rb.minZ() + o[2]);
			Cell cell = cs.get(pos);
			assertNotNull(cell, "queue index " + i + " is an entry cell");
			assertEquals(c.target.get(pos), cell.after());
			assertFalse(cell.after().equals(Journal.AIR), "queued cells are not air");
		}
		// what SiteJournal.target reads back: every cell's after, so the Builder's run has its plan
		assertTrue(cs.values().stream().allMatch(x -> x.after() != null));
		assertEquals(m.id(), store.index().legacy().get(JournalMigration.SNAPSHOT_DIR + "/" + c.targetFile));
		assertEquals(Set.of(c.snapshotFile, c.targetFile), Set.copyOf(V070World.list(w.legacyDir())));
		assertTrue(p.notes().isEmpty(), p.notes().toString());
	}

	@Test
	void cratesBecomeCrateBoxEntriesInTheSitesOrTheGroupsUndoGroup() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec c = w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(7));
		w.construction(c, new Random(8), V070World.crate(0, 65, -3));
		SiteSpec g1 = w.site("s2", 20, 64, 0, 4, 3, 4, t(2), new Random(9));
		SiteSpec g2 = w.site("s3", 30, 64, 0, 4, 3, 4, t(3), new Random(10));
		Construction.Crate shared = V070World.crate(26, 65, -3);
		w.construction(g1, new Random(11), shared);
		w.construction(g2, new Random(12), shared);
		w.group("g1", List.of(g1, g2), shared);
		SiteSpec done = w.site("s4", 50, 64, 0, 4, 3, 4, t(4), new Random(13));
		w.construction(done, new Random(14), V070World.crate(50, 65, -3));
		done.building = false; // built: its crate went
		w.write();
		start(w);
		// the site's own crate: its undo group is the site's
		JournalStore.Meta cr = only("s1", WorldJournal.CRATE);
		assertEquals(Policy.BOX, cr.policy());
		assertEquals(Status.ACTIVE, cr.status());
		Map<Long, Cell> cs = cells(cr);
		assertEquals(Set.of(Journal.pos(0, 65, -3)), cs.keySet());
		assertEquals(Value.of("minecraft:leaf_litter", "facing", "south", "segment_amount", "3"), cs.get(Journal.pos(0, 65, -3)).before());
		// the group's shared crate: one entry, owned by the group
		List<JournalStore.Meta> crates = store.find(m -> m.kind().equals(WorldJournal.CRATE));
		assertEquals(2, crates.size(), crates.toString());
		JournalStore.Meta gc = only(SiteGroupRec.CRATE_PREFIX + "g1", WorldJournal.CRATE);
		assertEquals("g1", gc.group());
		assertEquals(Set.of(Journal.pos(26, 65, -3)), cells(gc).keySet());
		assertTrue(store.find(m -> m.kind().equals(WorldJournal.CRATE) && (m.site().equals("s2") || m.site().equals("s3"))).isEmpty());
		assertEquals("g1", only("s2", WorldJournal.SITE).group());
		assertEquals("g1", only("s3", WorldJournal.SITE).group());
		// a built site has no crate any more
		assertTrue(store.find(m -> m.site().equals("s4") && m.kind().equals(WorldJournal.CRATE)).isEmpty());
		// each site's entries are consecutive layers (site, then crate)
		assertEquals(only("s1", WorldJournal.SITE).layer() + 1, cr.layer());
		assertEquals(only("s2", WorldJournal.SITE).layer() + 1, gc.layer());
	}

	// ------------------------------------------------------------------ 6-7: pending and placing sites

	@Test
	void pendingSiteBecomesUndoneEntriesThatTheEvidenceSettles() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec d = w.site("s1", 0, 64, 0, 5, 4, 5, t(1), new Random(15));
		d.state = V070World.PENDING;
		d.at = t(9);
		w.hold(d, -2, 66, 0, 2, V070World.leaf(true, 2)); // a pending site's leaves were released by its removal: no entry
		w.construction(d, new Random(16), V070World.crate(0, 65, -3)); // and its crate went with it
		SiteSpec a = w.site("s2", 20, 64, 0, 3, 3, 3, t(2), new Random(17));
		w.write();
		start(w);
		JournalStore.Meta m = only("s1", WorldJournal.SITE);
		assertEquals(1, entries("s1").size(), "only the site entry");
		assertEquals(Status.UNDONE, m.status());
		assertEquals("migrated:s1:" + t(9), m.undoGroup());
		assertEquals(t(9), m.undoneAt());
		Journal.Entry e = store.load(m.id());
		assertNotNull(e.undo());
		assertEquals(d.snapshot.size(), e.undo().written().size(), "the undo wrote the whole box");
		for (var x : d.snapshot.entrySet()) {
			assertEquals(x.getValue(), e.undo().written().get(x.getKey()));
		}
		assertTrue(e.undo().handed().isEmpty());
		// not in any stack: nothing is on top of the pending site's cells
		assertFalse(m.active());
		// settled by the existing evidence (Reconcile.restored over the cells where the undo's writes and the building differ):
		// a world showing the restored terrain settles as restored, a world still showing the building does not
		Map<Long, Value> restoredWorld = d.snapshot;
		Map<Long, Value> standingWorld = d.target;
		int total = 0;
		int matchRestored = 0;
		int matchStanding = 0;
		for (var x : e.undo().written().entrySet()) {
			if (x.getValue().equals(d.target.get(x.getKey()))) {
				continue;
			}
			total++;
			matchRestored += restoredWorld.get(x.getKey()).equals(x.getValue()) ? 1 : 0;
			matchStanding += standingWorld.get(x.getKey()).equals(x.getValue()) ? 1 : 0;
		}
		assertTrue(total > 0);
		assertEquals(Boolean.TRUE, Reconcile.restored(matchRestored, total));
		assertEquals(Boolean.FALSE, Reconcile.restored(matchStanding, total));
	}

	@Test
	void placingSiteBecomesAPlacingEntryAndTheQueueFileIsUnchanged() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(18));
		SiteSpec p = w.site("s2", 20, 64, 0, 5, 4, 5, t(2), new Random(19));
		w.placingJobs.add("s2"); // the queue file's job
		SiteSpec q = w.site("s3", 40, 64, 0, 3, 3, 3, t(3), new Random(20));
		q.placingFlag = true; // the record's own flag (its job was lost)
		w.write();
		byte[] queue = Files.readAllBytes(dir.resolve("architect-queue.json"));
		start(w);
		assertEquals(Status.ACTIVE, only(a.id, WorldJournal.SITE).status());
		for (SiteSpec s : List.of(p, q)) {
			JournalStore.Meta m = only(s.id, WorldJournal.SITE);
			assertEquals(Status.PLACING, m.status(), s.id);
			Map<Long, Cell> cs = cells(m);
			for (var x : s.snapshot.entrySet()) {
				assertEquals(x.getValue(), cs.get(x.getKey()).before());
				assertNull(cs.get(x.getKey()).after());
			}
		}
		assertArrayEquals(queue, Files.readAllBytes(dir.resolve("architect-queue.json")), "the queue file is unchanged");
	}

	// ------------------------------------------------------------------ 8-12

	@Test
	void groupsStagesAndBatchesAreUnchanged() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(21));
		SiteSpec b = w.site("s2", 10, 64, 0, 4, 3, 4, t(2), new Random(22));
		SiteSpec c = w.site("s3", 20, 64, 0, 4, 3, 4, t(3), new Random(23));
		w.group("g1", List.of(a, b), null);
		w.group("g2", List.of(c), null);
		w.placingJobs.add("s9"); // a queue file with batches (no such site: nothing imported for it)
		w.write();
		byte[] sites = Files.readAllBytes(w.sitesFile());
		byte[] queue = Files.readAllBytes(dir.resolve("architect-queue.json"));
		start(w);
		assertArrayEquals(sites, Files.readAllBytes(w.sitesFile()), "architect-sites.json is not written");
		assertArrayEquals(queue, Files.readAllBytes(dir.resolve("architect-queue.json")));
		Site.FileData d = Site.fileFromJson(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject());
		assertEquals(w.groups.stream().map(SiteGroupRec::toJson).toList(), d.groups().stream().map(SiteGroupRec::toJson).toList());
		assertEquals(3, d.nextGroup());
		// the records name no entries; the entries carry the group
		for (Site s : d.sites()) {
			assertFalse(s.toJson().toString().contains("\"j1\""), s.toJson().toString());
			assertEquals(s.group(), only(s.id(), WorldJournal.SITE).group());
		}
		assertEquals("g1", only("s1", WorldJournal.SITE).group());
		assertEquals("g2", only("s3", WorldJournal.SITE).group());
		assertTrue(store.find(m -> m.site().equals("s9")).isEmpty());
	}

	@Test
	void unreferencedSnapshotFilesAreNotImportedButMovedAndListed() throws IOException {
		V070World w = new V070World(dir);
		w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(24));
		w.extraFiles.put("s7-1791000000000.nbt", new byte[] {1, 2, 3}); // a snapshot no record names (a forget)
		w.extraFiles.put("s8-1791000000001-target.nbt", new byte[] {4});
		w.write();
		JournalMigration.Plan p = start(w);
		assertEquals(1, store.index().entries().size());
		assertEquals(1, store.index().legacy().size(), "only the imported snapshot is a legacy name: " + store.index().legacy());
		List<String> moved = V070World.list(w.legacyDir());
		assertTrue(moved.containsAll(List.of("s7-1791000000000.nbt", "s8-1791000000001-target.nbt")), moved.toString());
		assertArrayEquals(new byte[] {1, 2, 3}, Files.readAllBytes(w.legacyDir().resolve("s7-1791000000000.nbt")));
		assertFalse(Files.exists(w.snapDir()));
		assertTrue(p.notes().stream().anyMatch(n -> n.contains("no record names") && n.contains("s7-1791000000000.nbt") && n.contains(
			"s8-1791000000001-target.nbt")), p.notes().toString());
	}

	@Test
	void layersFollowPlacedAtAndEachSitesEntriesAreConsecutive() throws IOException {
		V070World w = new V070World(dir);
		// written out of order; the pending site was placed first and removed last
		SiteSpec c = w.site("s3", 40, 64, 0, 4, 3, 4, t(30), new Random(25));
		w.construction(c, new Random(26), V070World.crate(40, 65, -3));
		w.hold(c, 39, 66, -1, 2, V070World.leaf(true, 2));
		SiteSpec a = w.site("s1", 0, 64, 0, 4, 3, 4, t(10), new Random(27));
		w.hold(a, -1, 66, -1, 1, V070World.leaf(true, 1));
		SiteSpec d = w.site("s2", 20, 64, 0, 4, 3, 4, t(5), new Random(28));
		d.state = V070World.PENDING;
		d.at = t(50);
		SiteSpec b = w.site("s4", 60, 64, 0, 4, 3, 4, t(20), new Random(29));
		w.write();
		start(w);
		List<String> order = new ArrayList<>();
		long last = 0;
		for (JournalStore.Meta m : store.index().entries().values().stream().sorted(java.util.Comparator.comparingLong(JournalStore.Meta::layer)).toList()) {
			assertTrue(m.layer() > last);
			last = m.layer();
			order.add(m.site() + "/" + m.kind());
		}
		assertEquals(List.of("s2/site", "s1/site", "s1/leaves", "s4/site", "s3/site", "s3/leaves", "s3/crate"), order);
		// consecutive: no gaps inside a site
		List<JournalStore.Meta> s3 = entries("s3").stream().sorted(java.util.Comparator.comparingLong(JournalStore.Meta::layer)).toList();
		assertEquals(s3.get(0).layer() + 2, s3.get(2).layer());
	}

	@Test
	void anUnreadableSnapshotFlagsItsSiteWithoutAnEntry() throws IOException {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(30));
		SiteSpec bad = w.site("s2", 20, 64, 0, 4, 3, 4, t(2), new Random(31));
		bad.unreadable = true;
		SiteSpec notTemplate = w.site("s3", 40, 64, 0, 4, 3, 4, t(3), new Random(32));
		w.write();
		CompoundTag junk = new CompoundTag();
		junk.putString("what", "not a template");
		NbtIo.writeCompressed(junk, w.snapDir().resolve(notTemplate.snapshotFile));
		JournalMigration.Plan p = start(w);
		assertEquals(List.of("s2", "s3"), p.flagged());
		assertEquals(1, p.entries());
		only(a.id, WorldJournal.SITE);
		assertTrue(entries("s2").isEmpty());
		assertTrue(entries("s3").isEmpty());
		assertTrue(p.notes().stream().anyMatch(n -> n.startsWith("s2: snapshot " + bad.snapshotFile + " unreadable")), p.notes().toString());
		assertTrue(p.notes().stream().anyMatch(n -> n.startsWith("s3: snapshot " + notTemplate.snapshotFile + " unreadable")), p.notes().toString());
		assertFalse(store.index().legacy().containsKey(JournalMigration.SNAPSHOT_DIR + "/" + bad.snapshotFile));
		// the record stays (Remove refuses it; forget is the way out), the file is kept with the rest
		assertTrue(Files.readString(w.sitesFile()).contains("\"s2\""));
		assertTrue(V070World.list(w.legacyDir()).contains(bad.snapshotFile));
	}

	@Test
	void anUnreadableSitesFileWritesNothing() throws IOException {
		V070World w = new V070World(dir);
		w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(33));
		w.write();
		Files.writeString(w.sitesFile(), "{\"sites\": [ {\"id\": \"s1\" ", StandardCharsets.UTF_8);
		List<String> before = V070World.list(w.snapDir());
		store = JournalStore.open(dir);
		IOException e = assertThrows(IOException.class, () -> JournalMigration.start(w, store));
		assertTrue(e.getMessage().contains(JournalMigration.SITES_FILE), e.getMessage());
		assertFalse(Files.exists(JournalStore.dirOf(dir)), "no journal folder");
		assertEquals(before, V070World.list(w.snapDir()));
		assertTrue(store.index().entries().isEmpty());
		// the next start (the file fixed) imports
		w.write();
		assertEquals(1, start(w).entries());
	}

	// ------------------------------------------------------------------ 13: a fault at every I/O step

	/** A 0.7.0 world with one of everything (standing, ring, held leaves, construction, crates, group, pending, placing). */
	static V070World everything(Path dir) {
		V070World w = new V070World(dir);
		SiteSpec a = w.site("s1", 0, 64, 0, 4, 3, 4, t(1), new Random(40));
		a.ring = new int[] {-1, 66, -1, 3};
		w.hold(a, -2, 66, 0, 2, V070World.leaf(true, 2));
		SiteSpec c = w.site("s2", 20, 64, 0, 4, 3, 4, t(2), new Random(41));
		w.construction(c, new Random(42), V070World.crate(20, 65, -3));
		SiteSpec d = w.site("s3", 40, 64, 0, 4, 3, 4, t(3), new Random(43));
		d.state = V070World.PENDING;
		d.at = t(8);
		SiteSpec g1 = w.site("s4", 600, 64, 0, 4, 3, 4, t(4), new Random(44)); // another 512x512 region: two region files
		SiteSpec g2 = w.site("s5", 610, 64, 0, 4, 3, 4, t(5), new Random(45));
		w.construction(g1, new Random(46), V070World.crate(606, 65, -3));
		w.construction(g2, new Random(47), V070World.crate(606, 65, -3));
		w.group("g1", List.of(g1, g2), V070World.crate(606, 65, -3));
		w.site("s6", 60, 64, 0, 4, 3, 4, t(6), new Random(48));
		w.placingJobs.add("s6");
		w.extraFiles.put("s0-1.nbt", new byte[] {9});
		return w;
	}

	@Test
	void aFaultAtEveryIoStepLeavesThePreMigrationOrTheFinishedStateNeverAMix() throws IOException {
		// the reference: a clean import
		V070World ref = everything(dir.resolve("ref")).write();
		List<String> steps = new ArrayList<>();
		JournalStore.faultHook = steps::add;
		start(ref);
		JournalStore.faultHook = null;
		TreeMap<String, String> done = V070World.summary(store);
		List<String> legacyFiles = V070World.list(ref.legacyDir());
		store.close();
		store = null;
		assertTrue(steps.contains("index"), steps.toString());
		assertTrue(steps.stream().anyMatch(s -> s.startsWith("write ")), steps.toString());
		assertTrue(steps.stream().anyMatch(s -> s.startsWith("legacy move s")), steps.toString());
		assertTrue(steps.contains("legacy move done"), steps.toString());
		assertTrue(steps.contains("committed"), steps.toString());
		int index = steps.indexOf("index");
		for (int k = 0; k < steps.size(); k++) {
			String step = steps.get(k);
			V070World w = everything(dir.resolve("f" + k)).write();
			List<String> original = V070World.list(w.snapDir());
			AtomicInteger n = new AtomicInteger();
			int at = k;
			// a throw from a step is a failed I/O; after the commit point ("committed", "deleted") only a kill stops it (an Error)
			boolean quiet = step.equals("committed") || step.equals("deleted");
			JournalStore.faultHook = s -> {
				if (n.getAndIncrement() == at) {
					if (quiet) {
						throw new Error("killed at " + s);
					}
					throw new IllegalStateException("fault at " + s);
				}
			};
			assertThrows(IOException.class, () -> start(w), step);
			JournalStore.faultHook = null;
			store.close();
			store = null;
			// on disk now: the pre-migration state, or the committed import with the move unfinished; never a partial index
			boolean committed = JournalStore.exists(w.dir);
			assertEquals(k > index, committed, step);
			Set<String> files = new HashSet<>(V070World.list(w.snapDir()));
			files.addAll(V070World.list(w.legacyDir()));
			assertEquals(Set.copyOf(original), files, step + ": no snapshot file is lost");
			if (!committed) {
				assertEquals(original, V070World.list(w.snapDir()), step + ": nothing moved before the commit");
			}
			// the next start: the import again, or the end of the move
			JournalMigration.Plan p = start(w);
			assertEquals(committed, p == null, step);
			assertEquals(done, V070World.summary(store), step + ": the same journal as a clean import");
			assertEquals(legacyFiles, V070World.list(w.legacyDir()), step);
			assertFalse(Files.exists(w.snapDir()), step);
			if (step.startsWith("read back ") || step.equals("index")) {
				assertFalse(store.unreferenced().isEmpty(), step + ": the failed commit's files are kept and listed");
			}
			// a third start changes nothing
			assertNull(start(w), step);
			assertEquals(done, V070World.summary(store), step);
			store.close();
			store = null;
		}
	}

	// ------------------------------------------------------------------ 14-17: late import, counters, downgrade, idempotence

	@Test
	void aLateImportOfASite070MadeIsTheTopLayer() throws IOException {
		V070World w = everything(dir).write();
		start(w);
		long top = store.index().entries().values().stream().mapToLong(JournalStore.Meta::layer).max().orElseThrow();
		Map<String, String> legacyBefore = Map.copyOf(store.index().legacy());
		// 0.7.0 (a downgrade) places s7: a record naming a new snapshot file in architect-sites/
		JsonObject root = JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject();
		V070SiteFile.FileData d = V070SiteFile.fileFromJson(root);
		V070World extra = new V070World(dir);
		SiteSpec n = extra.site("s7", 80, 64, 0, 4, 3, 4, t(70), new Random(49));
		List<Site> sites = new ArrayList<>(d.sites());
		sites.add(n.site());
		V070World.writeJson(w.sitesFile(), V070SiteFile.fileJson(sites, d.next() + 1, d.pending(), d.groups(), d.nextGroup()));
		V070World.writeTemplate(w.snapDir().resolve(n.snapshotFile), n.snapshot, n.snapBox, new int[0]);
		JournalMigration.Plan p = start(w);
		assertNotNull(p);
		assertTrue(p.late());
		assertEquals(1, p.entries());
		JournalStore.Meta m = only("s7", WorldJournal.SITE);
		assertTrue(m.layer() > top, "on top of every migrated entry");
		assertEquals(Status.ACTIVE, m.status());
		Map<Long, Cell> cs = cells(m);
		for (var x : n.snapshot.entrySet()) {
			assertEquals(x.getValue(), cs.get(x.getKey()).before());
		}
		assertEquals(m.id(), store.index().legacy().get(JournalMigration.SNAPSHOT_DIR + "/" + n.snapshotFile));
		assertTrue(store.index().legacy().entrySet().containsAll(legacyBefore.entrySet()));
		assertTrue(V070World.list(w.legacyDir()).contains(n.snapshotFile));
		assertFalse(Files.exists(w.snapDir()));
		// nothing else was imported twice
		assertEquals(1, entries("s1").stream().filter(x -> x.kind().equals(WorldJournal.SITE)).count());
	}

	/** A road and a cell site as 0.8.0 commits them (their records as the entries' meta), with their ids from the index. */
	List<Infra> infra() throws IOException {
		List<Infra> out = new ArrayList<>();
		for (int i = 0; i < 3; i++) {
			boolean road = i < 2;
			String id = road ? "r" + store.newRoad() : "c" + store.newCells();
			JsonObject spec = new JsonObject();
			spec.addProperty("width", 3);
			Infra rec = new Infra(id, road ? Infra.ROAD : Infra.CELLS + "steward_mc:terrain", "steward_mc:planner", new JsonObject(), V070World.DIM,
				new Anchors.Bounds(200 + i * 10, 64, 0, 205 + i * 10, 64, 2), t(80 + i), null, false, spec);
			long layer = store.newLayer();
			List<Cell> cells = new ArrayList<>();
			for (int x = 200 + i * 10; x <= 205 + i * 10; x++) {
				cells.add(new Cell(Journal.pos(x, 64, 1), layer, Value.of("minecraft:grass_block", "snowy", "false"), Value.of("minecraft:dirt_path")));
			}
			String eid = store.newId();
			store.submit(store.begin().label("P3:" + id).create(JournalStore.Meta.header(eid, road ? WorldJournal.ROAD : "cells", id, null, V070World.DIM,
				Policy.CELL, layer, Status.ACTIVE, rec.placedAt()), JournalStore.bySection(cells), new JournalNbt.Head(rec.toJson(), new int[0]))).join();
			out.add(rec);
		}
		return out;
	}

	/** The sites file as 0.8.0 saves it: 0.7.0's fields plus {@code infra}. */
	static JsonObject save080(JsonObject v070, List<Infra> infra) {
		JsonObject root = v070.deepCopy();
		JsonArray a = new JsonArray();
		infra.forEach(i -> a.add(i.toJson()));
		root.add("infra", a);
		return root;
	}

	@Test
	void roadAndCellSiteCountersSurviveA070SaveThatDropsInfraAndNeverCollide() throws IOException {
		V070World w = everything(dir).write();
		start(w);
		List<Infra> infra = infra();
		assertEquals(List.of("r1", "r2", "c1"), infra.stream().map(Infra::id).toList());
		V070World.writeJson(w.sitesFile(), save080(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject(), infra));
		// 0.7.0 opens the world, places s7 and saves: infra is gone, next is recomputed from what it sees
		JsonObject saved = V070SiteFile.resave(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject());
		assertFalse(saved.has("infra"));
		V070SiteFile.FileData d = V070SiteFile.fileFromJson(saved);
		V070World extra = new V070World(dir);
		SiteSpec n = extra.site("s" + d.next(), 90, 64, 0, 3, 3, 3, t(90), new Random(50));
		List<Site> sites = new ArrayList<>(d.sites());
		sites.add(n.site());
		V070World.writeJson(w.sitesFile(), V070SiteFile.fileJson(sites, d.next() + 1, d.pending(), d.groups(), d.nextGroup()));
		V070World.writeTemplate(w.snapDir().resolve(n.snapshotFile), n.snapshot, n.snapBox, new int[0]);
		// 0.8.0 again: the late import commits, and the counters are those of the index, not of the records
		JournalMigration.Plan p = start(w);
		assertEquals(1, p.entries());
		assertEquals(3, store.index().nextRoad());
		assertEquals(2, store.index().nextCells());
		start(w); // and once more, after a commit that allocated none
		String r = "r" + store.newRoad();
		String c = "c" + store.newCells();
		assertEquals("r3", r);
		assertEquals("c2", c);
		Set<String> taken = new HashSet<>();
		store.index().entries().values().forEach(m -> taken.add(m.site()));
		Site.fileFromJson(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject()).sites().forEach(s -> taken.add(s.id()));
		assertFalse(taken.contains(r));
		assertFalse(taken.contains(c));
		assertTrue(taken.containsAll(List.of("r1", "r2", "c1", n.id)));
		assertTrue(taken.stream().filter(x -> x.startsWith("s")).allMatch(x -> Site.idNumber(x) > 0), "0.7.0 ids are s<n>, never r/c");
	}

	@Test
	void downgradeRoundTripKeepsMigratedRecordsAndRebuildsInfraFromTheEntries() throws IOException {
		V070World w = everything(dir).write();
		start(w);
		List<Infra> infra = infra();
		JsonObject v080 = save080(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject(), infra);
		v080.addProperty("version", 2); // a later format number: 0.7.0 ignores it
		Site.FileData mine = Site.fileFromJson(v080);
		// 0.7.0 reads the 0.8.0 file and keeps every migrated record
		V070SiteFile.FileData old = V070SiteFile.fileFromJson(v080);
		assertEquals(mine.sites().stream().map(Site::toJson).toList(), old.sites().stream().map(Site::toJson).toList());
		assertEquals(mine.pending().stream().map(Site.Pending::toJson).toList(), old.pending().stream().map(Site.Pending::toJson).toList());
		assertEquals(mine.groups().stream().map(SiteGroupRec::toJson).toList(), old.groups().stream().map(SiteGroupRec::toJson).toList());
		// its save drops infra (and anything else it doesn't know)
		JsonObject saved = V070SiteFile.resave(v080);
		assertFalse(saved.has("infra"));
		assertEquals(1, saved.get("version").getAsInt());
		// and a 0.7.0 forget of a migrated site drops its record but not its entry
		V070SiteFile.FileData d = V070SiteFile.fileFromJson(saved);
		List<Site> kept = new ArrayList<>(d.sites());
		Site forgotten = kept.stream().filter(s -> s.id().equals("s1")).findFirst().orElseThrow();
		kept.remove(forgotten);
		V070World.writeJson(w.sitesFile(), V070SiteFile.fileJson(kept, d.next(), d.pending(), d.groups(), d.nextGroup()));
		// 0.8.0: the records come from the journal. Every active entry whose site has no record (and is not a group's crate)
		// is rebuilt from its meta (Sites' check; here its input, without a server)
		store.close();
		store = JournalStore.open(dir);
		Site.FileData now = Site.fileFromJson(JsonParser.parseString(Files.readString(w.sitesFile())).getAsJsonObject());
		Set<String> records = new HashSet<>();
		now.sites().forEach(s -> records.add(s.id()));
		now.pending().forEach(s -> records.add(s.site().id()));
		Map<String, JsonObject> rebuilt = new TreeMap<>();
		for (JournalStore.Meta m : store.index().entries().values()) {
			if (m.active() && !records.contains(m.site()) && !m.site().startsWith(SiteGroupRec.CRATE_PREFIX) && !m.kind().equals(WorldJournal.LEAVES)
				&& !m.kind().equals(WorldJournal.CRATE)) {
				assertNull(rebuilt.put(m.site(), store.head(m.id()).meta()), m.site());
			}
		}
		assertEquals(Set.of("r1", "r2", "c1", "s1"), rebuilt.keySet());
		for (Infra i : infra) {
			assertEquals(i, Infra.fromJson(rebuilt.get(i.id())), i.id());
		}
		assertEquals(forgotten.toJson(), Site.fromJson(rebuilt.get("s1")).toJson());
	}

	@Test
	void migratingTwiceEqualsMigratingOnce() throws IOException {
		V070World w = everything(dir).write();
		JournalMigration.Plan first = start(w);
		assertNotNull(first);
		TreeMap<String, String> once = V070World.summary(store);
		Map<String, JournalStore.Meta> ids = Map.copyOf(store.index().entries());
		String index = Files.readString(JournalStore.dirOf(dir).resolve(JournalStore.INDEX));
		List<String> legacy = V070World.list(w.legacyDir());
		// a second start: nothing to do
		assertNull(start(w));
		assertEquals(index, Files.readString(JournalStore.dirOf(dir).resolve(JournalStore.INDEX)));
		// the import run again over the same records (a late run: every record has its entries): nothing new
		Files.createDirectories(w.snapDir());
		assertNull(JournalMigration.run(w, store, dir, true));
		assertEquals(once, V070World.summary(store));
		assertEquals(ids.keySet(), store.index().entries().keySet());
		assertEquals(index, Files.readString(JournalStore.dirOf(dir).resolve(JournalStore.INDEX)));
		assertEquals(legacy, V070World.list(w.legacyDir()));
		assertFalse(Files.exists(w.snapDir()));
		assertTrue(store.unreferenced().isEmpty());
	}

	// ------------------------------------------------------------------ the real files

	/**
	 * Real Architect files, not {@link V070World}'s: vanilla's structure template writer made the snapshot and the target (a
	 * pending construction site with a crate). They come from the main checkout's {@code mod/run/saves/Gate3 Hardcore} save,
	 * written by a phase-3 build (a pre-4d format that 0.7.0 still reads), copied to src/test/resources/migration/v070. The
	 * 4e-verify 0.7.0 world the contract names is not on disk any more (its worktrees were removed after the 4e gate).
	 */
	@Test
	void realSnapshotFilesImport() throws IOException {
		Path snap = dir.resolve(JournalMigration.SNAPSHOT_DIR);
		Files.createDirectories(snap);
		for (String f : List.of("architect-sites.json", "architect-sites/s1-1791186878543.nbt", "architect-sites/s1-1791186881350-target.nbt")) {
			try (InputStream in = getClass().getResourceAsStream("/migration/v070/" + f)) {
				assertNotNull(in, f);
				Files.copy(in, dir.resolve(f));
			}
		}
		V070World w = new V070World(dir);
		JournalMigration.Plan p = start(w);
		assertEquals(1, p.entries());
		assertTrue(p.notes().isEmpty(), p.notes().toString());
		Site s = Site.fileFromJson(JsonParser.parseString(Files.readString(dir.resolve("architect-sites.json"))).getAsJsonObject()).pending().get(0)
			.site();
		JournalStore.Meta m = only("s1", WorldJournal.SITE);
		assertEquals(Status.UNDONE, m.status());
		Anchors.Bounds rb = s.restoreBox();
		assertEquals(rb.volume(), m.cells(), "the snapshot covers the restore box");
		Map<Long, Cell> cs = cells(m);
		// the snapshot read independently: every block of the vanilla template at its world position
		CompoundTag tpl = NbtIo.readCompressed(w.legacyDir().resolve(s.snapshot()), NbtAccounter.unlimitedHeap());
		Map<Long, Value> want = JournalNbt.values(tpl, rb.minX(), rb.minY(), rb.minZ());
		assertEquals(want.keySet(), cs.keySet());
		want.forEach((pos, v) -> assertEquals(v, cs.get(pos).before()));
		assertTrue(cs.values().stream().anyMatch(c -> c.before().name().equals("minecraft:grass_block")));
		// the queue's cells all have a non-air after (the target)
		Construction c = s.construction();
		int dx = rb.maxX() - rb.minX() + 1;
		int dz = rb.maxZ() - rb.minZ() + 1;
		for (int i = 0; i < c.size(); i++) {
			int[] o = Construction.offsets(c.cell(i), dx, dz);
			Cell cell = cs.get(Journal.pos(rb.minX() + o[0], rb.minY() + o[1], rb.minZ() + o[2]));
			assertNotNull(cell.after());
			assertFalse(cell.after().equals(Journal.AIR));
		}
		assertEquals(Set.of(s.snapshot(), c.target()), Set.copyOf(V070World.list(w.legacyDir())));
	}
}
