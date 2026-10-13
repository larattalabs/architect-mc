package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Entry;
import dev.larattalabs.architect.journal.Journal.HandDown;
import dev.larattalabs.architect.journal.Journal.Policy;
import dev.larattalabs.architect.journal.Journal.Status;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import java.util.UUID;
import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.Test;

/**
 * 6c PT §5: the journal keeps each cell's player-placed record ({@link Pt}) with its {@code before}: section {@code pt} members with
 * the file-level {@code ptu}/{@code ptb} palettes; a file that holds {@code pt} is version 3, every other file stays 2 (heads too)
 * and an older reader refuses a v3 file; every copy of the cells keeps them (withAfter, withWritten, slices, bySection); an undo's
 * write carries the writer's record, a hand-down hands the record down with the before, and a reactivate gives it back.
 */
class JournalPtTest {
	static final UUID ALEX = UUID.fromString("11111111-2222-3333-4444-555555555555");
	static final UUID SAM = UUID.fromString("66666666-7777-8888-9999-000000000000");
	static final Value LOG = Value.of("minecraft:oak_log");
	static final Value AIR = Journal.AIR;
	static final Value STONE = Value.of("minecraft:stone");
	static final Value DIRT = Value.of("minecraft:dirt");

	static long key = Sections.key(2, 4, -1);

	static long pos(int i) {
		return Sections.pos(key, i);
	}

	static SectionCells withPt(Random r, int n) {
		List<Cell> cells = new ArrayList<>();
		for (int k = 0; k < n; k++) {
			Pt pt = r.nextInt(3) == 0 ? null : new Pt(r.nextBoolean() ? ALEX : SAM, r.nextInt(4) == 0 ? null : "build-" + (1 + r.nextInt(3)));
			cells.add(new Cell(pos(k * 7 % 4096), 5, r.nextBoolean() ? LOG : STONE, AIR, pt));
		}
		return SectionCells.of(key, cells, null);
	}

	static void samePt(SectionCells a, SectionCells b) {
		assertEquals(a.size(), b.size());
		for (int i = 0; i < a.size(); i++) {
			assertEquals(a.pos(i), b.pos(i));
			assertEquals(a.before(i), b.before(i));
			assertEquals(a.pt(i), b.pt(i), "cell " + i);
		}
	}

	@Test
	void roundTripVersion3OnlyWithPt() {
		Random r = new Random(32);
		for (int n : new int[] {1, 50, 256, 257, 900}) {
			SectionCells s = withPt(r, n);
			assertTrue(s.hasPt());
			TreeMap<Long, SectionCells> m = new TreeMap<>(Map.of(key, s));
			CompoundTag t = JournalNbt.encode("e1", new JournalNbt.Region(Sections.region(key), m, List.of()), 5);
			assertEquals(JournalNbt.VERSION_PT, t.getIntOr("version", 0), "a file holding pt is version 3");
			assertTrue(t.contains("ptu"));
			SectionCells back = JournalNbt.decode(t, 5).sections().get(key);
			samePt(s, back);
		}
		// no record: the file stays version 2, and carries no pt members
		List<Cell> plain = List.of(new Cell(pos(1), 5, STONE, AIR), new Cell(pos(2), 5, DIRT, AIR));
		CompoundTag t = JournalNbt.encode("e2", new JournalNbt.Region(Sections.region(key), new TreeMap<>(Map.of(key, SectionCells.of(key, plain, null))), List
			.of()), 5);
		assertEquals(2, t.getIntOr("version", 0));
		assertFalse(t.contains("ptu"));
		assertFalse(t.getListOrEmpty("sections").getCompoundOrEmpty(0).contains("pt"));
		assertEquals(2, JournalNbt.encodeHead("e2", JournalNbt.Head.EMPTY).getIntOr("version", 0), "heads stay version 2");
	}

	@Test
	void olderReaderRefusesVersion3() {
		SectionCells s = withPt(new Random(1), 10);
		CompoundTag t = JournalNbt.encode("e1", new JournalNbt.Region(Sections.region(key), new TreeMap<>(Map.of(key, s)), List.of()), 5);
		// 0.25.0's rule: known() is 1 or 2
		int v = t.getIntOr("version", 0);
		assertFalse(v == 1 || v == 2, "a v3 file is refused by a reader that knows 1 and 2");
		CompoundTag bad = t.copy();
		bad.putInt("version", 4);
		assertThrows(IllegalArgumentException.class, () -> JournalNbt.decode(bad, 5));
	}

