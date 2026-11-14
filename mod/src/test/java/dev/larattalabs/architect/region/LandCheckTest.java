package dev.larattalabs.architect.region;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.larattalabs.architect.journal.Journal;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Random;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * (6d LC, docs/CONTRACT.md "Phase 6d slice LC" §4 item 1) The land check's pure parts: the ARTL payload order against a real kit tile, the
 * part attribution of a synthetic record and its writers (WRITTEN cells by order, extras by cause, legacy and inconsistent records
 * unattributed), each class, a gate mechanism's tolerance and its volatile cells.
 */
class LandCheckTest {
	@BeforeAll
	static void boot() {
		Boot.boot();
	}

	private static byte[] res(String name) throws IOException {
		try (InputStream in = LandCheckTest.class.getResourceAsStream("/region/" + name)) {
			return in.readAllBytes();
		}
	}

	@Test
	void theArtlOrderIsTheKitPayloadOrder() throws IOException {
		JsonObject exp = JsonParser.parseString(new String(res("tile.expected.json"))).getAsJsonObject();
		byte[] payload = Packed.payload(List.of(res("tile.artl.gz")), exp.get("sha").getAsString());
		Packed.Tile t = Packed.decode(payload);
		assertTrue(t.size() > 100, "a real tile: " + t.size());
		List<Long> sh = new ArrayList<>();
		for (long p : t.pos()) {
			sh.add(p);
		}
		Collections.shuffle(sh, new Random(7));
		long[] in = sh.stream().mapToLong(Long::longValue).toArray();
		assertArrayEquals(t.pos(), LandCheck.artlSorted(in), "positions sorted by artlCompare are in the payload's order");
	}

	/** ARWR v1 with ops {@code parts} (one op per part) and runs (op index, length) pairs. */
	static byte[] arwr(String[] parts, int cells, int... runs) {
		ByteArrayOutputStream o = new ByteArrayOutputStream();
		o.writeBytes("ARWR".getBytes(StandardCharsets.US_ASCII));
		o.write(1);
		v(o, parts.length);
		for (int i = 0; i < parts.length; i++) {
			byte[] b = parts[i].getBytes(StandardCharsets.UTF_8);
			v(o, b.length);
			o.writeBytes(b);
			v(o, 0);
			v(o, i);
			o.write(0);
		}
		v(o, cells);
		v(o, runs.length / 2);
		for (int r : runs) {
			v(o, r);
		}
		v(o, 0);
		return o.toByteArray();
	}

	private static void v(ByteArrayOutputStream o, long x) {
		while ((x & ~0x7fL) != 0) {
			o.write((int) (x & 0x7f) | 0x80);
			x >>>= 7;
		}
		o.write((int) x);
	}

	private static Realised.Tile rec(byte[] codes, List<Realised.Extra> ex, byte[] w) {
		return new Realised.Tile(0, "ground", "terrain", "0,0", "c1", 0, new byte[32], new byte[32], codes, ex, w);
	}

	// five payload cells in ARTL order: two in chunk (0,0) section 4, one in chunk (0,0) section 5, one in chunk (0,1), one in chunk (1,0)
	static final long P0 = BlockPos.asLong(3, 70, 2), P1 = BlockPos.asLong(5, 70, 2), P2 = BlockPos.asLong(1, 80, 1), P3 = BlockPos.asLong(0, 64, 17),
		P4 = BlockPos.asLong(16, 64, 0), TREE = BlockPos.asLong(3, 71, 2), LEAF = BlockPos.asLong(3, 72, 3);

