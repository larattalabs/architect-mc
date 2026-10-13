package dev.larattalabs.architect.placed;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.UUID;
import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.Test;

/**
 * 6c PT §1: the per-chunk set. Sparse sections turn dense at 257 cells and back at 128; the NBT round-trips exactly (2-byte
 * positions or the 4096-bit mask, {@code o} omitted with one placer, {@code b} omitted when uniform); the 255th distinct placer of a
 * chunk records as unknown; palettes are compacted on save.
 */
class PlacedChunkTest {
	static final UUID A = UUID.fromString("00000000-0000-0000-0000-00000000000a");
	static final UUID B = UUID.fromString("00000000-0000-0000-0000-00000000000b");

	static String dump(PlacedChunk c) {
		StringBuilder sb = new StringBuilder();
		for (int sy : c.sectionYs()) {
			int[] cells = c.cells(sy);
			for (int i = 0; i < cells.length; i += 2) {
				int v = cells[i + 1];
				sb.append(sy).append(':').append(cells[i]).append('=').append(c.placer(PlacedChunk.placerOf(v))).append('/').append(c.build(PlacedChunk.buildOf(
					v))).append(';');
			}
		}
		return sb.toString();
	}

	@Test
	void putGetRemove() {
		PlacedChunk c = new PlacedChunk();
		assertTrue(c.isEmpty());
		int v = PlacedChunk.value(c.placerIndex(A), c.buildIndex("build-1"));
		assertTrue(c.put(3, 70, 5, v));
		assertFalse(c.put(3, 70, 5, v), "the same value is no change");
		assertEquals(v, c.get(3, 70, 5));
		assertEquals(-1, c.get(3, 71, 5));
		assertEquals(A, c.placer(PlacedChunk.placerOf(c.get(3, 70, 5))));
		assertEquals("build-1", c.build(PlacedChunk.buildOf(c.get(3, 70, 5))));
		assertTrue(c.setBuild(3, 70, 5, 0));
		assertNull(c.build(PlacedChunk.buildOf(c.get(3, 70, 5))), "incidental");
		assertEquals(A, c.placer(PlacedChunk.placerOf(c.get(3, 70, 5))), "the placer kept");
		assertEquals(PlacedChunk.value(0, 0), c.remove(3, 70, 5));
		assertTrue(c.isEmpty());
		assertEquals(0, c.sectionYs().length);
	}

	@Test
	void denseAndBack() {
		PlacedChunk c = new PlacedChunk();
		int v = PlacedChunk.value(c.placerIndex(A), 0);
		for (int i = 0; i < 300; i++) {
			c.put(i & 15, 64 + (i >> 8), i >> 4 & 15, v);
		}
		assertEquals(300, c.size());
		String before = dump(c);
		PlacedChunk r = PlacedChunk.read(c.write());
		assertEquals(before, dump(r), "a dense section round-trips");
		assertTrue(c.write().getListOrEmpty("sections").getCompoundOrEmpty(0).getLongArray("m").isPresent(), "more than 256 cells: the mask");
		for (int i = 0; i < 200; i++) {
			c.remove(i & 15, 64 + (i >> 8), i >> 4 & 15);
		}
		assertEquals(100, c.size());
		assertEquals(dump(PlacedChunk.read(c.write())), dump(c), "sparse again round-trips");
	}

	@Test
	void nbtShapes() {
		PlacedChunk c = new PlacedChunk();
		int a = c.placerIndex(A);
		c.put(0, 64, 0, PlacedChunk.value(a, c.buildIndex("build-2")));
		c.put(1, 64, 0, PlacedChunk.value(a, c.buildIndex("build-2")));
		CompoundTag t = c.write();
		CompoundTag s0 = t.getListOrEmpty("sections").getCompoundOrEmpty(0);
		assertTrue(s0.getByteArray("p").isPresent(), "at most 256 cells: 2-byte positions");
		assertFalse(s0.getByteArray("o").isPresent(), "one placer: no o");
		assertFalse(s0.getByteArray("b").isPresent(), "uniform build: no b");
		assertEquals(1, s0.getByteOr("bu", (byte) 0), "the uniform build index");
		c.put(2, 64, 0, PlacedChunk.value(c.placerIndex(B), 0));
		CompoundTag t2 = c.write();
		CompoundTag s1 = t2.getListOrEmpty("sections").getCompoundOrEmpty(0);
		assertTrue(s1.getByteArray("o").isPresent());
		assertTrue(s1.getByteArray("b").isPresent());
		assertEquals(dump(c), dump(PlacedChunk.read(t2)));
		// ~3 bytes per tracked cell while sparse (2 position + 1 placer + 1 build here, plus the section's fixed cost)
		assertEquals(6, s1.getByteArray("p").orElseThrow().length);
	}

	@Test
	void placerPaletteOverflow() {
		PlacedChunk c = new PlacedChunk();
		for (int i = 0; i < 254; i++) {
			assertEquals(i, c.placerIndex(new UUID(1, i)));
		}
		assertEquals(PlacedChunk.UNKNOWN, c.placerIndex(new UUID(2, 0)), "the 255th distinct placer is unknown");
		c.put(0, 0, 0, PlacedChunk.value(PlacedChunk.UNKNOWN, 0));
		assertEquals(PlacedChunk.NIL, c.placer(PlacedChunk.placerOf(c.get(0, 0, 0))));
		PlacedChunk r = PlacedChunk.read(c.write());
		assertEquals(PlacedChunk.NIL, r.placer(PlacedChunk.placerOf(r.get(0, 0, 0))), "unknown survives the save");
	}

	@Test
	void paletteCompactedOnSave() {
		PlacedChunk c = new PlacedChunk();
		int a = c.placerIndex(A);
		c.placerIndex(B); // never used by a cell
		c.put(5, 10, 5, PlacedChunk.value(a, c.buildIndex("build-9")));
		c.buildIndex("build-10"); // unused
		CompoundTag t = c.write();
		assertEquals(1, t.getListOrEmpty("placers").size());
		assertEquals(1, t.getListOrEmpty("builds").size());
		assertEquals(dump(c), dump(PlacedChunk.read(t)));
	}
}
