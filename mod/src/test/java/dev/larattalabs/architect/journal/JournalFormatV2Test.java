package dev.larattalabs.architect.journal;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.larattalabs.architect.journal.Journal.Cell;
import dev.larattalabs.architect.journal.Journal.Value;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.TreeMap;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import org.junit.jupiter.api.Test;

/**
 * Phase 6a's journal format 2 (a store-format change, CONTRACT "Entry count and the index" rule: its own migration test):
 * sections over 256 cells store positions as a 4096-bit mask; version 1 region files and indexes are still read and the index is
 * written as 2; 0.10.0's reader (version must be 1) refuses a version 2 index, so a downgrade keeps refusing safely (4e).
 */
class JournalFormatV2Test {
	static final Value[] PAL = {Value.of("minecraft:stone"), Value.of("minecraft:dirt"), Journal.AIR, Value.of("minecraft:cobblestone")};

	static SectionCells section(long key, int n, Random r) {
		List<Integer> idx = new ArrayList<>();
		for (int i = 0; i < 4096; i++) {
			idx.add(i);
		}
		java.util.Collections.shuffle(idx, r);
		List<Cell> cells = new ArrayList<>();
		int sx = Sections.sx(key);
		int sy = Sections.sy(key);
		int sz = Sections.sz(key);
		for (int k = 0; k < n; k++) {
			int i = idx.get(k);
			long p = Journal.pos(sx * 16 + (i & 15), sy * 16 + (i >> 8 & 15), sz * 16 + (i >> 4 & 15));
			cells.add(new Cell(p, 7, PAL[r.nextInt(PAL.length)], r.nextInt(5) == 0 ? null : PAL[r.nextInt(PAL.length)]));
		}
		return SectionCells.of(key, cells, null);
	}

	static void same(SectionCells a, SectionCells b) {
		assertEquals(a.size(), b.size());
		for (int i = 0; i < a.size(); i++) {
			assertEquals(a.pos(i), b.pos(i));
			assertEquals(a.before(i), b.before(i));
			assertEquals(a.after(i), b.after(i));
		}
	}

	@Test
	void masksRoundTripAndSmallSectionsKeepIdx() {
		Random r = new Random(62);
		for (int n : new int[] {1, 100, 256, 257, 1000, 4096}) {
			long key = Sections.key(-3, 4, 7);
			SectionCells s = section(key, n, r);
			TreeMap<Long, SectionCells> m = new TreeMap<>(Map.of(key, s));
			CompoundTag t = JournalNbt.encode("j1", new JournalNbt.Region(0, m, List.of()), 7);
			CompoundTag st = ((ListTag) t.get("sections")).getCompoundOrEmpty(0);
			assertEquals(n > 256, st.contains("m"), "n " + n);
			assertEquals(n <= 256, st.contains("idx"), "n " + n);
			same(s, JournalNbt.decode(t, 7).sections().get(key));
		}
	}

	@Test
	void version1RegionFilesAreStillRead() {
		Random r = new Random(7);
		long key = Sections.key(1, 2, 3);
		SectionCells s = section(key, 900, r);
		CompoundTag t = JournalNbt.encode("j1", new JournalNbt.Region(0, new TreeMap<>(Map.of(key, s)), List.of()), 7);
		// rewrite as 0.10.0 wrote it: version 1, positions as 2 bytes each
		CompoundTag st = ((ListTag) t.get("sections")).getCompoundOrEmpty(0);
		st.remove("m");
		byte[] idx = new byte[s.size() * 2];
		for (int k = 0; k < s.size(); k++) {
			int i = Sections.index(s.pos(k));
			idx[k * 2] = (byte) (i >> 8);
			idx[k * 2 + 1] = (byte) i;
		}
		st.putByteArray("idx", idx);
		t.putInt("version", 1);
		same(s, JournalNbt.decode(t, 7).sections().get(key));
	}

	@Test
	void theIndexIsWrittenAs2AndVersion1IsRead() {
		JsonObject v2 = JournalStore.indexToJson(JournalStore.Index.EMPTY);
		assertEquals(2, v2.get("version").getAsInt());
		JsonObject v1 = v2.deepCopy();
		v1.addProperty("version", 1);
		assertTrue(JournalStore.indexFromJson(v1).entries().isEmpty(), "a 0.10.0 (version 1) index opens");
		JsonObject v3 = v2.deepCopy();
		v3.addProperty("version", 3);
		assertThrows(IllegalArgumentException.class, () -> JournalStore.indexFromJson(v3));
		// 0.10.0's rule: version must equal 1, so a version 2 index makes it refuse (journal unavailable), never misread
		assertFalse(v2.get("version").getAsInt() == 1);
	}

	@Test
	void masksAreSmallerForDenseSections() {
		Random r = new Random(3);
		long key = Sections.key(0, 4, 0);
		SectionCells s = section(key, 2000, r);
		CompoundTag t = JournalNbt.encode("j1", new JournalNbt.Region(0, new TreeMap<>(Map.of(key, s)), List.of()), 7);
		long[] m = ((ListTag) t.get("sections")).getCompoundOrEmpty(0).getLongArray("m").orElseThrow();
		assertEquals(64, m.length);
		int bits = 0;
		for (long w : m) {
			bits += Long.bitCount(w);
		}
		assertEquals(2000, bits);
		assertArrayEquals(new long[0], new long[0]);
	}
}