	@Test
	void writtenCellsTakeTheirWinnersPartAndExtrasTheirCauses() {
		long[] order = {P0, P1, P2, P3, P4};
		assertArrayEquals(order, LandCheck.artlSorted(new long[] {P4, P2, P0, P3, P1}));
		byte[] codes = {Realised.WRITTEN, Realised.NOOP, Realised.WRITTEN, Realised.HELD, Realised.WRITTEN};
		byte[] w = arwr(new String[] {"square", "lanes"}, 5, 0, 2, 1, 3);
		List<Realised.Extra> ex = List.of(new Realised.Extra(Realised.TREE, TREE, 2), new Realised.Extra(Realised.LEAF, LEAF, 0));
		LongOpenHashSet entry = new LongOpenHashSet(new long[] {P4, TREE, P0, P2});
		Map<Long, String> m = LandCheck.partMap(rec(codes, ex, w), entry);
		assertEquals(Map.of(P0, "square", P2, "lanes", P4, "lanes", TREE, "lanes", LEAF, "square"), m);
	}

	@Test
	void anUnknownCauseAndUnreadableRecordsAreUnattributed() {
		byte[] codes = {Realised.WRITTEN, Realised.WRITTEN};
		byte[] w = arwr(new String[] {"pads"}, 2, 0, 2);
		Map<Long, String> m = LandCheck.partMap(rec(codes, List.of(new Realised.Extra(Realised.DEPENDENT, TREE, -1)), w), new LongOpenHashSet(new long[] {P0, P1,
			TREE}));
		assertEquals("pads", m.get(P0));
		assertEquals(LandCheck.UNATTRIBUTED, m.get(TREE));
		// a record realised before the writers (none): unattributed
		assertNull(LandCheck.partMap(rec(codes, List.of(), new byte[0]), new LongOpenHashSet(new long[] {P0, P1})));
		// the entry holds another count of cells than the record WROTE (a survival tile's targets): unattributed, never guessed
		assertNull(LandCheck.partMap(rec(codes, List.of(), w), new LongOpenHashSet(new long[] {P0, P1, P2})));
		// writers over another cell count
		assertNull(LandCheck.partMap(rec(codes, List.of(), arwr(new String[] {"pads"}, 3, 0, 3)), new LongOpenHashSet(new long[] {P0, P1})));
		assertNull(LandCheck.winners("ARWR\u0001junk".getBytes(StandardCharsets.UTF_8), 2));
	}

	private static Journal.Value val(BlockState s) {
		return new Journal.Value(NbtUtils.writeBlockState(s), null);
	}

	private static LandCheck.Cls cls(BlockState now, boolean pt, BlockState after, boolean mech) {
		return LandCheck.classify(now, () -> null, pt, val(after), mech);
	}

	@Test
	void eachChangedCellInExactlyOneClass() {
		BlockState stone = Blocks.STONE_BRICKS.defaultBlockState();
		assertEquals(LandCheck.Cls.SAME, cls(stone, false, stone, false));
		assertEquals(LandCheck.Cls.SAME, cls(stone, true, stone, false), "a player's same block holds (the undo's rule)");
		assertEquals(LandCheck.Cls.REMOVED, cls(Blocks.AIR.defaultBlockState(), false, stone, false));
		assertEquals(LandCheck.Cls.REMOVED, cls(Blocks.WATER.defaultBlockState(), false, stone, false), "a fluid where a block was written");
		assertEquals(LandCheck.Cls.PLAYER, cls(Blocks.COBBLESTONE.defaultBlockState(), true, Blocks.GRAVEL.defaultBlockState(), false));
		assertEquals(LandCheck.Cls.CHANGED, cls(Blocks.COBBLESTONE.defaultBlockState(), false, Blocks.GRAVEL.defaultBlockState(), false));
		assertEquals(LandCheck.Cls.VOLATILE, cls(Blocks.AIR.defaultBlockState(), false, Blocks.OAK_LEAVES.defaultBlockState(), false), "leaves gone");
		assertEquals(LandCheck.Cls.VOLATILE, cls(Blocks.SNOW.defaultBlockState(), false, Blocks.AIR.defaultBlockState(), false), "snow fell");
		assertEquals(LandCheck.Cls.VOLATILE, cls(Blocks.SHORT_GRASS.defaultBlockState(), false, Blocks.AIR.defaultBlockState(), false), "a plant grew");
		assertEquals(LandCheck.Cls.SAME, cls(Blocks.WATER.defaultBlockState(), false, Blocks.AIR.defaultBlockState(), false), "a fluid in cleared air");
		assertEquals(LandCheck.Cls.SAME, cls(Blocks.DIRT.defaultBlockState(), false, Blocks.GRASS_BLOCK.defaultBlockState(), false), "spread");
	}

