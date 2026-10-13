package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.Test;

/**
 * 6c PT2 §9: an {@code adopt} entry's files (region and head) are journal file version 4, which a 0.27.0 reader ({@code known()} = 1, 2,
 * 3) refuses; every other file is unchanged (2, or 3 with {@code pt}); this reader reads all of them. An adopt entry's cells hold
 * before == after and no {@code pt}.
 */
class JournalAdoptTest {
	static final Value LOG = Value.of("minecraft:oak_log", "axis", "y");
	static final Value AIR = Value.of("minecraft:air");

	/** 0.27.0's rule (JournalNbt.known at v0.27.0). */
	static boolean known027(int v) {
		return v == 1 || v == 2 || v == 3;
	}

	@Test
	void adoptFilesAreVersion4AndRefusedBy027() {
		long key = Sections.key(Journal.pos(10, 64, 10));
		List<Cell> cells = new ArrayList<>();
		for (int i = 0; i < 6; i++) {
			Value v = i % 2 == 0 ? LOG : AIR;
			cells.add(new Cell(Journal.pos(10 + i, 64, 10), 7, v, v));
		}
		SectionCells s = JournalStore.bySection(cells).get(0);
		JournalNbt.Region r = new JournalNbt.Region(Sections.region(key), new TreeMap<>(Map.of(key, s)), List.of());
		CompoundTag adopt = JournalNbt.encode("e9", r, 7, true);
		assertEquals(JournalNbt.VERSION_ADOPT, adopt.getIntOr("version", 0));
		assertFalse(known027(adopt.getIntOr("version", 0)), "0.27.0 refuses an adopt entry's region file");
		JournalNbt.Region back = JournalNbt.decode(adopt, 7);
		assertEquals(6, back.cells());
		SectionCells bs = back.sections().get(key);
		for (int i = 0; i < bs.size(); i++) {
			assertEquals(bs.before(i), bs.after(i), "before == after");
			assertEquals(null, bs.pt(i), "no pt member");
		}
		CompoundTag plain = JournalNbt.encode("e9", r, 7, false);
		assertEquals(JournalNbt.VERSION, plain.getIntOr("version", 0));
		assertTrue(known027(plain.getIntOr("version", 0)), "every other file stays readable by 0.27.0");
		JsonObject meta = new JsonObject();
		meta.addProperty("id", "s3");
		CompoundTag head = JournalNbt.encodeHead("e9", new JournalNbt.Head(meta, new int[0]), true);
		assertEquals(JournalNbt.VERSION_ADOPT, head.getIntOr("version", 0));
		assertEquals("s3", JournalNbt.decodeHead(head).meta().get("id").getAsString());
		assertEquals(JournalNbt.VERSION, JournalNbt.encodeHead("e9", new JournalNbt.Head(meta, new int[0])).getIntOr("version", 0));
	}

	@Test
	void indexKeepsAdoptKind() {
		// the index (journal.json) stays version 2: the kind is a free string a 0.27.0 index reader keeps
		JournalStore.Meta m = JournalStore.Meta.header("e9", WorldJournal.ADOPT, "s3", null, "minecraft:overworld", Journal.Policy.BOX, 7,
			Journal.Status.ACTIVE, 1L);
		JournalStore.Index idx = new JournalStore.Index(Map.of("e9", m), 10, 10, 1, 1, Map.of());
		JsonObject j = JournalStore.indexToJson(idx);
		assertEquals(JournalStore.VERSION, j.get("version").getAsInt());
		assertEquals("adopt", JournalStore.indexFromJson(j).entries().get("e9").kind());
	}
}
