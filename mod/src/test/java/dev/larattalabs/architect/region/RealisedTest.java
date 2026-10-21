package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * (RP) The realised record: each code from TileCheck's decision order, the draft over the unfiltered tile (the fluids gate's cells
 * FLUID, causes re-indexed), extras with their cause (a felled tree, dependents, held leaves), ARPR v1 round trips and its CRC, the
 * chain and composed hashes, layering by file, RS's UNFINISHED marks, and a drained body's row.
 */
class RealisedTest {
	@TempDir
	Path tmp;

	// ---- the codes, in TileCheck's decision order

	@Test
	void aHeldCellIsHeldWhateverElse() {
		assertEquals(Realised.HELD, Realised.decide(true, false, false, true, false));
		assertEquals(Realised.HELD, Realised.decide(true, true, true, false, true), "ownership is read first");
	}

	@Test
	void aPlayerBuildIsSkippedWhateverTheCondition() {
		assertEquals(Realised.BUILD, Realised.decide(false, true, false, true, false));
		assertEquals(Realised.BUILD, Realised.decide(false, true, false, false, true), "a build cell before its condition or a no-op");
	}

	@Test
	void anUnbreakableBlockUnderAStroke() {
		assertEquals(Realised.UNBREAKABLE, Realised.decide(false, false, true, true, false));
	}

	@Test
	void aFailedConditionIsCondEvenWhenTheWorldHoldsTheIntent() {
		assertEquals(Realised.COND, Realised.decide(false, false, false, false, false));
		// TileCheck tests the condition before "same": such a cell is COND (it may hold its intent: the audit counts it, never fails it)
		assertEquals(Realised.COND, Realised.decide(false, false, false, false, true));
	}

	@Test
	void aNoOpAndAWrite() {
		assertEquals(Realised.NOOP, Realised.decide(false, false, false, true, true));
		assertEquals(Realised.WRITTEN, Realised.decide(false, false, false, true, false));
	}

	@Test
	void codeValuesAreAppendOnly() {
		// the file format's values: never renumbered (RV and RS read them)
		assertEquals(0, Realised.WRITTEN);
		assertEquals(1, Realised.NOOP);
		assertEquals(2, Realised.HELD);
		assertEquals(3, Realised.BUILD);
		assertEquals(4, Realised.COND);
		assertEquals(5, Realised.FLUID);
		assertEquals(6, Realised.CLIP);
		assertEquals(7, Realised.UNFINISHED);
		assertEquals(8, Realised.KEPT);
		assertEquals(9, Realised.UNKNOWN);
		assertEquals(10, Realised.FLUID_EDGE);
		assertEquals(11, Realised.UNBREAKABLE);
		assertEquals(12, Realised.BUILD_SUPPORT);
		assertEquals("BUILD_SUPPORT", Realised.codeName(12));
		assertEquals(0, Realised.TREE);
		assertEquals(3, Realised.LEAF);
	}

	// ---- the draft

	private static Packed.Tile tile(long... pos) {
		int n = pos.length;
		return new Packed.Tile(pos, new int[n], new byte[n], new boolean[n], List.of(), List.of(), "00".repeat(32));
	}

	@Test
	void theFluidsGateCellsAreFluidAndCausesFollowTheOriginalOrder() {
		long a = BlockPos.asLong(0, 64, 0), b = BlockPos.asLong(1, 64, 0), c = BlockPos.asLong(2, 64, 0), d = BlockPos.asLong(3, 64, 0);
		Packed.Tile orig = tile(a, b, c, d);
		Packed.Tile filtered = tile(a, c); // b and d: a body the gate didn't let through
		long trunk = BlockPos.asLong(2, 65, 0), trunk2 = BlockPos.asLong(2, 66, 0), leaf = BlockPos.asLong(3, 67, 0), grass = BlockPos.asLong(0, 65, 0);
		List<Realised.Extra> ex = new ArrayList<>();
		// a felled tree: the log at c was intended (filtered index 1); its trunk goes with it, caused by c; a leaf held on it; grass on a
		ex.add(new Realised.Extra(Realised.TREE, trunk2, 1));
		ex.add(new Realised.Extra(Realised.TREE, trunk, 1));
		ex.add(new Realised.Extra(Realised.LEAF, leaf, 1));
		ex.add(new Realised.Extra(Realised.DEPENDENT, grass, 0));
		ex.add(new Realised.Extra(Realised.DEPENDENT_WET, BlockPos.asLong(9, 9, 9), -1));
		Realised.Draft dr = Realised.draft(orig, filtered, new byte[] {Realised.WRITTEN, Realised.WRITTEN}, ex);
		assertArrayEquals(new byte[] {Realised.WRITTEN, Realised.FLUID, Realised.WRITTEN, Realised.FLUID}, dr.codes());
		for (Realised.Extra e : dr.extras()) {
			if (e.pos() == trunk || e.pos() == trunk2 || e.pos() == leaf) {
				assertEquals(2, e.cause(), "the trunk and leaf follow c, index 2 of the tile as evaluated");
			} else if (e.pos() == grass) {
				assertEquals(0, e.cause());
			} else {
				assertEquals(-1, e.cause());
			}
		}
		for (int i = 1; i < dr.extras().size(); i++) {
			assertTrue(dr.extras().get(i - 1).pos() <= dr.extras().get(i).pos(), "extras ascending by position");
		}
		assertThrows(IllegalStateException.class, () -> Realised.draft(tile(a, b), tile(c), new byte[] {0}, List.of()), "not a subsequence");
	}