	@Test
	void aGateMechanismsDynamicStateIsNotAChange() {
		BlockState piston = Blocks.STICKY_PISTON.defaultBlockState();
		BlockState extended = piston.setValue(BlockStateProperties.EXTENDED, true);
		assertEquals(LandCheck.Cls.SAME, cls(extended, false, piston, true));
		assertEquals(LandCheck.Cls.SAME, cls(Blocks.MOVING_PISTON.defaultBlockState(), false, piston, true), "mid-move");
		assertEquals(LandCheck.Cls.CHANGED, cls(Blocks.MOVING_PISTON.defaultBlockState(), false, piston, false), "only in a mechanism");
		BlockState rep = Blocks.REPEATER.defaultBlockState();
		assertEquals(LandCheck.Cls.SAME, cls(rep.setValue(BlockStateProperties.LOCKED, true), false, rep, true), "locked");
		BlockState cmp = Blocks.COMPARATOR.defaultBlockState();
		assertEquals(LandCheck.Cls.SAME, cls(cmp.setValue(BlockStateProperties.POWERED, true), false, cmp, true));
		assertEquals(LandCheck.Cls.SAME, cls(Blocks.AIR.defaultBlockState(), false, Blocks.PISTON_HEAD.defaultBlockState(), true), "a head retracted");
		assertEquals(LandCheck.Cls.REMOVED, cls(Blocks.AIR.defaultBlockState(), false, piston, true), "a piston mined is removed");
		assertEquals(LandCheck.Cls.CHANGED, cls(Blocks.STONE.defaultBlockState(), false, rep, true));
		// (LCi) a moving or trigger cell: its state never judged (a leaf gone from the lane, a lever pulled), a player's block there the player's
		BlockState air = Blocks.AIR.defaultBlockState();
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(Blocks.IRON_BARS.defaultBlockState(), () -> null, false, val(air), true, true), "a leaf in the lane");
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(air, () -> null, false, val(Blocks.IRON_BARS.defaultBlockState()), true, true), "a lane opened");
		assertEquals(LandCheck.Cls.PLAYER, LandCheck.classifyCell(Blocks.COBBLESTONE.defaultBlockState(), () -> null, true, val(air), true, true),
			"a player's block in an open lane is the player's");
		BlockState lever = Blocks.LEVER.defaultBlockState();
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(lever.setValue(BlockStateProperties.POWERED, true), () -> null, true, val(lever), true, true),
			"a player's lever as written, only powered: the same");
		assertEquals(LandCheck.Cls.REMOVED, LandCheck.classifyCell(air, () -> null, false, val(piston), true, false), "outside them as classify");
		JsonObject ir = JsonParser.parseString("{\"lots\":[{\"onWall\":{\"passage\":{\"mechanism\":{\"states\":{\"open\":[10,20,64,66],\"closed\":[11,20,64,64]},"
			+ "\"triggers\":[{\"at\":[12,65,21],\"rungs\":[[12,70,21]]}]}}}}]}").getAsJsonObject();
		LongOpenHashSet v = LandCheck.mechVolatile(ir);
		assertEquals(6, v.size(), "three open cells, one closed, a trigger and its rung");
		assertTrue(v.contains(BlockPos.asLong(10, 65, 20)) && v.contains(BlockPos.asLong(11, 64, 20)) && v.contains(BlockPos.asLong(12, 70, 21)));
		// (SA, A47) the trigger cells alone: its `at`, not its rung
		LongOpenHashSet t = LandCheck.mechTriggers(ir);
		assertEquals(1, t.size(), "one trigger");
		assertTrue(t.contains(BlockPos.asLong(12, 65, 21)) && !t.contains(BlockPos.asLong(12, 70, 21)));
	}

	/** (SA, A47) A missing trigger block reads removed; a pulled or pressed one stays the same; a player's lever there stays the player's. */
	@Test
	void aMissingTriggerIsRemoved() {
		BlockState air = Blocks.AIR.defaultBlockState();
		BlockState lever = Blocks.LEVER.defaultBlockState();
		BlockState button = Blocks.STONE_BUTTON.defaultBlockState();
		assertEquals(LandCheck.Cls.REMOVED, LandCheck.classifyCell(air, () -> null, false, val(lever), true, true, true), "the lever broken");
		assertEquals(LandCheck.Cls.REMOVED, LandCheck.classifyCell(air, () -> null, false, val(button), true, true, true), "the button broken");
		assertEquals(LandCheck.Cls.REMOVED, LandCheck.classifyCell(Blocks.WATER.defaultBlockState(), () -> null, false, val(lever), true, true, true),
			"water where the lever was");
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(lever.setValue(BlockStateProperties.POWERED, true), () -> null, false, val(lever), true,
			true, true), "the lever pulled");
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(button.setValue(BlockStateProperties.POWERED, true), () -> null, false, val(button), true,
			true, true), "the button pressed");
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(air, () -> null, false, val(air), true, true, true), "a trigger cell written as air");
		assertEquals(LandCheck.Cls.PLAYER, LandCheck.classifyCell(Blocks.COBBLESTONE.defaultBlockState(), () -> null, true, val(lever), true, true, true),
			"a player's block over the trigger is the player's");
		// the old overload (no trigger flag) is unchanged: a lane cell
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(air, () -> null, false, val(lever), true, true), "a moving cell, not a trigger");
	}

	/** (SA, A48) LCi's gaps: every cell of a several-cell lane, and a piston pushing a player's block along it. */
	@Test
	void aLaneOfSeveralCellsAndAPushedPlayerBlock() {
		BlockState air = Blocks.AIR.defaultBlockState();
		BlockState bars = Blocks.IRON_BARS.defaultBlockState();
		JsonObject ir = JsonParser.parseString("{\"lots\":[{\"onWall\":{\"passage\":{\"mechanism\":{\"states\":{\"open\":[10,20,64,67],\"closed\":[10,21,64,67]},"
			+ "\"triggers\":[{\"at\":[12,65,21]}]}}}}]}").getAsJsonObject();
		LongOpenHashSet v = LandCheck.mechVolatile(ir);
		LongOpenHashSet t = LandCheck.mechTriggers(ir);
		for (int y = 64; y <= 67; y++) {
			long p = BlockPos.asLong(10, y, 20);
			assertTrue(v.contains(p) && !t.contains(p), "lane cell y " + y);
			// written closed (bars) and now open (air), or written open and now closed: never judged
			assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(air, () -> null, false, val(bars), true, true, false), "opened at y " + y);
			assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(bars, () -> null, false, val(air), true, true, false), "closed at y " + y);
		}
		// a piston pushes a player's cobblestone one cell along the lane: the cell it left keeps the player's record over air (the player's
		// block gone from it: not the land's change), the cell it entered has no record and is a moving cell (not judged)
		BlockState cob = Blocks.COBBLESTONE.defaultBlockState();
		LandCheck.Cls left = LandCheck.classifyCell(air, () -> null, true, val(air), true, true, false);
		assertTrue(left == LandCheck.Cls.SAME || left == LandCheck.Cls.PLAYER, "the cell it left: never removed or changed (" + left + ")");
		assertEquals(LandCheck.Cls.SAME, LandCheck.classifyCell(cob, () -> null, false, val(air), true, true, false), "the cell it entered");
	}
}
