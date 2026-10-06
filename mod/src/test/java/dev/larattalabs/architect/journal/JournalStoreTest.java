package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.stream.Stream;
import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The journal on disk (AgentCraft's {@code JournalStoreTest} cases, adapted to the sharded store): region files round trip,
 * generations, the index as the commit point, tidying at open, an unreadable index, and a fault at every I/O step of a
 * commit (docs/CONTRACT.md "Phase 4e gate" 1, store crash tests).
 */
class JournalStoreTest {
	@TempDir
	Path world;

	@AfterEach
	void noFaults() {
		JournalStore.faultHook = null;
	}

	static final Value CHEST;

	static {
		CompoundTag chest = new CompoundTag();
		chest.putString("id", "minecraft:chest");
		CHEST = Value.of("minecraft:chest", "facing", "east").withNbt(chest);
	}

	/** Cells in two regions (x 1 and x 600) and three sections. */
	static List<Cell> cells(long layer) {
		List<Cell> cs = new ArrayList<>();
		cs.add(new Cell(Journal.pos(1, 64, 2), layer, CHEST, Journal.AIR));
		cs.add(new Cell(Journal.pos(1, 65, 2), layer, Journal.AIR, null));
		cs.add(new Cell(Journal.pos(17, 65, 2), layer + 3, Value.of("minecraft:stone"), Value.of("minecraft:dirt_path")));
		cs.add(new Cell(Journal.pos(600, 70, -5), layer, Value.of("minecraft:grass_block"), Value.of("minecraft:oak_planks")));
		return cs;
	}

	static JournalStore.Meta header(String id, long layer) {
		return JournalStore.Meta.header(id, "site", "s1", "g1", "minecraft:overworld", Policy.BOX, layer, Status.ACTIVE, 123L);
	}

	static JournalNbt.Head head() {
		JsonObject meta = new JsonObject();
		meta.addProperty("id", "s1");
		return new JournalNbt.Head(meta, new int[] {1, 2, 3, 4});
	}

	@Test
	void regionFilesRoundTripWithUndoAndHandDowns() {
		long layer = 5;
		List<SectionCells> secs = JournalStore.bySection(cells(layer));
		Value sign = Value.of("minecraft:oak_sign").withNbt(new CompoundTag());
		for (SectionCells s : secs) {
			SectionCells u = s.withWritten(Map.of(s.pos(0), s.before(0)));
			java.util.TreeMap<Long, SectionCells> m = new java.util.TreeMap<>();
			m.put(u.key, u);
			JournalNbt.Region r = new JournalNbt.Region(Sections.region(u.key), m, List.of(new HandDown(3, "j7", s.pos(0), Journal.AIR, sign)));
			JournalNbt.Region back = JournalNbt.decode(JournalNbt.encode("j1", r, layer), layer);
			SectionCells b = back.sections().get(u.key);
			assertEquals(u.cells(), b.cells());
			assertEquals(u.writtenMap(), b.writtenMap());
			assertEquals(r.handed(), back.handed());
		}
		JournalNbt.Head h = JournalNbt.decodeHead(JournalNbt.encodeHead("j1", head()));
		assertEquals("s1", h.meta().get("id").getAsString());
		assertEquals(4, h.ring().length);
	}

	@Test
	void commitsWriteANewGenerationPerRegionAndTheIndexLast() throws Exception {
		JournalStore s = JournalStore.open(world);
		assertFalse(JournalStore.exists(world));
		String id = s.newId();
		long layer = s.newLayer();
		s.submit(s.begin().create(header(id, layer), JournalStore.bySection(cells(layer)), head())).get();
		assertTrue(JournalStore.exists(world));
		Path e = s.dir().resolve("e").resolve(id);
		assertTrue(Files.exists(e.resolve("0.0.1.nbt")));
		assertTrue(Files.exists(e.resolve("1.-1.1.nbt")));
		assertTrue(Files.exists(e.resolve("head.1.nbt")));
		JournalStore.Meta m = s.meta(id);
		assertEquals(4, m.cells());
		assertEquals(3, m.sections().length);
		assertEquals(List.of(1, 64, -5, 600, 70, 2), List.of(m.box()[0], m.box()[1], m.box()[2], m.box()[3], m.box()[4], m.box()[5]));
		// change one section: only its region gets a new generation
		long key = Sections.key(Journal.pos(17, 65, 2));
		SectionCells changed = SectionCells.of(key, List.of(new Cell(Journal.pos(17, 65, 2), layer + 3, Journal.AIR, Value.of("minecraft:dirt_path"))),
			null);
		s.submit(s.begin().sections(id, List.of(changed))).get();
		assertFalse(Files.exists(e.resolve("0.0.1.nbt")));
		assertTrue(Files.exists(e.resolve("0.0.2.nbt")));
		assertTrue(Files.exists(e.resolve("1.-1.1.nbt")), "the other region is untouched");
		Entry loaded = s.load(id);
		assertEquals(4, loaded.cells().size());
		assertEquals(Journal.AIR, loaded.cell(Journal.pos(17, 65, 2)).before());
		assertEquals(layer + 3, loaded.cell(Journal.pos(17, 65, 2)).layer(), "the per-cell layer is kept");
		assertEquals(CHEST, loaded.cell(Journal.pos(1, 64, 2)).before(), "block entity data round trips");
		s.close();
		JournalStore r = JournalStore.open(world);
		assertEquals(loaded, r.load(id));
		assertEquals(2, r.meta(id).files().get("0,0"));
		assertNotEquals(id, r.newId(), "ids are never reused");
		r.submit(r.begin().release(id)).get();
		r.close();
		assertTrue(JournalStore.open(world).index().entries().isEmpty());
		assertFalse(Files.exists(e), "a released entry's files go");
	}

	@Test
	void statusAndUndoRecordsRoundTrip() throws Exception {
		JournalStore s = JournalStore.open(world);
		String id = s.newId();
		long layer = s.newLayer();
		s.submit(s.begin().create(header(id, layer), JournalStore.bySection(cells(layer)), head())).get();
		List<SectionCells> undone = new ArrayList<>();
		for (SectionCells c : JournalStore.bySection(cells(layer))) {
			Map<Long, Value> w = new java.util.HashMap<>();
			for (int k = 0; k < c.size(); k++) {
				w.put(c.pos(k), c.before(k));
			}
			undone.add(c.withWritten(w));
		}
		s.submit(s.begin().sections(id, undone).status(id, Status.UNDONE, "grp", 99L)).get();
		s.close();
		JournalStore r = JournalStore.open(world);
		Entry e = r.load(id);
		assertEquals(Status.UNDONE, e.status());
		assertEquals("grp", e.undo().group());
		assertEquals(4, e.undo().written().size());
		Entry slice = r.slice(id, Sections.key(Journal.pos(1, 64, 2)));
		assertEquals(2, slice.cells().size());
		assertEquals(2, slice.undo().written().size());
		assertNull(r.slice(id, Sections.key(Journal.pos(100, 64, 2))));
		assertEquals(List.of(id), r.inSection("minecraft:overworld", Sections.key(Journal.pos(600, 70, -5))));
	}

	@Test
	void openTidiesLeftoversAndKeepsUncommittedEntries() throws Exception {
		JournalStore s = JournalStore.open(world);
		String id = s.newId();
		long layer = s.newLayer();
		s.submit(s.begin().create(header(id, layer), JournalStore.bySection(cells(layer)), head())).get();
		Path e = s.dir().resolve("e").resolve(id);
		// a commit that wrote generation 2 and crashed before the index; an entry that never committed; a temp file
		Files.copy(e.resolve("0.0.1.nbt"), e.resolve("0.0.2.nbt"));
		Files.createDirectories(s.dir().resolve("e").resolve("j99"));
		Files.copy(e.resolve("0.0.1.nbt"), s.dir().resolve("e").resolve("j99").resolve("0.0.1.nbt"));
		Files.writeString(s.dir().resolve("journal.json.tmp"), "{", StandardCharsets.UTF_8);
		Files.writeString(e.resolve("0.0.3.nbt.tmp"), "x", StandardCharsets.UTF_8);
		s.close();
		JournalStore r = JournalStore.open(world);
		assertFalse(Files.exists(e.resolve("0.0.2.nbt")));
		assertTrue(Files.exists(e.resolve("0.0.1.nbt")));
		assertFalse(Files.exists(s.dir().resolve("journal.json.tmp")));
		assertFalse(Files.exists(e.resolve("0.0.3.nbt.tmp")));
		assertEquals(List.of("j99/0.0.1.nbt"), r.unreferenced());
		assertTrue(Files.exists(s.dir().resolve("e").resolve("j99").resolve("0.0.1.nbt")), "kept for a look by hand");
		assertNotEquals("j99", r.newId());
		assertEquals(4, r.load(id).cells().size());
	}

	@Test
	void anUnreadableIndexIsAnError() throws IOException {
		Files.createDirectories(JournalStore.dirOf(world));
		Files.writeString(JournalStore.dirOf(world).resolve(JournalStore.INDEX), "{ nope", StandardCharsets.UTF_8);
		assertThrows(IOException.class, () -> JournalStore.open(world));
	}

	/**
	 * A fault at every I/O step of a commit (the second commit, which changes one region, adds an entry and releases one):
	 * the future fails, the view goes back to the durable state, and a reopened journal holds exactly the first commit
	 * (before the index write) or exactly the second (after it). No file the index names is ever lost.
	 */
	@Test
	void aFaultAtEveryIoStepLeavesOneConsistentState() throws Exception {
		List<String> steps = new ArrayList<>();
		JournalStore.faultHook = steps::add;
		Path probe = world.resolve("probe");
		Files.createDirectories(probe);
		runTwoCommits(probe, null);
		JournalStore.faultHook = null;
		assertTrue(steps.size() > 8, "steps: " + steps);
		int second = steps.indexOf("deleted") + 1; // the second commit's steps follow the first's
		List<String> secondSteps = steps.subList(second, steps.size());
		assertTrue(secondSteps.contains("index"), "steps: " + steps);
		for (int i = 0; i < secondSteps.size(); i++) {
			String fault = secondSteps.get(i);
			Path w = world.resolve("w" + i);
			Files.createDirectories(w);
			boolean failed = runTwoCommits(w, fault);
			boolean afterIndex = secondSteps.indexOf("committed") <= i;
			assertEquals(!afterIndex, failed, "fault at " + fault + ": the commit fails until the index is written");
			JournalStore r = JournalStore.open(w);
			// no file the index names is lost
			for (JournalStore.Meta m : r.index().entries().values()) {
				Entry e = r.load(m.id());
				assertEquals(m.cells(), e.cells().size(), "fault at " + fault + ": " + m.id());
			}
			if (afterIndex) {
				assertEquals(2, r.index().entries().size(), "fault at " + fault + ": the second commit stands");
				assertEquals(Journal.AIR, r.load("j1").cell(Journal.pos(1, 64, 2)).before());
			} else {
				assertEquals(2, r.index().entries().size(), "fault at " + fault + ": the first commit stands");
				assertTrue(r.index().entries().containsKey("j2"), "fault at " + fault);
				assertEquals(CHEST, r.load("j1").cell(Journal.pos(1, 64, 2)).before());
			}
			// and it takes the next commit
			String id = r.newId();
			long layer = r.newLayer();
			r.submit(r.begin().create(header(id, layer), JournalStore.bySection(cells(layer)), head())).get();
			r.close();
			assertTrue(JournalStore.open(w).index().entries().containsKey(id));
		}
	}

	/** Commit 1: j1 and j2. Commit 2: j1 changed in one region, j3 created, j2 released. Returns whether commit 2 failed. */
	private boolean runTwoCommits(Path w, String faultAt) throws Exception {
		JournalStore s = JournalStore.open(w);
		String a = s.newId();
		String b = s.newId();
		long l = s.newLayer();
		s.submit(s.begin().create(header(a, l), JournalStore.bySection(cells(l)), head()).create(header(b, l + 1), JournalStore.bySection(List.of(
			new Cell(Journal.pos(-40, 3, -40), l + 1, Journal.AIR, Value.of("minecraft:stone")))), JournalNbt.Head.EMPTY)).get();
		if (faultAt != null) {
			JournalStore.faultHook = step -> {
				if (step.equals(faultAt)) {
					throw new IllegalStateException("fault");
				}
			};
		}
		String c = s.newId();
		long key = Sections.key(Journal.pos(1, 64, 2));
		SectionCells changed = SectionCells.of(key, List.of(new Cell(Journal.pos(1, 64, 2), l, Journal.AIR, Journal.AIR),
			new Cell(Journal.pos(1, 65, 2), l, Journal.AIR, null)), null);
		boolean failed = false;
		try {
			s.submit(s.begin().sections(a, List.of(changed)).create(header(c, l + 2), JournalStore.bySection(List.of(new Cell(Journal.pos(-40, 4, -40),
				l + 2, Journal.AIR, Value.of("minecraft:dirt")))), JournalNbt.Head.EMPTY).release(b)).get();
		} catch (ExecutionException e) {
			failed = true;
			assertEquals(2, s.index().entries().size(), "the view is back to the durable state");
			assertTrue(s.index().entries().containsKey(b));
		}
		JournalStore.faultHook = null;
		s.close();
		return failed;
	}

	@Test
	void sectionsBase64RoundTrips() {
		long[] keys = {Sections.key(-5, 3, 7), Sections.key(0, 0, 0), Sections.key(123, -4, -9)};
		java.util.Arrays.sort(keys);
		assertTrue(java.util.Arrays.equals(keys, JournalStore.sectionsFrom(JournalStore.sectionsB64(keys))));
		try (Stream<Path> ignored = Stream.empty()) {
			assertTrue(true);
		}
	}
}
