package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.larattalabs.architect.txn.Receipts;
import java.util.Arrays;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;

/** (slice T5Fb) The write's per-chunk plan (I4, I6's chunk-locality rule) and its receipts (I3). Pure. */
class FluidsT5FbTest {
	static long ck(int cx, int cz) {
		return (long) cx << 32 | cz & 0xffffffffL;
	}

	static RegionFluids.Body body(long... cells) {
		RegionFluids.Body b = new RegionFluids.Body();
		b.id = "pond";
		b.cells = cells;
		return b;
	}

	@Test
	void i6_forceChunksCoverEveryChunkReceivingATick() {
		// a pond whose east edge is x=15 (chunk 0,0): its outside neighbour x=16 is chunk 1,0's, so that chunk gets its own force W
		RegionFluids.Body b = body(BlockPos.asLong(14, 64, 3), BlockPos.asLong(15, 64, 3));
		assertArrayEquals(new long[] {ck(0, 0)}, RegionFluids.cellChunks(b), "the place Ws: one per chunk of its cells");
		long[] f = RegionFluids.forceChunks(b);
		assertTrue(Arrays.stream(f).anyMatch(x -> x == ck(1, 0)), "the force Ws include the neighbour's chunk 1,0: " + Arrays.toString(f));
		assertTrue(Arrays.stream(f).anyMatch(x -> x == ck(0, 0)));
		// a negative coordinate: x=-1 is chunk -1
		RegionFluids.Body w = body(BlockPos.asLong(0, 64, 0));
		long[] g = RegionFluids.forceChunks(w);
		assertTrue(Arrays.stream(g).anyMatch(x -> x == ck(-1, 0)) && Arrays.stream(g).anyMatch(x -> x == ck(0, -1)), Arrays.toString(g));
		assertEquals(3, g.length, "own chunk, west and north neighbours' chunks");
	}

	@Test
	void i6_inChunkIsTheChunkLocalityTest() {
		assertTrue(RegionFluids.inChunk(BlockPos.asLong(15, 0, 15), 0, 0));
		assertTrue(!RegionFluids.inChunk(BlockPos.asLong(16, 0, 15), 0, 0));
		assertTrue(RegionFluids.inChunk(BlockPos.asLong(-1, 0, -16), -1, -1));
	}

	@Test
	void i3_aReceiptCarriesItsFieldsAndStillProbesByKey() {
		String r = Receipts.of("tx-7/3", new java.util.LinkedHashMap<>(Map.of("op", "place")));
		assertEquals("tx-7/3;op=place", r);
		java.util.LinkedHashMap<String, Object> f = new java.util.LinkedHashMap<>();
		f.put("op", "place");
		f.put("t", 120L);
		f.put("n", 9);
		f.put("h", 1);
		String full = Receipts.of("tx-7/3", f);
		assertEquals("tx-7/3;op=place;t=120;n=9;h=1", full);
		assertEquals(Map.of("op", "place", "t", "120", "n", "9", "h", "1"), Receipts.fields(full, "tx-7/3"));
		assertEquals(null, Receipts.fields(full, "tx-7/30"), "tx-7/30 is another effect");
		assertEquals(null, Receipts.fields("tx-7/30;op=place", "tx-7/3"));
		assertEquals(Map.of(), Receipts.fields("tx-7/3", "tx-7/3"), "8cT's exact receipt still probes");
	}

	@Test
	void s3_3_aWroteCellIsNeverWrittenAgainForAnyFluid() {
		// I2 / N3 / P2-a: the read is per mark, never per fluid: water, lava, ice, bars and decor alike
		for (boolean open : new boolean[] {true, false}) {
			assertTrue(!FluidProv.read(FluidProv.Mark.WROTE, open, false).write());
			assertTrue(!FluidProv.read(FluidProv.Mark.WROTE, open, true).write());
		}
		assertTrue(FluidProv.read(null, true, false).write(), "mark none, open: the lost write (P1-1) is written");
		assertTrue(FluidProv.read(FluidProv.Mark.CLEARED, true, false).write(), "the stage's own clear: written at its wave");
	}
}