	// ---- ARPR v1

	private static Realised.Tile sample(byte[] codes, List<Realised.Extra> ex, byte[] writers, String site) {
		byte[] sha = new byte[32];
		byte[] chain = new byte[32];
		for (int i = 0; i < 32; i++) {
			sha[i] = (byte) i;
			chain[i] = (byte) (255 - i);
		}
		return new Realised.Tile(0, "z2_:base", "terrain", "-3,7", site, site.isEmpty() ? Realised.NO_ENTRY : 0, sha, chain, codes, ex, writers);
	}

	@Test
	void everyCodeAndExtraRoundTrips() throws IOException {
		byte[] codes = new byte[5000];
		for (int i = 0; i < codes.length; i++) {
			codes[i] = (byte) (i < 3000 ? Realised.WRITTEN : i < 3500 ? Realised.NOOP : (i % 13));
		}
		List<Realised.Extra> ex = List.of(new Realised.Extra(Realised.TREE, BlockPos.asLong(-30_000_000, -64, 29_999_999), 17), new Realised.Extra(
			Realised.DEPENDENT, BlockPos.asLong(-5, 70, 3), 0), new Realised.Extra(Realised.DEPENDENT_WET, BlockPos.asLong(5, 62, 3), -1), new Realised.Extra(
				Realised.LEAF, BlockPos.asLong(29_999_999, 319, -30_000_000), 4999));
		byte[] writers = "ARWR\u0001fake".getBytes(StandardCharsets.UTF_8);
		Realised.Tile t = sample(codes, ex.stream().sorted((x, y) -> Long.compare(x.pos(), y.pos())).toList(), writers, "c42");
		byte[] enc = Realised.encode(t);
		Realised.Tile back = Realised.decode(enc);
		assertArrayEquals(codes, back.codes());
		assertEquals(t.extras(), back.extras());
		assertArrayEquals(writers, back.writers());
		assertEquals("c42", back.site());
		assertEquals("z2_:base", back.stage());
		assertEquals("-3,7", back.key());
		assertFalse(back.noEntry());
		assertTrue((back.flags() & Realised.WRITERS) != 0);
		assertTrue((back.flags() & Realised.WRITERS_DEFLATED) != 0, "the writers are stored deflated");
		assertArrayEquals(t.tileSha(), back.tileSha());
		assertArrayEquals(t.chainSha(), back.chainSha());
		assertArrayEquals(enc, Realised.encode(back), "byte-stable");
		int[] n = back.counts();
		assertEquals(5000, java.util.Arrays.stream(n).sum());
	}

	@Test
	void aTileWithNoEntry() throws IOException {
		Realised.Tile t = sample(new byte[] {Realised.NOOP, Realised.HELD, Realised.COND}, List.of(), new byte[0], "");
		Realised.Tile back = Realised.decode(Realised.encode(t));
		assertTrue(back.noEntry());
		assertEquals("", back.site());
		assertEquals(0, back.writers().length);
	}

	@Test
	void corruptionIsCaught() {
		byte[] enc = Realised.encode(sample(new byte[] {0, 0, 1}, List.of(), new byte[0], "c1"));
		byte[] bad = enc.clone();
		bad[12] ^= 1;
		assertThrows(IOException.class, () -> Realised.decode(bad));
		assertThrows(IOException.class, () -> Realised.decode(java.util.Arrays.copyOf(enc, enc.length - 1)));
	}

	@Test
	void repetitiveWritersAreStoredSmall() throws IOException {
		byte[] w = new byte[60_000];
		for (int i = 0; i < w.length; i++) {
			w[i] = (byte) (i % 3 == 0 ? 1 : 2); // a loser list repeated over every cell
		}
		Realised.Tile t = sample(new byte[] {0}, List.of(), w, "c1");
		byte[] enc = Realised.encode(t);
		assertTrue(enc.length < 1_000, "60 kB of writers stored in " + enc.length + " B");
		assertArrayEquals(w, Realised.decode(enc).writers());
	}