	@Test
	void copiesKeepPt() {
		SectionCells s = withPt(new Random(5), 40);
		Map<Long, Value> after = new java.util.HashMap<>();
		after.put(s.pos(0), DIRT);
		samePt(s, s.withAfter(after));
		samePt(s, s.withWritten(Map.of(s.pos(3), STONE)));
		// cells() -> SectionCells.of keeps them (slices, bySection)
		samePt(s, SectionCells.of(key, s.cells(), null));
		samePt(s, JournalStore.bySection(s.cells()).get(0));
	}

	static Entry entry(String id, Policy p, long layer, Cell... cs) {
		List<Cell> l = new ArrayList<>();
		for (Cell c : cs) {
			l.add(new Cell(c.pos(), layer, c.before(), c.after(), c.pt()));
		}
		return new Entry(id, "site", "s-" + id, "minecraft:overworld", p, 0L, Status.ACTIVE, l, null, null);
	}

	@Test
	void undoWritesCarryTheWritersRecord() {
		long p = pos(10);
		Pt alex = new Pt(ALEX, "build-4");
		// A wrote stone over Alex's log (its before had Alex's record); undoing A writes the log back with the record
		Entry a = entry("a", Policy.BOX, 1, new Cell(p, 1, LOG, STONE, alex));
		Journal.UndoPlan plan = Journal.planUndo(List.of(a), List.of("a"), "g", 1L, (q, v) -> true, Journal.Match.EQUAL);
		assertEquals(1, plan.writes().size());
		assertEquals(LOG, plan.writes().get(0).value());
		assertEquals(alex, plan.writes().get(0).pt());
	}

	@Test
	void handDownCarriesTheRecordAndReactivateGivesItBack() {
		long p = pos(11);
		Pt alex = new Pt(ALEX, "build-4");
		// A (lower) wrote stone over Alex's log; B (upper) wrote dirt over A's stone (B's before has no record)
		Entry a = entry("a", Policy.BOX, 1, new Cell(p, 1, LOG, STONE, alex));
		Entry b = entry("b", Policy.BOX, 2, new Cell(p, 2, STONE, DIRT, null));
		Journal.UndoPlan plan = Journal.planUndo(List.of(a, b), List.of("a"), "g", 1L, (q, v) -> true, Journal.Match.EQUAL);
		assertTrue(plan.writes().isEmpty(), "under B: nothing written");
		Entry b2 = plan.updated().get("b");
		Cell c = b2.cell(p);
		assertEquals(LOG, c.before(), "B's before is now A's before");
		assertEquals(alex, c.pt(), "and its record");
		HandDown h = plan.updated().get("a").undo().handed().get(0);
		assertNull(h.wasPt());
		assertEquals(alex, h.nowPt());
		// undoing B later writes the log with Alex's record
		Journal.UndoPlan later = Journal.planUndo(List.of(plan.updated().get("a"), b2), List.of("b"), "g2", 2L, (q, v) -> true, Journal.Match.EQUAL);
		assertEquals(alex, later.writes().get(0).pt());
		// the first undo never reached the disk: reactivate gives B its before and record back
		Map<String, Entry> back = Journal.reactivate(List.of(plan.updated().get("a"), b2), "g");
		Cell rb = back.get("b").cell(p);
		assertEquals(STONE, rb.before());
		assertNull(rb.pt(), "B's record as it was (none)");
	}

	@Test
	void handDownsRoundTripThroughTheFile() {
		long p = pos(12);
		Pt alex = new Pt(ALEX, null);
		HandDown h = new HandDown(0, "b", p, STONE, LOG, null, alex);
		SectionCells s = SectionCells.of(key, List.of(new Cell(p, 1, LOG, STONE, alex)), Map.of(p, LOG));
		CompoundTag t = JournalNbt.encode("a", new JournalNbt.Region(Sections.region(key), new TreeMap<>(Map.of(key, s)), List.of(h)), 1);
		JournalNbt.Region r = JournalNbt.decode(t, 1);
		assertEquals(alex, r.handed().get(0).nowPt());
		assertNull(r.handed().get(0).wasPt());
		assertNotNull(r.sections().get(key).pt(0));
	}
}