	@Test
	void sizeOfAUniformTileIsSmall() {
		byte[] codes = new byte[40_000]; // one run
		assertTrue(Realised.encode(sample(codes, List.of(), new byte[0], "c9")).length < 120);
	}

	// ---- files, layers, RS marks

	@Test
	void layersAreSeparateFilesAndRsMarksCells() throws IOException {
		Path world = tmp;
		Realised.Tile t = sample(new byte[] {Realised.WRITTEN, Realised.UNFINISHED, Realised.UNFINISHED}, List.of(), new byte[0], "c3");
		Realised.write(world, "r1", t);
		Realised.Tile l1 = new Realised.Tile(1, t.stage(), t.set(), t.key(), "c9", 0, t.tileSha(), t.chainSha(), new byte[] {Realised.WRITTEN}, List.of(),
			new byte[0]);
		Realised.write(world, "r1", l1);
		assertTrue(Files.isRegularFile(world.resolve("architect-regions/r1/realised/L0/z2_%3Abase.terrain.-3.7.bin")));
		assertTrue(Files.isRegularFile(world.resolve("architect-regions/r1/realised/L1/z2_%3Abase.terrain.-3.7.bin")), "a later layer never replaces L0");
		assertTrue(Realised.mark(world, "r1", 0, t.stage(), t.set(), t.key(), new int[] {1}, Realised.WRITTEN));
		Realised.Tile back = Realised.read(world, "r1", 0, t.stage(), t.set(), t.key());
		assertNotNull(back);
		assertArrayEquals(new byte[] {Realised.WRITTEN, Realised.WRITTEN, Realised.UNFINISHED}, back.codes());
		assertEquals(1, Realised.read(world, "r1", 1, t.stage(), t.set(), t.key()).codes().length);
		assertFalse(Realised.mark(world, "r1", 0, "nope", "terrain", "0,0", new int[] {0}, Realised.WRITTEN));
		Realised.Draft d = Realised.withCodes(new Realised.Draft(new byte[] {0, 0, 0}, List.of()), new int[] {0, 2}, Realised.UNFINISHED);
		assertArrayEquals(new byte[] {Realised.UNFINISHED, 0, Realised.UNFINISHED}, d.codes());
		Realised.discard(world, "r1", 0, t.stage(), t.set(), t.key());
		assertNull(Realised.read(world, "r1", 0, t.stage(), t.set(), t.key()));
	}

	@Test
	void rsTargetBuiltAddsItsSiteOnceAndClearsNoEntry() throws IOException {
		// (batch v0.41.0, RS wiring) a tile with no free-pass cell: NO_ENTRY and every target cell UNFINISHED until a target builds
		Path world = tmp;
		Realised.Tile t0 = sample(new byte[] {Realised.UNFINISHED, Realised.UNFINISHED, Realised.UNFINISHED, Realised.NOOP}, List.of(), new byte[0], "");
		Realised.Tile t = new Realised.Tile(0, t0.stage(), t0.set(), t0.key(), "", Realised.NO_ENTRY, t0.tileSha(), t0.chainSha(), t0.codes(), List.of(),
			new byte[0]);
		Realised.write(world, "r2", t);
		assertTrue(Realised.mark(world, "r2", 0, t.stage(), t.set(), t.key(), new int[] {0, 1}, Realised.WRITTEN, "c7"));
		Realised.Tile a = Realised.read(world, "r2", 0, t.stage(), t.set(), t.key());
		assertEquals(List.of("c7"), a.sites());
		assertFalse(a.noEntry(), "a built target is the tile's first entry");
		assertArrayEquals(new byte[] {Realised.WRITTEN, Realised.WRITTEN, Realised.UNFINISHED, Realised.NOOP}, a.codes());
		assertTrue(Realised.mark(world, "r2", 0, t.stage(), t.set(), t.key(), new int[] {2}, Realised.WRITTEN, "c8"));
		assertTrue(Realised.mark(world, "r2", 0, t.stage(), t.set(), t.key(), new int[] {2}, Realised.WRITTEN, "c8")); // idempotent
		Realised.Tile b = Realised.read(world, "r2", 0, t.stage(), t.set(), t.key());
		assertEquals(List.of("c7", "c8"), b.sites());
		assertEquals(3, b.counts()[Realised.WRITTEN]);
		assertEquals(0, b.counts()[Realised.UNFINISHED]);
	}

	@Test
	void aSecondAttemptKeepsTheFirstAttemptsStandingEntry() {
		// a crash after the first attempt's commit, before its item was placed: the item runs again, the world already holds the
		// writes (NOOP now); the record keeps them WRITTEN and lists both entries
		List<Realised.Extra> ex1 = List.of(new Realised.Extra(Realised.TREE, BlockPos.asLong(1, 70, 1), 0));
		Realised.Tile first = sample(new byte[] {Realised.WRITTEN, Realised.WRITTEN, Realised.COND}, ex1, new byte[0], "c1");
		Realised.Tile again = sample(new byte[] {Realised.NOOP, Realised.WRITTEN, Realised.COND}, List.of(), new byte[0], "c7");
		Realised.Tile m = Realised.mergePrior(again, first, List.of("c1"));
		assertArrayEquals(new byte[] {Realised.WRITTEN, Realised.WRITTEN, Realised.COND}, m.codes());
		assertEquals(List.of("c7", "c1"), m.sites());
		assertEquals(ex1, m.extras());
		Realised.Tile none = sample(new byte[] {Realised.NOOP, Realised.NOOP, Realised.COND}, List.of(), new byte[0], "");
		Realised.Tile m2 = Realised.mergePrior(none, first, List.of("c1"));
		assertFalse(m2.noEntry(), "the first attempt's entry is the tile's");
		assertEquals(List.of("c1"), m2.sites());
		assertEquals(Realised.WRITTEN, m2.codes()[0]);
		assertEquals(again, Realised.mergePrior(again, first, List.of()), "the earlier entry gone: nothing kept");
	}

	// ---- fluid bodies

	@Test
	void aDrainedBodysRowCarriesWhatDrainedIt() {
		RegionFluids.Body a = new RegionFluids.Body();
		a.id = "w_pond";
		a.part = "pond";
		RegionFluids.Body b = new RegionFluids.Body();
		b.id = "w_short";
		b.part = "short";
		RegionFluids.Body c = new RegionFluids.Body();
		c.id = "w_later";
		RegionFluids.Regional st = new RegionFluids.Regional(List.of(a, b, c));
		RegionFluids.BodyState sa = st.states.get("w_pond");
		sa.state = "settled";
		sa.sources = 24;
		sa.settledAt = 1234;
		RegionFluids.BodyState sb = st.states.get("w_short");
		sb.state = "drained";
		sb.reason = "escaped";
		sb.escaped = true;
		Map<String, JsonObject> rows = RegionFluids.realisedRows(st);
		assertEquals(2, rows.size(), "a pending body has no row yet");
		assertEquals("settled", rows.get("w_pond").get("state").getAsString());
		assertEquals(24, rows.get("w_pond").get("sources").getAsInt());
		assertEquals("pond", rows.get("w_pond").get("part").getAsString());
		JsonObject d = rows.get("w_short");
		assertEquals("drained", d.get("state").getAsString());
		assertEquals("escaped", d.get("reason").getAsString());
		assertTrue(d.get("escaped").getAsBoolean());
		assertFalse(d.get("uncontained").getAsBoolean());
		// recorded in sites.json; an unchanged row is not written again
		Realised.bodies(tmp, "r7", rows);
		JsonObject sites = Realised.sites(tmp, "r7", 0);
		assertNotNull(sites);
		assertEquals("drained", sites.getAsJsonObject("bodies").getAsJsonObject("w_short").get("state").getAsString());
	}

	// ---- hashes

	private static Ir ir() {
		JsonObject j = com.google.gson.JsonParser.parseString("""
			{"stages": ["base", "top"], "tiles": {"base": {"terrain": ["0,0", "1,0"], "path": ["0,0"]}, "top": {"terrain": ["0,0"], "path": []}}}
			""").getAsJsonObject();
		return new Ir(j, "x", "0", "1", new int[6], List.of("base", "top"), Map.of("base", List.of("0,0", "1,0"), "top", List.of("0,0")), Map.of("base",
			List.of("0,0"), "top", List.of()), List.of(), List.of(), Map.of(), new long[3], 1, List.of(), List.of());
	}

	@Test
	void theChainIsDefinedOverTheKeysWritersInWriteOrder() throws Exception {
		Ir ir = ir();
		assertEquals(3, Realised.writers(ir, "0,0").size());
		java.util.function.Function<String[], String> shas = w -> (w[0] + w[1]).equals("basepath") ? null : "ab" + w[0] + w[1];
		byte[] mid = Realised.chain(ir, "base", "path", "0,0", shas);
		String want = "base\tterrain\tabbaseterrain\nbase\tpath\t-\n";
		assertArrayEquals(java.security.MessageDigest.getInstance("SHA-256").digest(want.getBytes(StandardCharsets.UTF_8)), mid);
		byte[] last = Realised.chain(ir, "top", "terrain", "0,0", shas);
		String all = want + "top\tterrain\tabtopterrain\n";
		assertArrayEquals(java.security.MessageDigest.getInstance("SHA-256").digest(all.getBytes(StandardCharsets.UTF_8)), last);
		assertEquals(HexFormat.of().formatHex(Realised.chain(ir, "base", "terrain", "1,0", shas)).length(), 64);
	}
}
